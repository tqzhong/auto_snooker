// ============================================================
// Trainer — Orchestrates training sessions
// ============================================================

import type { Agent } from '../ai/agents/agent';
import { runHeadlessFrame } from '../engine/game-loop';
import { GameRecorder } from './recorder';
import { calculateAgentStats, formatStats } from './evaluator';
import type { TrainingConfig, TrainingResults, FrameRecord, AgentStats } from './types';

export function createTrainer(config: TrainingConfig): Trainer {
  return new Trainer(config);
}

export class Trainer {
  private config: TrainingConfig;
  private recorder: GameRecorder;

  constructor(config: TrainingConfig) {
    this.config = config;
    this.recorder = new GameRecorder();
  }

  async run(): Promise<TrainingResults> {
    const allFrames: FrameRecord[] = [];
    let completed = 0;
    const total = this.config.agentPairs.length * this.config.framesPerPair;

    for (let pairIdx = 0; pairIdx < this.config.agentPairs.length; pairIdx++) {
      const [agent1, agent2] = this.config.agentPairs[pairIdx];

      for (let frameIdx = 0; frameIdx < this.config.framesPerPair; frameIdx++) {
        // Alternate who breaks
        const [p1, p2] = frameIdx % 2 === 0 ? [agent1, agent2] : [agent2, agent1];

        const result = await runHeadlessFrame({ player1: p1, player2: p2 });

        // Normalize winner back to agent1/agent2 indices
        const normalizedWinner = frameIdx % 2 === 0
          ? result.winner
          : result.winner === 0 ? 1 : result.winner === 1 ? 0 : -1;

        const frameRecord: FrameRecord = {
          winner: normalizedWinner,
          scores: frameIdx % 2 === 0 ? result.scores : [result.scores[1], result.scores[0]],
          shots: result.shotRecords,
          highestBreak: frameIdx % 2 === 0 ? result.highestBreak : [result.highestBreak[1], result.highestBreak[0]],
          fouls: frameIdx % 2 === 0 ? result.fouls : [result.fouls[1], result.fouls[0]],
          duration: result.duration,
        };

        allFrames.push(frameRecord);
        this.config.onFrameComplete?.(frameRecord, pairIdx, frameIdx);

        completed++;
        this.config.onProgress?.(completed, total);
      }
    }

    return this.compileResults(allFrames);
  }

  private compileResults(frames: FrameRecord[]): TrainingResults {
    // Collect all unique agent names
    const agentNames = new Set<string>();
    for (const [a1, a2] of this.config.agentPairs) {
      agentNames.add(a1.name);
      agentNames.add(a2.name);
    }

    // Calculate stats per agent
    const statsMap = new Map<string, AgentStats>();
    for (const name of agentNames) {
      // Find all frames where this agent played (as player 0 or 1)
      const relevantFrames = frames.filter((f, i) => {
        const pairIdx = Math.floor(i / this.config.framesPerPair);
        const frameIdx = i % this.config.framesPerPair;
        const [a1, a2] = this.config.agentPairs[pairIdx];
        // Determine which player index this agent was
        if (frameIdx % 2 === 0) {
          return a1.name === name || a2.name === name;
        }
        return a1.name === name || a2.name === name;
      });

      // Simplification: collect all frames for each agent
      const agentFrames: FrameRecord[] = [];
      let playerIdx = 0;
      let i = 0;
      for (const [a1, a2] of this.config.agentPairs) {
        for (let f = 0; f < this.config.framesPerPair; f++) {
          const frame = frames[i];
          if (!frame) break;
          const isP1 = f % 2 === 0;
          if (isP1 && a1.name === name) {
            agentFrames.push({ ...frame, winner: frame.winner === 0 ? 0 : frame.winner === 1 ? 1 : -1 });
          } else if (!isP1 && a2.name === name) {
            agentFrames.push({ ...frame, winner: frame.winner === 0 ? 0 : frame.winner === 1 ? 1 : -1 });
          } else if (isP1 && a2.name === name) {
            agentFrames.push({
              ...frame, winner: frame.winner === 0 ? 1 : frame.winner === 1 ? 0 : -1,
              scores: [frame.scores[1], frame.scores[0]] as [number, number],
              highestBreak: [frame.highestBreak[1], frame.highestBreak[0]] as [number, number],
              fouls: [frame.fouls[1], frame.fouls[0]] as [number, number],
            });
          } else if (!isP1 && a1.name === name) {
            agentFrames.push({
              ...frame, winner: frame.winner === 0 ? 1 : frame.winner === 1 ? 0 : -1,
              scores: [frame.scores[1], frame.scores[0]] as [number, number],
              highestBreak: [frame.highestBreak[1], frame.highestBreak[0]] as [number, number],
              fouls: [frame.fouls[1], frame.fouls[0]] as [number, number],
            });
          }
          i++;
        }
      }

      statsMap.set(name, calculateAgentStats(name, agentFrames, 0));
    }

    // Find best/worst
    let bestAgent = '';
    let worstAgent = '';
    let bestWinRate = -1;
    let worstWinRate = 2;

    for (const [name, stats] of statsMap) {
      if (stats.winRate > bestWinRate) {
        bestWinRate = stats.winRate;
        bestAgent = name;
      }
      if (stats.winRate < worstWinRate) {
        worstWinRate = stats.winRate;
        worstAgent = name;
      }
    }

    return {
      agentStats: statsMap,
      frameRecords: frames,
      summary: {
        bestAgent,
        worstAgent,
        totalFrames: frames.length,
        totalDuration: frames.reduce((s, f) => s + f.duration, 0),
      },
    };
  }
}

/** Print training results */
export function formatTrainingResults(results: TrainingResults): string {
  const lines: string[] = [
    '═══════════════════════════════════════',
    '  Training Results',
    '═══════════════════════════════════════',
    `  Total Frames: ${results.summary.totalFrames}`,
    `  Total Duration: ${(results.summary.totalDuration / 1000).toFixed(1)}s`,
    `  Best Agent: ${results.summary.bestAgent}`,
    `  Worst Agent: ${results.summary.worstAgent}`,
    '',
    formatStats([...results.agentStats.values()]),
    '═══════════════════════════════════════',
  ];
  return lines.join('\n');
}

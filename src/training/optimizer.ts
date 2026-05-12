// ============================================================
// Parameter Optimizer — Genetic/Hill-climbing optimization
// ============================================================

import type { Agent } from '../ai/agents/agent';
import { NeuralAgent, DEFAULT_NEURAL_PARAMS } from '../ai/agents/neural-agent';
import type { NeuralParams } from '../ai/agents/neural-agent';
import { runHeadlessFrame } from '../engine/game-loop';
import type { AgentStats } from './types';
import { calculateAgentStats } from './evaluator';
import type { FrameRecord } from './types';

interface OptimizationConfig {
  /** Agent to optimize */
  agentName: string;
  /** Opponent agent to test against */
  opponent: Agent;
  /** Number of generations */
  generations: number;
  /** Number of candidates per generation */
  populationSize: number;
  /** Frames per evaluation */
  framesPerEval: number;
  /** Mutation rate (0-1) */
  mutationRate: number;
  /** How much to mutate each parameter */
  mutationStrength: number;
  /** Callback for progress */
  onProgress?: (generation: number, bestWinRate: number, bestParams: NeuralParams) => void;
}

interface OptimizationResult {
  bestParams: NeuralParams;
  bestWinRate: number;
  history: { generation: number; bestWinRate: number; avgWinRate: number }[];
}

/** Default optimization config */
const DEFAULT_CONFIG: Omit<OptimizationConfig, 'agentName' | 'opponent'> = {
  generations: 10,
  populationSize: 6,
  framesPerEval: 20,
  mutationRate: 0.3,
  mutationStrength: 0.15,
};

/**
 * Optimize NeuralAgent parameters using hill-climbing with mutation.
 * Each generation:
 * 1. Create N mutated copies of the best params
 * 2. Evaluate each against the opponent
 * 3. Keep the best-performing params
 * 4. Repeat
 */
export async function optimizeAgentParams(
  config: Partial<OptimizationConfig> & { agentName: string; opponent: Agent },
): Promise<OptimizationResult> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const history: { generation: number; bestWinRate: number; avgWinRate: number }[] = [];

  let bestParams: NeuralParams = { ...DEFAULT_NEURAL_PARAMS };
  let bestWinRate = 0;

  // Evaluate initial params
  const initialAgent = new NeuralAgent(fullConfig.agentName, bestParams);
  const initialStats = await evaluateAgent(initialAgent, fullConfig.opponent, fullConfig.framesPerEval);
  bestWinRate = initialStats.winRate;

  for (let gen = 0; gen < fullConfig.generations; gen++) {
    const candidates: { params: NeuralParams; winRate: number }[] = [];

    // Generate mutated candidates
    for (let i = 0; i < fullConfig.populationSize; i++) {
      const mutated = mutateParams(bestParams, fullConfig.mutationRate, fullConfig.mutationStrength);
      const agent = new NeuralAgent(`${fullConfig.agentName}-gen${gen}-c${i}`, mutated);
      const stats = await evaluateAgent(agent, fullConfig.opponent, fullConfig.framesPerEval);
      candidates.push({ params: mutated, winRate: stats.winRate });
    }

    // Find best candidate
    candidates.sort((a, b) => b.winRate - a.winRate);
    const genBest = candidates[0];
    const genAvg = candidates.reduce((s, c) => s + c.winRate, 0) / candidates.length;

    if (genBest.winRate > bestWinRate) {
      bestWinRate = genBest.winRate;
      bestParams = { ...genBest.params };
    }

    history.push({
      generation: gen,
      bestWinRate,
      avgWinRate: genAvg,
    });

    fullConfig.onProgress?.(gen, bestWinRate, bestParams);
  }

  return { bestParams, bestWinRate, history };
}

/** Mutate parameters randomly */
function mutateParams(params: NeuralParams, rate: number, strength: number): NeuralParams {
  const mutated = { ...params };
  const keys = Object.keys(mutated) as (keyof NeuralParams)[];

  for (const key of keys) {
    if (Math.random() < rate) {
      const current = mutated[key];
      const delta = (Math.random() * 2 - 1) * strength;
      mutated[key] = Math.max(0, Math.min(1, current + delta)) as any;
    }
  }

  return mutated;
}

/** Evaluate an agent by playing frames against an opponent */
async function evaluateAgent(
  agent: Agent,
  opponent: Agent,
  frames: number,
): Promise<AgentStats> {
  const frameRecords: FrameRecord[] = [];

  for (let i = 0; i < frames; i++) {
    const [p1, p2] = i % 2 === 0 ? [agent, opponent] : [opponent, agent];
    const result = await runHeadlessFrame({ player1: p1, player2: p2 });

    const normalizedWinner = i % 2 === 0
      ? result.winner
      : result.winner === 0 ? 1 : result.winner === 1 ? 0 : -1;

    frameRecords.push({
      winner: normalizedWinner,
      scores: i % 2 === 0 ? result.scores : [result.scores[1], result.scores[0]] as [number, number],
      shots: result.shotRecords,
      highestBreak: i % 2 === 0 ? result.highestBreak : [result.highestBreak[1], result.highestBreak[0]] as [number, number],
      fouls: i % 2 === 0 ? result.fouls : [result.fouls[1], result.fouls[0]] as [number, number],
      duration: result.duration,
    });
  }

  return calculateAgentStats(agent.name, frameRecords, 0);
}

/** Format optimization results for display */
export function formatOptimizationResults(result: OptimizationResult): string {
  const lines: string[] = [
    '═══════════════════════════════════════',
    '  Parameter Optimization Results',
    '═══════════════════════════════════════',
    `  Best Win Rate: ${(result.bestWinRate * 100).toFixed(1)}%`,
    '',
    '  Optimized Parameters:',
  ];

  for (const [key, value] of Object.entries(result.bestParams)) {
    lines.push(`    ${key}: ${(value as number).toFixed(3)}`);
  }

  lines.push('');
  lines.push('  Optimization History:');
  for (const entry of result.history) {
    lines.push(`    Gen ${entry.generation}: best=${(entry.bestWinRate * 100).toFixed(1)}% avg=${(entry.avgWinRate * 100).toFixed(1)}%`);
  }

  lines.push('═══════════════════════════════════════');
  return lines.join('\n');
}

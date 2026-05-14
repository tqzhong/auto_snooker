// ============================================================
// Master Agent Optimizer
// Tunes heuristic weights toward safer high-break snooker.
// ============================================================

import { MasterSnookerAgent, type MasterAgentParams } from '../ai/agents/master-agent';
import { runHeadlessFrame } from '../engine/game-loop';
import { calculateAgentStats } from './evaluator';
import type { AgentStats, FrameRecord } from './types';

export interface MasterOptimizationConfig {
  generations: number;
  populationSize: number;
  framesPerEval: number;
  maxShotsPerFrame: number;
  mutationStrength: number;
  onProgress?: (generation: number, bestFitness: number, bestParams: MasterAgentParams) => void;
}

export interface MasterOptimizationResult {
  bestParams: MasterAgentParams;
  bestFitness: number;
  bestStats: AgentStats;
  history: { generation: number; bestFitness: number; avgFitness: number; highestBreak: number; centuries: number }[];
}

const DEFAULT_PARAMS: MasterAgentParams = {
  creativity: 0.18,
  llmInfluence: 0,
  difficultyPenalty: 7.2,
  highDifficultyPenalty: 220,
  cueTravelPenalty: 1,
  positionReward: 1,
  safetyReward: 1,
  valueReward: 1,
  blackPinkBias: 1.25,
  spinUseReward: 1.1,
};

const PARAM_LIMITS: Record<keyof MasterAgentParams, [number, number]> = {
  creativity: [0, 0.45],
  llmInfluence: [0, 1],
  difficultyPenalty: [3, 14],
  highDifficultyPenalty: [80, 420],
  cueTravelPenalty: [0.5, 1.8],
  positionReward: [0.6, 1.7],
  safetyReward: [0.6, 1.6],
  valueReward: [0.7, 1.5],
  blackPinkBias: [0.8, 2],
  spinUseReward: [0.4, 1.8],
};

function clampParam(key: keyof MasterAgentParams, value: number): number {
  const [min, max] = PARAM_LIMITS[key];
  return Math.max(min, Math.min(max, value));
}

function mutateParams(params: MasterAgentParams, strength: number): MasterAgentParams {
  const next = { ...params };
  for (const key of Object.keys(next) as (keyof MasterAgentParams)[]) {
    if (key === 'llmInfluence') continue;
    const limits = PARAM_LIMITS[key];
    const span = limits[1] - limits[0];
    const delta = (Math.random() * 2 - 1) * span * strength;
    const current = typeof next[key] === 'number' ? next[key] : DEFAULT_PARAMS[key] as number;
    next[key] = clampParam(key, current + delta);
  }
  return next;
}

function normalizeFrameForAgent(frame: FrameRecord, agentWasPlayer0: boolean): FrameRecord {
  if (agentWasPlayer0) return frame;
  return {
    winner: frame.winner === 0 ? 1 : frame.winner === 1 ? 0 : -1,
    scores: [frame.scores[1], frame.scores[0]],
    highestBreak: [frame.highestBreak[1], frame.highestBreak[0]],
    fouls: [frame.fouls[1], frame.fouls[0]],
    shots: frame.shots.map(s => ({ ...s, playerIndex: 1 - s.playerIndex })),
    duration: frame.duration,
  };
}

async function evaluateParams(
  params: MasterAgentParams,
  frames: number,
  maxShotsPerFrame: number,
): Promise<AgentStats> {
  const records: FrameRecord[] = [];

  for (let i = 0; i < frames; i++) {
    const candidate = new MasterSnookerAgent('Master-Candidate', params);
    const baseline = new MasterSnookerAgent('Master-Baseline', DEFAULT_PARAMS);
    const candidateBreaks = i % 2 === 0;
    const result = await runHeadlessFrame({
      player1: candidateBreaks ? candidate : baseline,
      player2: candidateBreaks ? baseline : candidate,
      maxShots: maxShotsPerFrame,
    });
    records.push(normalizeFrameForAgent({
      winner: result.winner,
      scores: result.scores,
      shots: result.shotRecords,
      highestBreak: result.highestBreak,
      fouls: result.fouls,
      duration: result.duration,
    }, candidateBreaks));
  }

  return calculateAgentStats('Master-Candidate', records, 0);
}

function fitness(stats: AgentStats): number {
  return stats.winRate * 90 +
    stats.avgBreak * 1.2 +
    stats.highestBreak * 0.75 +
    stats.centuryBreaks * 55 +
    stats.potSuccessRate * 35 -
    stats.foulRate * 120 -
    stats.avgFrameLength * 0.015;
}

export async function optimizeMasterParams(
  config: Partial<MasterOptimizationConfig> = {},
): Promise<MasterOptimizationResult> {
  const full = {
    generations: 5,
    populationSize: 4,
    framesPerEval: 4,
    maxShotsPerFrame: 420,
    mutationStrength: 0.12,
    ...config,
  };

  let bestParams = { ...DEFAULT_PARAMS };
  let bestStats = await evaluateParams(bestParams, full.framesPerEval, full.maxShotsPerFrame);
  let bestFitness = fitness(bestStats);
  const history: MasterOptimizationResult['history'] = [];

  for (let generation = 0; generation < full.generations; generation++) {
    const candidates: { params: MasterAgentParams; stats: AgentStats; fitness: number }[] = [];

    for (let i = 0; i < full.populationSize; i++) {
      const params = mutateParams(bestParams, full.mutationStrength);
      const stats = await evaluateParams(params, full.framesPerEval, full.maxShotsPerFrame);
      candidates.push({ params, stats, fitness: fitness(stats) });
    }

    candidates.sort((a, b) => b.fitness - a.fitness);
    const generationBest = candidates[0];
    const avgFitness = candidates.reduce((sum, c) => sum + c.fitness, 0) / candidates.length;

    if (generationBest.fitness > bestFitness) {
      bestFitness = generationBest.fitness;
      bestParams = generationBest.params;
      bestStats = generationBest.stats;
    }

    history.push({
      generation,
      bestFitness,
      avgFitness,
      highestBreak: bestStats.highestBreak,
      centuries: bestStats.centuryBreaks,
    });
    full.onProgress?.(generation, bestFitness, bestParams);
  }

  return { bestParams, bestFitness, bestStats, history };
}

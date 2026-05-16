// ============================================================
// Master Agent Optimizer
// Tunes heuristic weights toward safer high-break snooker.
// ============================================================

import { MasterSnookerAgent, type MasterAgentParams } from '../ai/agents/master-agent';
import type { AgentDecision } from '../ai/agents/agent';
import { runHeadlessFrame } from '../engine/game-loop';
import { applyShot, simulateShot } from '../engine/physics';
import { applyShotResult, createInitialGameState, evaluateShot } from '../engine/rules';
import {
  BALL_RADIUS, BLACK_SPOT, BLUE_SPOT, BROWN_SPOT, CENTER_Y,
  GREEN_SPOT, PINK_SPOT, POCKET_POSITIONS, TABLE_WIDTH, YELLOW_SPOT,
} from '../engine/constants';
import type { Ball, BallColor, GameState, ShotParams, ShotRecord, Vec2 } from '../types';
import { calculateAgentStats } from './evaluator';
import { calculateBreakBuildingStats, type BreakBuildingStats } from './break-metrics';
import type { AgentStats, FrameRecord } from './types';

export interface MasterOptimizationConfig {
  generations: number;
  populationSize: number;
  framesPerEval: number;
  maxShotsPerFrame: number;
  curriculumVisits: number;
  maxCurriculumShots: number;
  mutationStrength: number;
  initialParams: Partial<MasterAgentParams>;
  onProgress?: (generation: number, bestFitness: number, bestParams: MasterAgentParams) => void;
}

export interface MasterOptimizationResult {
  bestParams: MasterAgentParams;
  bestFitness: number;
  bestStats: AgentStats;
  bestBreakStats: BreakBuildingStats;
  history: {
    generation: number;
    bestFitness: number;
    avgFitness: number;
    highestBreak: number;
    centuries: number;
    redBlackPairs: number;
    blackAfterRedRate: number;
  }[];
}

const DEFAULT_PARAMS: MasterAgentParams = {
  creativity: 0.18,
  llmInfluence: 0,
  searchDepth: 2,
  beamWidth: 3,
  branchWidth: 3,
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
  searchDepth: [2, 5],
  beamWidth: [2, 6],
  branchWidth: [2, 6],
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
    const mutated = clampParam(key, current + delta);
    next[key] = key === 'searchDepth' || key === 'beamWidth' || key === 'branchWidth'
      ? Math.round(mutated)
      : mutated;
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

function makeBall(id: number, color: BallColor, pos: Vec2): Ball {
  return {
    id,
    color,
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    radius: BALL_RADIUS,
    pocketed: false,
    active: true,
  };
}

function cueForPot(red: Vec2, pocket: Vec2, distance = 560): Vec2 {
  const dx = pocket.x - red.x;
  const dy = pocket.y - red.y;
  const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const nx = dx / len;
  const ny = dy / len;
  const ghost = {
    x: red.x - nx * BALL_RADIUS * 2,
    y: red.y - ny * BALL_RADIUS * 2,
  };
  return {
    x: ghost.x - nx * distance,
    y: ghost.y - ny * distance,
  };
}

function colorBalls(startId: number): Ball[] {
  const spots: [BallColor, [number, number]][] = [
    ['yellow', YELLOW_SPOT],
    ['green', GREEN_SPOT],
    ['brown', BROWN_SPOT],
    ['blue', BLUE_SPOT],
    ['pink', PINK_SPOT],
    ['black', BLACK_SPOT],
  ];
  return spots.map(([color, [x, y]], index) => makeBall(startId + index, color, { x, y }));
}

function makeBreakScenario(index: number): GameState {
  const pocket = POCKET_POSITIONS[index % POCKET_POSITIONS.length];
  const redAnchors: Vec2[] = [
    { x: 130, y: 140 },
    { x: 130, y: TABLE_WIDTH - 140 },
    { x: 650, y: CENTER_Y - 155 },
    { x: 675, y: CENTER_Y + 155 },
  ];
  const primaryRed = redAnchors[index % redAnchors.length];
  const cue = cueForPot(primaryRed, { x: pocket[0], y: pocket[1] }, 540 + (index % 3) * 80);
  const reds = [
    makeBall(1, 'red', primaryRed),
    makeBall(2, 'red', { x: 610, y: CENTER_Y - 70 }),
    makeBall(3, 'red', { x: 690, y: CENTER_Y + 70 }),
    makeBall(4, 'red', { x: 760, y: CENTER_Y - 180 }),
    makeBall(5, 'red', { x: 820, y: CENTER_Y + 190 }),
  ];
  const balls = [
    makeBall(0, 'white', cue),
    ...reds,
    ...colorBalls(20),
  ];

  return {
    ...createInitialGameState(['Master-Candidate', 'Practice-Opponent'], balls),
    cueBallInHand: false,
    phase: 'reds_phase',
    redsRemaining: reds.length,
  };
}

async function runCurriculumVisit(
  agent: MasterSnookerAgent,
  scenarioIndex: number,
  maxShots: number,
): Promise<FrameRecord> {
  let state = makeBreakScenario(scenarioIndex);
  const shots: ShotRecord[] = [];
  let shotCount = 0;
  const started = Date.now();

  while (state.currentPlayerIndex === 0 && state.phase !== 'game_over' && shotCount < maxShots) {
    const beforeBalls = state.balls.map(b => ({ id: b.id, pos: { ...b.pos } }));
    const decision: AgentDecision = await agent.decide(state);
    const ballsCopy = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
    applyShot(ballsCopy, decision.aimAngle, decision.power, decision.spinX, decision.spinY);
    const simResult = simulateShot(ballsCopy, { generateFrames: false });
    const shotParams: ShotParams = {
      angle: decision.aimAngle,
      power: decision.power,
      spinX: decision.spinX,
      spinY: decision.spinY,
      targetBallId: decision.targetBallId,
    };
    const shotResult = evaluateShot(state, shotParams, simResult);
    shots.push({
      playerIndex: 0,
      shotParams,
      result: shotResult,
      ballPositionsBefore: beforeBalls,
      timestamp: Date.now(),
      llmReasoning: decision.reasoning,
    });
    state = applyShotResult(state, shotParams, simResult, shotResult, decision.reasoning);
    shotCount++;
  }

  return {
    winner: -1,
    scores: [state.players[0].score, state.players[1].score],
    shots,
    highestBreak: [state.players[0].highestBreak, state.players[1].highestBreak],
    fouls: [
      shots.filter(shot => shot.result.fouls.length > 0).length,
      0,
    ],
    duration: Date.now() - started,
  };
}

async function evaluateParams(
  params: MasterAgentParams,
  frames: number,
  maxShotsPerFrame: number,
  curriculumVisits: number,
  maxCurriculumShots: number,
): Promise<{ stats: AgentStats; breakStats: BreakBuildingStats }> {
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

  for (let i = 0; i < curriculumVisits; i++) {
    const candidate = new MasterSnookerAgent('Master-Candidate', params);
    records.push(await runCurriculumVisit(candidate, i, maxCurriculumShots));
  }

  return {
    stats: calculateAgentStats('Master-Candidate', records, 0),
    breakStats: calculateBreakBuildingStats(records, 0),
  };
}

function fitness(stats: AgentStats, breakStats: BreakBuildingStats): number {
  const fiftyBreakProxy = Math.max(0, stats.highestBreak - 49) * 1.4;
  const centuryPressure = stats.centuryBreaks * 95 + Math.max(0, stats.highestBreak - 99) * 2.1;
  const maximumPressure = Math.max(0, stats.highestBreak - 119) * 3.6 +
    (stats.highestBreak >= 147 ? 500 : 0);
  const redBlackReward = breakStats.redBlackPairs * 28 +
    breakStats.blackAfterRedRate * 95 +
    breakStats.premiumColorAfterRedRate * 45;
  const visitQuality = breakStats.avgBreakVisitPoints * 2.8 +
    breakStats.maxBreakVisitShots * 7 +
    breakStats.fiftyBreaks * 65 +
    breakStats.centuryBreaks * 150 +
    breakStats.maxBreakProximity * 120;

  return stats.avgBreak * 3.4 +
    stats.highestBreak * 2.2 +
    visitQuality +
    redBlackReward +
    fiftyBreakProxy +
    centuryPressure +
    maximumPressure +
    stats.potSuccessRate * 70 +
    stats.winRate * 18 -
    stats.foulRate * 180 -
    stats.avgFrameLength * 0.01;
}

export async function optimizeMasterParams(
  config: Partial<MasterOptimizationConfig> = {},
): Promise<MasterOptimizationResult> {
  const full = {
    generations: 5,
    populationSize: 4,
    framesPerEval: 4,
    maxShotsPerFrame: 420,
    curriculumVisits: 4,
    maxCurriculumShots: 18,
    mutationStrength: 0.12,
    initialParams: {},
    ...config,
  };

  let bestParams = { ...DEFAULT_PARAMS, ...full.initialParams };
  const initialEval = await evaluateParams(
    bestParams,
    full.framesPerEval,
    full.maxShotsPerFrame,
    full.curriculumVisits,
    full.maxCurriculumShots,
  );
  let bestStats = initialEval.stats;
  let bestBreakStats = initialEval.breakStats;
  let bestFitness = fitness(bestStats, bestBreakStats);
  const history: MasterOptimizationResult['history'] = [];

  for (let generation = 0; generation < full.generations; generation++) {
    const candidates: {
      params: MasterAgentParams;
      stats: AgentStats;
      breakStats: BreakBuildingStats;
      fitness: number;
    }[] = [];

    for (let i = 0; i < full.populationSize; i++) {
      const params = mutateParams(bestParams, full.mutationStrength);
      const evaluated = await evaluateParams(
        params,
        full.framesPerEval,
        full.maxShotsPerFrame,
        full.curriculumVisits,
        full.maxCurriculumShots,
      );
      candidates.push({
        params,
        stats: evaluated.stats,
        breakStats: evaluated.breakStats,
        fitness: fitness(evaluated.stats, evaluated.breakStats),
      });
    }

    candidates.sort((a, b) => b.fitness - a.fitness);
    const generationBest = candidates[0];
    const avgFitness = candidates.reduce((sum, c) => sum + c.fitness, 0) / candidates.length;

    if (generationBest.fitness > bestFitness) {
      bestFitness = generationBest.fitness;
      bestParams = generationBest.params;
      bestStats = generationBest.stats;
      bestBreakStats = generationBest.breakStats;
    }

    history.push({
      generation,
      bestFitness,
      avgFitness,
      highestBreak: bestStats.highestBreak,
      centuries: bestStats.centuryBreaks,
      redBlackPairs: bestBreakStats.redBlackPairs,
      blackAfterRedRate: bestBreakStats.blackAfterRedRate,
    });
    full.onProgress?.(generation, bestFitness, bestParams);
  }

  return { bestParams, bestFitness, bestStats, bestBreakStats, history };
}

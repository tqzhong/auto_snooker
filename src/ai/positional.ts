// ============================================================
// Positional Play — Break Building & Snooker Placement
// ============================================================

import type { Ball, BallColor, GameState, ShotParams, Vec2 } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import {
  BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH, CENTER_Y,
  POCKET_POSITIONS, BAULK_LINE_X,
} from '../engine/constants';
import { distanceBetween, angleBetween, applyShot, simulateShot } from '../engine/physics';
import { applyShotResult, evaluateShot } from '../engine/rules';
import {
  getLegalTargetBalls, calculateBestShot, calculatePotAngle, findContactAngle,
  getPotLineCount, nearestPocket, calculateGhostBallPosition, potCutAngleDegrees,
  isPotLineAvailable, shotHitsTargetFirst, distanceToPower, findAnyLegalContactShot,
  countEscapeAngles,
} from './strategy';

// ============================================================
// Position Quality Evaluation
// ============================================================

/** Evaluate how good a cue ball position is for continuing the break */
export function evaluatePositionQuality(
  cueBallPos: Vec2,
  targetBalls: Ball[],
  allBalls: Ball[],
): number {
  let score = 0;
  const cueAsBall: Ball = {
    id: -1, color: 'white', pos: { ...cueBallPos },
    vel: { x: 0, y: 0 }, radius: BALL_RADIUS, pocketed: false, active: true,
  };

  for (const target of targetBalls) {
    const dist = distanceBetween(cueBallPos, target.pos);
    const np = nearestPocket(target);
    const potAngle = Math.abs(Math.atan2(
      target.pos.y - cueBallPos.y, target.pos.x - cueBallPos.x,
    ) - Math.atan2(np.pos.y - target.pos.y, np.pos.x - target.pos.x));

    // Closer is better (but not too close — at least 2 ball radii)
    if (dist > BALL_RADIUS * 4) {
      score += 500 / (dist * 0.01 + 1);
    }

    // Pocket proximity bonus
    score += 300 / (np.dist * 0.01 + 1);

    // Straight shot bonus (closer to 180° = easier pot)
    const angleDiff = Math.abs(potAngle - Math.PI);
    score += (Math.PI - angleDiff) * 50;

    // Pot line count bonus
    const potLines = countPotLinesFromPos(cueBallPos, target, allBalls);
    score += potLines * 100;
  }

  return score;
}

export function countPotLinesFromPos(pos: Vec2, target: Ball, allBalls: Ball[]): number {
  // Simplified: check if direct line to each pocket is clear
  let count = 0;
  const pockets = [
    { x: 22, y: 22 }, { x: 22, y: TABLE_WIDTH - 22 },
    { x: TABLE_LENGTH / 2, y: 0 }, { x: TABLE_LENGTH / 2, y: TABLE_WIDTH },
    { x: TABLE_LENGTH - 22, y: 22 }, { x: TABLE_LENGTH - 22, y: TABLE_WIDTH - 22 },
  ];
  for (const p of pockets) {
    const ghost = calculateGhostBallPosition(target, p);
    if (!ghost) continue;
    if (isPathClear(pos, ghost, allBalls) && isPathClear(target.pos, p, allBalls)) {
      count++;
    }
  }
  return count;
}

function isPathClear(from: Vec2, to: Vec2, allBalls: Ball[]): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return true;
  const ux = dx / dist;
  const uy = dy / dist;
  for (const ball of allBalls) {
    if (ball.pocketed) continue;
    const bx = ball.pos.x - from.x;
    const by = ball.pos.y - from.y;
    const proj = bx * ux + by * uy;
    if (proj <= 0 || proj >= dist) continue;
    const perp = Math.abs(bx * (-uy) + by * ux);
    if (perp < BALL_RADIUS * 2.2) return false;
  }
  return true;
}

// ============================================================
// Break Sequence Planning
// ============================================================

export interface PlannedShot {
  targetBallId: number;
  pocketIndex: number;
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
  strategy: 'attack' | 'safety' | 'snooker';
  expectedCueBallPos: Vec2;
  score: number;
}

/** Plan a multi-shot break sequence */
export function planBreakSequence(
  state: GameState,
  maxShots = 3,
): PlannedShot[] {
  const plan: PlannedShot[] = [];
  let simulatedState = cloneState(state);

  for (let i = 0; i < maxShots; i++) {
    const targets = getLegalTargetBalls(simulatedState);
    if (targets.length === 0) break;

    let bestShot: PlannedShot | null = null;
    let bestScore = -Infinity;

    for (const target of targets) {
      const cueBall = simulatedState.balls.find(b => b.color === 'white' && !b.pocketed);
      if (!cueBall) continue;

      const shot = calculateBestShot(simulatedState, target, 0.5);
      if (!shot) continue;

      // Simulate the shot to see where cue ball ends up
      const copy = simulatedState.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
      applyShot(copy, shot.angle, shot.power, 0, 0);
      const sim = simulateShot(copy, { generateFrames: false });

      const newCueBall = sim.finalBalls.find(b => b.color === 'white');
      if (!newCueBall || newCueBall.pocketed) continue;

      // Evaluate position quality for next shot
      const nextTargets = sim.finalBalls.filter(b =>
        !b.pocketed && b.color !== 'white' &&
        (target.color === 'red' ? COLORS_ORDER.includes(b.color as BallColor) : b.color === 'red')
      );
      const posScore = evaluatePositionQuality(newCueBall.pos, nextTargets, sim.finalBalls);

      // Bonus for potting high-value balls
      const valueBonus = BALL_VALUES[target.color as BallColor] * 10;

      const totalScore = posScore + valueBonus;
      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestShot = {
          targetBallId: target.id,
          pocketIndex: shot.pocketIndex,
          angle: shot.angle,
          power: shot.power,
          spinX: 0,
          spinY: 0,
          strategy: 'attack',
          expectedCueBallPos: { ...newCueBall.pos },
          score: totalScore,
        };
      }
    }

    if (!bestShot) break;
    plan.push(bestShot);

    // Update simulated state for next iteration
    const nextBalls = simulatedState.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
    applyShot(nextBalls, bestShot.angle, bestShot.power, bestShot.spinX, bestShot.spinY);
    const nextSim = simulateShot(nextBalls, { generateFrames: false });
    simulatedState = {
      ...simulatedState,
      balls: nextSim.finalBalls,
      redsRemaining: nextSim.finalBalls.filter(b => b.color === 'red' && !b.pocketed).length,
    };
  }

  return plan;
}

// ============================================================
// Snooker Placement
// ============================================================

export interface SnookerShot {
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
  snookerQuality: number;
  escapeAngles: number;
}

/** Find the best snooker placement after contacting the ball-on */
export function findSnookerPlacement(
  state: GameState,
  targetBall: Ball,
): SnookerShot | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;

  const contact = findContactAngle(state, targetBall);
  if (!contact) return null;

  const candidates: SnookerShot[] = [];
  const powers = [0.3, 0.45, 0.6, 0.75];
  const spinVariations = [-0.3, 0, 0.3];

  const requiredTargets = getLegalTargetBalls(state);

  for (const power of powers) {
    for (const spinX of spinVariations) {
      for (const spinY of [-0.2, 0, 0.2]) {
        const copy = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
        applyShot(copy, contact.angle, power, spinX, spinY);
        const sim = simulateShot(copy, { generateFrames: false });

        const newCueBall = sim.finalBalls.find(b => b.color === 'white');
        if (!newCueBall || newCueBall.pocketed) continue;

        // Count escape angles: how many angles can the opponent hit the ball-on?
        const opponentTargets = sim.finalBalls.filter(b =>
          !b.pocketed && requiredTargets.some(t => t.color === b.color)
        );
        let escapeCount = 0;
        const steps = 36;
        for (let i = 0; i < steps; i++) {
          const angle = (Math.PI * 2 * i) / steps;
          const dir = { x: Math.cos(angle), y: Math.sin(angle) };
          for (const t of opponentTargets) {
            const dx = t.pos.x - newCueBall.pos.x;
            const dy = t.pos.y - newCueBall.pos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const proj = dx * dir.x + dy * dir.y;
            if (proj <= 0) continue;
            const perp = Math.abs(dx * (-dir.y) + dy * dir.x);
            if (perp < BALL_RADIUS * 2.2) {
              escapeCount++;
              break;
            }
          }
        }

        if (escapeCount <= 8) {
          candidates.push({
            angle: contact.angle,
            power,
            spinX,
            spinY,
            snookerQuality: Math.max(0, 100 - escapeCount * 12),
            escapeAngles: escapeCount,
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.snookerQuality - a.snookerQuality);
  return candidates[0];
}

// ============================================================
// Master Positional Decision
// ============================================================

export interface MasterPositionalShot {
  targetBallId: number;
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
  strategy: 'attack' | 'safety' | 'snooker';
  score: number;
  expectedCueBallPos: Vec2;
  reasoning: string;
}

export interface MasterSelectionOptions {
  /** 0 = always best score, 1 = wider weighted choice among strong candidates. */
  creativity?: number;
  rng?: () => number;
  macroAdvice?: MacroStrategyAdvice | null;
  scoring?: Partial<MasterScoringParams>;
  searchDepth?: number;
  beamWidth?: number;
  branchWidth?: number;
}

export interface MacroStrategyAdvice {
  intent?: 'attack_continue' | 'attack_safe' | 'safety' | 'snooker' | 'escape' | 'contain';
  riskTolerance?: number;
  positionPriority?: number;
  preferredColor?: BallColor;
  avoidHighDifficulty?: boolean;
  reasoning?: string;
}

export interface MasterScoringParams {
  difficultyPenalty: number;
  highDifficultyPenalty: number;
  cueTravelPenalty: number;
  positionReward: number;
  safetyReward: number;
  valueReward: number;
  blackPinkBias: number;
  spinUseReward: number;
}

const DEFAULT_MASTER_SCORING: MasterScoringParams = {
  difficultyPenalty: 7.2,
  highDifficultyPenalty: 220,
  cueTravelPenalty: 1,
  positionReward: 1,
  safetyReward: 1,
  valueReward: 1,
  blackPinkBias: 1,
  spinUseReward: 1,
};

interface SimulatedCandidate {
  target: Ball;
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
  sim: ReturnType<typeof simulateShot>;
  cueBall: Ball;
}

const ATTACK_SPINS = [
  { spinX: 0, spinY: 0 },
  { spinX: 0, spinY: 0.62 },
  { spinX: 0, spinY: -0.48 },
  { spinX: 0, spinY: -0.68 },
  { spinX: 0, spinY: -0.35 },
  { spinX: 0, spinY: -0.18 },
  { spinX: 0, spinY: 0.12 },
  { spinX: 0, spinY: 0.24 },
  { spinX: 0, spinY: 0.46 },
  { spinX: -0.24, spinY: 0.58 },
  { spinX: 0.24, spinY: 0.58 },
  { spinX: -0.22, spinY: -0.36 },
  { spinX: 0.22, spinY: -0.36 },
  { spinX: -0.45, spinY: -0.18 },
  { spinX: 0.45, spinY: -0.18 },
  { spinX: -0.28, spinY: 0.12 },
  { spinX: 0.28, spinY: 0.12 },
  { spinX: -0.42, spinY: 0.28 },
  { spinX: 0.42, spinY: 0.28 },
  { spinX: -0.25, spinY: 0.48 },
  { spinX: 0.25, spinY: 0.48 },
];

const SAFETY_SPINS = [
  { spinX: 0, spinY: -0.5 },
  { spinX: 0, spinY: -0.35 },
  { spinX: 0, spinY: -0.15 },
  { spinX: -0.35, spinY: -0.1 },
  { spinX: 0.35, spinY: -0.1 },
  { spinX: -0.58, spinY: -0.18 },
  { spinX: 0.58, spinY: -0.18 },
  { spinX: -0.5, spinY: 0.12 },
  { spinX: 0.5, spinY: 0.12 },
  { spinX: 0, spinY: 0.18 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uniqueNumbers(values: number[], precision = 1000): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    const key = Math.round(value * precision);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function cloneBalls(balls: Ball[]): Ball[] {
  return balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
}

function simulateCandidate(
  state: GameState,
  target: Ball,
  angle: number,
  power: number,
  spinX: number,
  spinY: number,
): SimulatedCandidate | null {
  const balls = cloneBalls(state.balls);
  applyShot(balls, angle, power, spinX, spinY);
  const sim = simulateShot(balls, { generateFrames: false });
  const cueBall = sim.finalBalls.find(b => b.color === 'white');
  if (!cueBall || cueBall.pocketed || sim.cueBallPotted) return null;
  if (sim.firstContactBallId !== target.id) return null;
  return { target, angle, power, spinX, spinY, sim, cueBall };
}

function scoreDiff(state: GameState): number {
  const current = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];
  return current.score - opponent.score;
}

function maxLikelyPointsRemaining(balls: Ball[]): number {
  const reds = balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const colors = COLORS_ORDER.reduce((sum, color) => {
    const ball = balls.find(b => b.color === color && !b.pocketed);
    return sum + (ball ? BALL_VALUES[color] : 0);
  }, 0);
  return reds > 0 ? reds * 8 + colors : colors;
}

function shouldPreferSafety(state: GameState): boolean {
  if (state.phase === 'colors_phase') return false;
  const diff = scoreDiff(state);
  const remaining = maxLikelyPointsRemaining(state.balls);
  return diff > Math.max(20, remaining * 0.35);
}

function shouldForceAttack(state: GameState): boolean {
  const diff = scoreDiff(state);
  const remaining = maxLikelyPointsRemaining(state.balls);
  return diff < -Math.max(18, remaining * 0.25);
}

function distanceToNearestCushion(pos: Vec2): number {
  return Math.min(pos.x, TABLE_LENGTH - pos.x, pos.y, TABLE_WIDTH - pos.y);
}

function baulkSafetyBonus(state: GameState, cueBallPos: Vec2): number {
  if (state.phase !== 'break_off' && state.phase !== 'reds_phase') return 0;
  return cueBallPos.x > BAULK_LINE_X ? 140 : cueBallPos.x > TABLE_LENGTH * 0.65 ? 70 : 0;
}

function cueTravelPenalty(start: Vec2, end: Vec2, hasNextShape: boolean): number {
  const travel = distanceBetween(start, end);
  const softLimit = hasNextShape ? 760 : 520;
  const mediumLimit = hasNextShape ? 1250 : 900;
  return Math.max(0, travel - softLimit) * 0.18 +
    Math.max(0, travel - mediumLimit) * 0.34 +
    Math.max(0, travel - 1750) * 0.55;
}

function normalizeAngle(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
}

function shotDifficulty(
  state: GameState,
  target: Ball,
  pocketPos: Vec2,
  angle: number,
  power: number,
  spinX: number,
  spinY: number,
): { difficulty: number; label: string } {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return { difficulty: 100, label: '无白球' };

  const cueToTarget = distanceBetween(cueBall.pos, target.pos);
  const targetToPocket = distanceBetween(target.pos, pocketPos);
  const objectAngle = angleBetween(target.pos, pocketPos);
  const cutAngle = Math.abs(normalizeAngle(angle - objectAngle));
  const cutDegrees = Math.min(180, cutAngle * 180 / Math.PI);
  const potLines = getPotLineCount(state, target);
  const cueCushion = distanceToNearestCushion(cueBall.pos);
  const targetCushion = distanceToNearestCushion(target.pos);

  let difficulty = 0;
  difficulty += clamp((cueToTarget - 450) / 18, 0, 28);
  difficulty += clamp((targetToPocket - 450) / 22, 0, 26);
  difficulty += clamp((cutDegrees - 18) * 0.95, 0, 34);
  difficulty += potLines <= 1 ? 10 : potLines === 2 ? 3 : 0;
  difficulty += cueCushion < 95 ? 11 : cueCushion < 150 ? 5 : 0;
  difficulty += targetCushion < 80 ? 8 : targetCushion < 130 ? 4 : 0;
  difficulty += power > 0.62 ? (power - 0.62) * 36 : 0;
  difficulty += Math.max(0, Math.abs(spinX) - 0.35) * 13;
  difficulty += Math.max(0, Math.abs(spinY) - 0.45) * 8;

  const label = cutDegrees > 48 ? '薄球' :
    cueToTarget > 1450 || targetToPocket > 1200 ? '长台' :
      cueCushion < 120 || targetCushion < 100 ? '贴库' : '常规';
  return { difficulty: clamp(difficulty, 0, 100), label };
}

function spinComplexityPenalty(spinX: number, spinY: number): number {
  return (Math.abs(spinX) * 18) + (Math.abs(spinY) * 12) +
    Math.max(0, Math.abs(spinX) - 0.45) * 28;
}

function distanceComfortScore(distance: number): number {
  if (distance < BALL_RADIUS * 3.2) return -420;
  if (distance < 190) return -180;
  if (distance <= 620) return 230;
  if (distance <= 920) return 160;
  if (distance <= 1220) return 35;
  return -Math.min(340, (distance - 1220) * 0.3);
}

function cueComfortPenalty(cueBallPos: Vec2, nextTargets: Ball[], allBalls: Ball[]): number {
  const cushion = distanceToNearestCushion(cueBallPos);
  let penalty = 0;
  penalty += Math.max(0, 155 - cushion) * 1.8;
  penalty += cushion < 70 ? 260 : 0;

  const cueProxy: Ball = {
    id: -100,
    color: 'white',
    pos: cueBallPos,
    vel: { x: 0, y: 0 },
    radius: BALL_RADIUS,
    pocketed: false,
    active: true,
  };

  let bestCut = Infinity;
  let easyLine = false;
  for (const target of nextTargets) {
    for (const [x, y] of POCKET_POSITIONS) {
      const pocket = { x, y };
      if (!isPotLineAvailable(cueProxy, target, pocket, allBalls)) continue;
      const cut = potCutAngleDegrees(cueProxy, target, pocket);
      bestCut = Math.min(bestCut, cut);
      if (cut <= 28) easyLine = true;
    }
  }

  if (!Number.isFinite(bestCut)) return penalty + 520;
  penalty += Math.max(0, bestCut - 34) * 9;
  if (!easyLine) penalty += 160;
  return penalty;
}

function highBreakColorPriority(color: BallColor): number {
  if (color === 'black') return 7;
  if (color === 'pink') return 6;
  if (color === 'blue') return 4.2;
  if (color === 'brown') return 2.2;
  if (color === 'green') return 1.2;
  if (color === 'yellow') return 1;
  return 0.6;
}

function scoreNextCueShape(
  cueBallPos: Vec2,
  nextTargets: Ball[],
  allBalls: Ball[],
  params: MasterScoringParams = DEFAULT_MASTER_SCORING,
): { score: number; nextPotLines: number; bestDistance: number; hasShape: boolean; bestColor: BallColor | null } {
  if (nextTargets.length === 0) {
    return { score: 0, nextPotLines: 0, bestDistance: 0, hasShape: false, bestColor: null };
  }

  let bestScore = -Infinity;
  let bestDistance = Infinity;
  let bestColor: BallColor | null = null;
  let totalPotLines = 0;

  for (const next of nextTargets) {
    const dist = distanceBetween(cueBallPos, next.pos);
    const potLines = countPotLinesFromPos(cueBallPos, next, allBalls);
    totalPotLines += potLines;

    const value = BALL_VALUES[next.color as BallColor] ?? 1;
    const colorPriority = highBreakColorPriority(next.color as BallColor);
    const pocketDist = nearestPocket(next).dist;
    const lineScore = potLines > 0 ? potLines * 190 : -260;
    const score = lineScore +
      distanceComfortScore(dist) +
      value * 30 +
      colorPriority * 42 * params.blackPinkBias -
      (next.color === 'black' || next.color === 'pink' ? Math.max(0, dist - 900) * 0.09 : 0) -
      Math.max(0, 170 - distanceToNearestCushion(cueBallPos)) * 0.85 -
      Math.max(0, pocketDist - 900) * 0.035;

    if (score > bestScore) {
      bestScore = score;
      bestDistance = dist;
      bestColor = next.color as BallColor;
    }
  }

  return {
    score: bestScore,
    nextPotLines: totalPotLines,
    bestDistance,
    hasShape: bestScore > 0 && totalPotLines > 0,
    bestColor,
  };
}

function getContinuationTargetsAfterPot(state: GameState, finalBalls: Ball[], pottedTarget: Ball): Ball[] {
  const active = finalBalls.filter(b => !b.pocketed && b.color !== 'white');

  if (state.phase === 'break_off' || state.phase === 'reds_phase') {
    if (pottedTarget.color === 'red') {
      return active.filter(b => COLORS_ORDER.includes(b.color as BallColor));
    }
    return active.filter(b => b.color === 'red');
  }

  if (state.phase === 'color_after_red') {
    const reds = active.filter(b => b.color === 'red');
    if (reds.length > 0) return reds;
    const yellow = active.find(b => b.color === 'yellow');
    return yellow ? [yellow] : [];
  }

  if (state.phase === 'colors_phase') {
    const idx = COLORS_ORDER.indexOf(pottedTarget.color as BallColor);
    if (idx < 0) return [];
    for (let i = idx + 1; i < COLORS_ORDER.length; i++) {
      const next = active.find(b => b.color === COLORS_ORDER[i]);
      if (next) return [next];
    }
  }

  return [];
}

function getSameTurnTargetsFromFinal(state: GameState, finalBalls: Ball[]): Ball[] {
  const projectedState = {
    ...state,
    balls: finalBalls,
    redsRemaining: finalBalls.filter(b => b.color === 'red' && !b.pocketed).length,
  };
  return getLegalTargetBalls(projectedState);
}

function scoreObjectBallSafety(targetBalls: Ball[]): number {
  if (targetBalls.length === 0) return 0;
  const total = targetBalls.reduce((sum, target) => {
    const pocketDist = nearestPocket(target).dist;
    return sum + clamp(pocketDist, 0, 800);
  }, 0);
  return total / targetBalls.length;
}

function contactAngleCandidates(state: GameState, target: Ball): number[] {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return [];

  const contact = findContactAngle(state, target);
  const angles: number[] = contact ? [contact.angle] : [];
  const direct = angleBetween(cueBall.pos, target.pos);
  angles.push(direct);

  const dist = distanceBetween(cueBall.pos, target.pos);
  if (dist > cueBall.radius + target.radius) {
    const maxOffset = Math.asin(Math.min(0.999, (cueBall.radius + target.radius) / dist));
    for (const ratio of [0.55, 0.9]) {
      angles.push(direct + maxOffset * ratio);
      angles.push(direct - maxOffset * ratio);
    }
  }

  const activeBalls = state.balls.filter(b => !b.pocketed);
  return uniqueNumbers(angles, 100000).filter(angle =>
    shotHitsTargetFirst(cueBall, target, activeBalls, angle)
  );
}

function makeAttackCandidate(
  state: GameState,
  candidate: SimulatedCandidate,
  pocket: { pos: Vec2; index: number },
  params: MasterScoringParams,
  macroAdvice?: MacroStrategyAdvice | null,
): MasterPositionalShot | null {
  const { target, sim, cueBall } = candidate;
  const startCueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!startCueBall) return null;

  const targetPotted = sim.pottedBalls.some(b => b.id === target.id);
  if (!targetPotted) return null;

  const wrongExtraColor = sim.pottedBalls.some(b => b.id !== target.id && b.color !== target.color);
  const nextTargets = getContinuationTargetsAfterPot(state, sim.finalBalls, target);
  const shape = scoreNextCueShape(cueBall.pos, nextTargets, sim.finalBalls, params);
  const broadPositionScore = evaluatePositionQuality(cueBall.pos, nextTargets, sim.finalBalls) * 0.18;
  const value = BALL_VALUES[target.color as BallColor];
  const cueToTarget = distanceBetween(startCueBall.pos, target.pos);
  const targetPocketDist = nearestPocket(target).dist;
  const cushionPenalty = Math.max(0, 180 - distanceToNearestCushion(cueBall.pos)) * 1.25 +
    cueComfortPenalty(cueBall.pos, nextTargets, sim.finalBalls);
  const overrunPenalty = cueTravelPenalty(startCueBall.pos, cueBall.pos, shape.hasShape);
  const difficulty = shotDifficulty(
    state, target, pocket.pos, candidate.angle, candidate.power, candidate.spinX, candidate.spinY,
  );
  const riskTolerance = clamp(macroAdvice?.riskTolerance ?? 0.45, 0, 1);
  const difficultyCap = 42 + riskTolerance * 42 + (shouldForceAttack(state) ? 18 : 0);
  const highDifficultyPenalty = difficulty.difficulty > difficultyCap
    ? (difficulty.difficulty - difficultyCap) * params.highDifficultyPenalty * 0.045
    : 0;
  const llmAvoidPenalty = macroAdvice?.avoidHighDifficulty && difficulty.difficulty > 58 ? 260 : 0;
  const preferredColorBonus = macroAdvice?.preferredColor === target.color ? 95 : 0;
  const attackIntentBonus = macroAdvice?.intent === 'attack_continue' ? 130 :
    macroAdvice?.intent === 'attack_safe' ? 45 :
      macroAdvice?.intent === 'safety' || macroAdvice?.intent === 'snooker' ? -180 : 0;
  const simpleShotBonus = candidate.power <= 0.48 && Math.abs(candidate.spinX) <= 0.3 ? 65 : 0;
  const controlScore = (shape.score + broadPositionScore + shape.nextPotLines * 42) * params.positionReward - cushionPenalty;
  const difficultyScore = getPotLineCount(state, target) * 75 - cueToTarget * 0.025 - targetPocketDist * 0.015;
  const usedIntentionalSpin = shape.hasShape && (Math.abs(candidate.spinY) >= 0.42 || Math.abs(candidate.spinX) >= 0.32);
  const spinShapeBonus = usedIntentionalSpin ? 54 * params.spinUseReward : 0;
  const score = value * 140 * params.valueReward + controlScore + difficultyScore -
    candidate.power * 82 -
    overrunPenalty * params.cueTravelPenalty -
    difficulty.difficulty * params.difficultyPenalty -
    highDifficultyPenalty -
    llmAvoidPenalty +
    preferredColorBonus +
    attackIntentBonus -
    spinComplexityPenalty(candidate.spinX, candidate.spinY) * 0.58 +
    spinShapeBonus +
    simpleShotBonus -
    (wrongExtraColor ? 900 : 0);

  return {
    targetBallId: target.id,
    angle: candidate.angle,
    power: candidate.power,
    spinX: candidate.spinX,
    spinY: candidate.spinY,
    strategy: 'attack',
    score,
    expectedCueBallPos: { ...cueBall.pos },
    reasoning: `控球进攻 ${target.color}#${target.id} 入袋${pocket.index}；难度${difficulty.difficulty.toFixed(0)}(${difficulty.label})，下一杆优先${shape.bestColor ?? 'none'}，可用线路${shape.nextPotLines}条，最佳距离${Math.round(shape.bestDistance)}mm，白球移动${Math.round(distanceBetween(startCueBall.pos, cueBall.pos))}mm`,
  };
}

export function collectControlledAttacks(
  state: GameState,
  targets = getLegalTargetBalls(state),
  options: MasterSelectionOptions = {},
): MasterPositionalShot[] {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return [];
  const params = { ...DEFAULT_MASTER_SCORING, ...options.scoring };

  const activeBalls = state.balls.filter(b => !b.pocketed);
  const rankedTargets = targets
    .map(target => ({
      target,
      potLines: getPotLineCount(state, target),
      value: BALL_VALUES[target.color as BallColor],
      cueDist: distanceBetween(cueBall.pos, target.pos),
    }))
    .filter(item => item.potLines > 0)
    .sort((a, b) => b.potLines - a.potLines || b.value - a.value || a.cueDist - b.cueDist)
    .slice(0, 5);

  const candidates: MasterPositionalShot[] = [];

  for (const item of rankedTargets) {
    const target = item.target;
    const availablePockets = POCKET_POSITIONS
      .map((pos, index) => ({ pos: { x: pos[0], y: pos[1] }, index, dist: distanceBetween(target.pos, { x: pos[0], y: pos[1] }) }))
      .filter(pocket => isPotLineAvailable(cueBall, target, pocket.pos, activeBalls))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 2);

    for (const pocket of availablePockets) {
      const angle = calculatePotAngle(cueBall, target, pocket.pos);
      const basePower = distanceToPower(distanceBetween(cueBall.pos, target.pos) + pocket.dist * 0.35);
      const powers = uniqueNumbers([
        clamp(basePower * 0.72, 0.16, 1.16),
        clamp(basePower, 0.18, 1.16),
        clamp(basePower * 1.22, 0.18, 1.16),
        0.32,
        0.5,
        0.82,
        1.08,
      ]);
      const spinOptions = item.potLines >= 2
        ? ATTACK_SPINS.slice(0, 12)
        : ATTACK_SPINS.slice(0, 9);

      for (const spin of spinOptions) {
        for (const power of powers) {
          const simulated = simulateCandidate(state, target, angle, power, spin.spinX, spin.spinY);
          if (!simulated) continue;
          const shot = makeAttackCandidate(state, simulated, pocket, params, options.macroAdvice);
          if (shot) candidates.push(shot);
        }
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function findBestControlledAttack(
  state: GameState,
  targets = getLegalTargetBalls(state),
  options: MasterSelectionOptions = {},
): MasterPositionalShot | null {
  return collectControlledAttacks(state, targets, options)[0] ?? null;
}

function makeSafetyCandidate(
  state: GameState,
  candidate: SimulatedCandidate,
  params: MasterScoringParams,
  macroAdvice?: MacroStrategyAdvice | null,
): MasterPositionalShot {
  const { target, sim, cueBall } = candidate;
  const startCueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  const opponentTargets = getSameTurnTargetsFromFinal(state, sim.finalBalls);
  const escapeAngles = countEscapeAngles(cueBall, opponentTargets, sim.finalBalls);
  const opponentPotLines = opponentTargets.reduce((sum, next) =>
    sum + countPotLinesFromPos(cueBall.pos, next, sim.finalBalls), 0);
  const distances = opponentTargets.map(t => distanceBetween(cueBall.pos, t.pos));
  const minDistance = distances.length ? Math.min(...distances) : 0;
  const avgDistance = distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : 0;
  const cushionDistance = distanceToNearestCushion(cueBall.pos);
  const cushionBonus = Math.max(0, 190 - cushionDistance) * 0.7;
  const objectSafety = scoreObjectBallSafety(opponentTargets) * 0.1;
  const accidentalPotPenalty = sim.pottedBalls.length * 450;
  const snookerBonus = escapeAngles === 0 ? 520 : Math.max(0, 18 - escapeAngles) * 24;
  const safetyIntentBonus = macroAdvice?.intent === 'snooker' && escapeAngles <= 6 ? 220 :
    macroAdvice?.intent === 'safety' || macroAdvice?.intent === 'contain' ? 140 :
      macroAdvice?.intent === 'attack_continue' ? -160 : 0;

  const score = (snookerBonus +
    (72 - escapeAngles) * 7 -
    opponentPotLines * 145 +
    minDistance * 0.22 +
    avgDistance * 0.07 +
    cushionBonus +
    baulkSafetyBonus(state, cueBall.pos) +
    objectSafety) * params.safetyReward +
    safetyIntentBonus -
    accidentalPotPenalty -
    candidate.power * 32 -
    spinComplexityPenalty(candidate.spinX, candidate.spinY) * 0.45 -
    (startCueBall ? Math.max(0, distanceBetween(startCueBall.pos, cueBall.pos) - 2200) * 0.12 : 0);

  const strategy = escapeAngles <= 2 ? 'snooker' : 'safety';
  return {
    targetBallId: target.id,
    angle: candidate.angle,
    power: candidate.power,
    spinX: candidate.spinX,
    spinY: candidate.spinY,
    strategy,
    score,
    expectedCueBallPos: { ...cueBall.pos },
    reasoning: strategy === 'snooker'
      ? `高质量防守：借${target.color}#${target.id} 做斯诺克，直线逃脱角${escapeAngles}，对手可进线路${opponentPotLines}`
      : `控球防守 ${target.color}#${target.id}；白球预计(${Math.round(cueBall.pos.x)},${Math.round(cueBall.pos.y)})，对手可进线路${opponentPotLines}，最近目标${Math.round(minDistance)}mm`,
  };
}

export function collectTacticalSafeties(
  state: GameState,
  targets = getLegalTargetBalls(state),
  options: MasterSelectionOptions = {},
): MasterPositionalShot[] {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return [];
  const params = { ...DEFAULT_MASTER_SCORING, ...options.scoring };

  const rankedTargets = targets
    .map(target => ({
      target,
      potLines: getPotLineCount(state, target),
      cueDist: distanceBetween(cueBall.pos, target.pos),
      pocketDist: nearestPocket(target).dist,
    }))
    .sort((a, b) => a.potLines - b.potLines || b.pocketDist - a.pocketDist || a.cueDist - b.cueDist)
    .slice(0, 5);

  const candidates: MasterPositionalShot[] = [];

  for (const item of rankedTargets) {
    const angles = contactAngleCandidates(state, item.target);
    if (angles.length === 0) continue;

    const basePower = distanceToPower(item.cueDist);
    const powers = uniqueNumbers([
      clamp(basePower * 0.65, 0.18, 0.88),
      0.26,
      0.4,
      0.62,
      0.82,
    ]);
    const spinOptions = SAFETY_SPINS.slice(0, 7);

    for (const angle of angles) {
      for (const spin of spinOptions) {
        for (const power of powers) {
          const simulated = simulateCandidate(state, item.target, angle, power, spin.spinX, spin.spinY);
          if (!simulated) continue;
          const shot = makeSafetyCandidate(state, simulated, params, options.macroAdvice);
          candidates.push(shot);
        }
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function findBestTacticalSafety(
  state: GameState,
  targets = getLegalTargetBalls(state),
  options: MasterSelectionOptions = {},
): MasterPositionalShot | null {
  return collectTacticalSafeties(state, targets, options)[0] ?? null;
}

interface AttackProjection {
  state: GameState;
  points: number;
  potted: Ball[];
}

function projectAttackState(state: GameState, shot: MasterPositionalShot): AttackProjection | null {
  if (shot.strategy !== 'attack') return null;

  const balls = cloneBalls(state.balls);
  applyShot(balls, shot.angle, shot.power, shot.spinX, shot.spinY);
  const sim = simulateShot(balls, { generateFrames: false });
  const shotParams: ShotParams = {
    angle: shot.angle,
    power: shot.power,
    spinX: shot.spinX,
    spinY: shot.spinY,
    targetBallId: shot.targetBallId,
  };
  const result = evaluateShot(state, shotParams, sim);
  if (result.fouls.length > 0 || result.pointsScored <= 0) return null;

  const nextState = applyShotResult(state, shotParams, sim, result, 'search projection');
  if (nextState.currentPlayerIndex !== state.currentPlayerIndex || nextState.phase === 'game_over') {
    return null;
  }

  return { state: nextState, points: result.pointsScored, potted: result.pottedBalls };
}

function bestColorAvailableFromCue(cueBallPos: Vec2, balls: Ball[], color: BallColor): {
  lines: number;
  bestDistance: number;
} {
  const targets = balls.filter(b => b.color === color && !b.pocketed);
  let lines = 0;
  let bestDistance = Infinity;

  for (const target of targets) {
    lines += countPotLinesFromPos(cueBallPos, target, balls);
    bestDistance = Math.min(bestDistance, distanceBetween(cueBallPos, target.pos));
  }

  return { lines, bestDistance };
}

function countRedsPotted(potted: Ball[]): number {
  return potted.filter(b => b.color === 'red').length;
}

function break147IntentScore(
  state: GameState,
  shot: MasterPositionalShot,
  projection: AttackProjection | null,
): number {
  if (!projection) return -1200;

  const cueBall = projection.state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return -1200;

  const target = state.balls.find(b => b.id === shot.targetBallId);
  if (!target) return 0;

  let score = 0;
  const redsRemainingBefore = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const redsPotted = countRedsPotted(projection.potted);

  if (state.phase === 'break_off' || state.phase === 'reds_phase') {
    if (target.color === 'red') {
      score += 210;
      score += redsPotted === 1 ? 180 : -650 * Math.max(0, redsPotted - 1);

      const blackShape = bestColorAvailableFromCue(cueBall.pos, projection.state.balls, 'black');
      const pinkShape = bestColorAvailableFromCue(cueBall.pos, projection.state.balls, 'pink');
      const blueShape = bestColorAvailableFromCue(cueBall.pos, projection.state.balls, 'blue');
      score += blackShape.lines > 0 ? 740 : -280;
      score += blackShape.bestDistance < 820 ? 260 : blackShape.bestDistance < 1150 ? 90 : -140;
      score += pinkShape.lines > 0 ? 180 : 0;
      score += blueShape.lines > 0 ? 65 : 0;
    }
  } else if (state.phase === 'color_after_red') {
    const color = target.color as BallColor;
    if (color === 'black') score += 960;
    else if (color === 'pink') score += 320;
    else if (color === 'blue') score += 80;
    else score -= 220;

    const redShape = bestColorAvailableFromCue(cueBall.pos, projection.state.balls, 'red');
    score += redShape.lines > 0 ? 560 : -360;
    score += redShape.bestDistance < 740 ? 220 : redShape.bestDistance < 1100 ? 60 : -160;
  } else if (state.phase === 'colors_phase') {
    score += projection.points * 95;
  }

  const cushionDistance = distanceToNearestCushion(cueBall.pos);
  score -= Math.max(0, 105 - cushionDistance) * 2.4;
  score -= shot.power > 0.64 ? (shot.power - 0.64) * 360 : 0;
  score -= Math.max(0, Math.abs(shot.spinX) - 0.42) * 150;

  // A maximum break requires exactly fifteen red-colour pairs before the final colours.
  // Losing reds cheaply reduces the ceiling, so preserve the 147 route while reds remain.
  if (redsRemainingBefore > 0 && redsPotted > 1) {
    score -= (redsPotted - 1) * 900;
  }

  return score;
}

function terminalBreakValue(state: GameState): number {
  const current = state.players[state.currentPlayerIndex];
  const redsRemaining = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return -1000;

  let score = current.currentBreak * 18;
  if (redsRemaining > 0) {
    const blackShape = bestColorAvailableFromCue(cueBall.pos, state.balls, 'black');
    const redShape = bestColorAvailableFromCue(cueBall.pos, state.balls, 'red');
    score += blackShape.lines * 260 + redShape.lines * 120;
    score -= blackShape.lines === 0 && state.phase === 'color_after_red' ? 320 : 0;
    score -= redShape.lines === 0 && state.phase !== 'color_after_red' ? 220 : 0;
  }
  return score;
}

function searchBreakValue(
  state: GameState,
  depth: number,
  options: MasterSelectionOptions,
): number {
  if (depth <= 0 || state.phase === 'game_over') return terminalBreakValue(state);

  const attacks = collectControlledAttacks(state, getLegalTargetBalls(state), {
    ...options,
    creativity: 0,
  }).slice(0, Math.max(1, options.branchWidth ?? 4));

  if (attacks.length === 0) return terminalBreakValue(state) - 420;

  let best = -Infinity;
  for (const attack of attacks) {
    const projection = projectAttackState(state, attack);
    const intent = break147IntentScore(state, attack, projection);
    if (!projection) {
      best = Math.max(best, attack.score + intent);
      continue;
    }

    const future = searchBreakValue(projection.state, depth - 1, options);
    const total = attack.score * 0.35 +
      projection.points * 145 +
      intent +
      future * 0.72;
    if (total > best) best = total;
  }

  return best;
}

function applyBreakSearchScores(
  state: GameState,
  attacks: MasterPositionalShot[],
  options: MasterSelectionOptions = {},
): MasterPositionalShot[] {
  const depth = clamp(options.searchDepth ?? 2, 0, 6);
  if (depth <= 1 || attacks.length === 0) return attacks;

  const beamWidth = Math.max(1, Math.floor(options.beamWidth ?? 3));
  const branchWidth = Math.max(1, Math.floor(options.branchWidth ?? 3));

  return attacks
    .slice(0, beamWidth)
    .map(attack => {
      const projection = projectAttackState(state, attack);
      const intent = break147IntentScore(state, attack, projection);
      const future = projection
        ? searchBreakValue(projection.state, depth - 1, { ...options, branchWidth })
        : -1000;
      const searchBonus = intent + future * 0.58;
      return {
        ...attack,
        score: attack.score + searchBonus,
        reasoning: `${attack.reasoning}；147搜索 depth=${depth} bonus=${searchBonus.toFixed(0)}`,
      };
    })
    .sort((a, b) => b.score - a.score)
    .concat(attacks.slice(beamWidth));
}

function chooseWeightedCandidate(
  candidates: MasterPositionalShot[],
  options: MasterSelectionOptions = {},
): MasterPositionalShot | null {
  if (candidates.length === 0) return null;

  const creativity = clamp(options.creativity ?? 0.16, 0, 1);
  const rng = options.rng ?? Math.random;
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0];
  if (creativity <= 0 || sorted.length === 1) return best;

  const scoreBand = 45 + Math.abs(best.score) * (0.025 + creativity * 0.055);
  const pool = sorted
    .filter(candidate => candidate.score >= best.score - scoreBand)
    .slice(0, 5);
  if (pool.length === 1) return best;

  const temperature = 28 + creativity * 115;
  const weights = pool.map(candidate =>
    Math.exp((candidate.score - best.score) / temperature)
  );
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = rng() * total;

  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return {
      ...pool[i],
      reasoning: `${pool[i].reasoning}；候选池${pool.length}选1`,
    };
  }

  return best;
}

export function selectMasterPositionalShot(
  state: GameState,
  options: MasterSelectionOptions = {},
): MasterPositionalShot | null {
  const targets = getLegalTargetBalls(state);
  if (targets.length === 0) return null;

  const baseAttacks = collectControlledAttacks(state, targets, options);
  const attacks = applyBreakSearchScores(state, baseAttacks, options);
  const attack = attacks[0] ?? null;
  const safetyPreferred = shouldPreferSafety(state);

  if (state.phase === 'colors_phase' && attack) {
    return chooseWeightedCandidate(attacks, { ...options, creativity: 0 });
  }
  if (attack && shouldForceAttack(state)) return chooseWeightedCandidate(attacks, options);
  if (attack && !safetyPreferred && attack.score > 850) {
    return chooseWeightedCandidate(attacks, options);
  }

  const safeties = collectTacticalSafeties(state, targets, options);
  const safety = safeties[0] ?? null;

  if (attack && !safety) return chooseWeightedCandidate(attacks, options);
  if (!attack && safety) return chooseWeightedCandidate(safeties, options);
  if (attack && safety) {
    if (safetyPreferred && safety.score > attack.score * 0.55) {
      return chooseWeightedCandidate(safeties, options);
    }
    const attackClearlyContinues = attack.score > safety.score * 0.72;
    return attackClearlyContinues
      ? chooseWeightedCandidate(attacks, options)
      : chooseWeightedCandidate(safeties, options);
  }

  const escape = findAnyLegalContactShot(state, 0.55);
  if (!escape) return null;
  return {
    targetBallId: escape.targetBallId,
    angle: escape.angle,
    power: escape.power,
    spinX: 0,
    spinY: 0,
    strategy: 'safety',
    score: -1000,
    expectedCueBallPos: state.balls.find(b => b.color === 'white')?.pos ?? { x: 0, y: 0 },
    reasoning: `被动解球：所有高质量候选失败，先确保合法碰到目标#${escape.targetBallId}`,
  };
}

// ============================================================
// Attack vs Defense Decision
// ============================================================

/** Determine if the agent should attack or defend based on game state */
export function shouldAttack(state: GameState): {
  attack: boolean;
  reason: string;
  aggressionLevel: number;
} {
  const current = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];
  const scoreDiff = current.score - opponent.score;
  const pointsRemaining = maxPointsRemaining(state.balls, state.phase);

  // Can't win even if pot everything: must attack (or concede)
  if (scoreDiff < -pointsRemaining) {
    return { attack: true, reason: '落后太多，必须全力进攻', aggressionLevel: 1.0 };
  }

  // Already won mathematically: play safe
  if (scoreDiff > pointsRemaining) {
    return { attack: false, reason: '领先足够，控制局面', aggressionLevel: 0.1 };
  }

  // Close game, few points left: attack
  if (pointsRemaining < 30 && scoreDiff < 0) {
    return { attack: true, reason: '剩余分不多，落后方必须进攻', aggressionLevel: 0.9 };
  }

  // Check if easy pots available
  const legalTargets = getLegalTargetBalls(state);
  const easyPots = legalTargets.filter(t => getPotLineCount(state, t) >= 2);
  if (easyPots.length > 0) {
    return { attack: true, reason: '有好的进球机会', aggressionLevel: 0.7 };
  }

  // Default: balanced approach
  const aggression = 0.3 + (scoreDiff > 0 ? 0.1 : 0.3) +
    (pointsRemaining < 50 ? 0.2 : 0);
  return {
    attack: aggression > 0.5,
    reason: scoreDiff > 0 ? '小幅领先，稳扎稳打' : '小幅落后，适度进攻',
    aggressionLevel: Math.min(1, aggression),
  };
}

function maxPointsRemaining(balls: Ball[], phase: string): number {
  const redsOnTable = balls.filter(b => b.color === 'red' && !b.pocketed).length;
  if (phase === 'colors_phase' || redsOnTable === 0) {
    let total = 0;
    for (const color of COLORS_ORDER) {
      const ball = balls.find(b => b.color === color && !b.pocketed);
      if (ball) total += BALL_VALUES[color];
    }
    return total;
  }
  return redsOnTable * 8 + COLORS_ORDER.reduce((sum, c) => {
    const ball = balls.find(b => b.color === c && !b.pocketed);
    return sum + (ball ? BALL_VALUES[c] : 0);
  }, 0);
}

function cloneState(state: GameState): GameState {
  return {
    ...state,
    players: [{ ...state.players[0] }, { ...state.players[1] }],
    balls: state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    shotHistory: [...state.shotHistory],
    frameScores: state.frameScores.map(f => [...f]) as [number, number][],
    touchingBalls: [...state.touchingBalls],
  };
}

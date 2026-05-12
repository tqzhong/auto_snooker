// ============================================================
// Shared Strategy Logic
// Extracted from llm-engine.ts — used by all agents
// ============================================================

import type { Ball, BallColor, GameState, Vec2 } from '../types';
import { BALL_VALUES, COLORS_ORDER, MIN_FOUL_POINTS } from '../types';
import {
  TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS,
  POCKET_POSITIONS, POCKET_RADII,
} from '../engine/constants';
import { distanceBetween, angleBetween, simulateShot, applyShot } from '../engine/physics';
import type { SimulationResult } from '../engine/physics';

// ============================================================
// Ghost-ball & Pot Calculations
// ============================================================

/** Find the pocket nearest to a ball */
export function nearestPocket(ball: Ball): { pos: Vec2; radius: number; dist: number } {
  let best = { pos: { x: 0, y: 0 }, radius: 54, dist: Infinity };
  for (let i = 0; i < POCKET_POSITIONS.length; i++) {
    const px = POCKET_POSITIONS[i][0];
    const py = POCKET_POSITIONS[i][1];
    const dist = distanceBetween(ball.pos, { x: px, y: py });
    if (dist < best.dist) {
      best = { pos: { x: px, y: py }, radius: POCKET_RADII[i], dist };
    }
  }
  return best;
}

/** Calculate ghost-ball position for potting target into pocket */
export function calculateGhostBallPosition(targetBall: Ball, pocketPos: Vec2): Vec2 | null {
  const tpx = pocketPos.x - targetBall.pos.x;
  const tpy = pocketPos.y - targetBall.pos.y;
  const tpLen = Math.sqrt(tpx * tpx + tpy * tpy);
  if (tpLen === 0) return null;
  const tnx = tpx / tpLen;
  const tny = tpy / tpLen;
  return {
    x: targetBall.pos.x - tnx * BALL_RADIUS * 2,
    y: targetBall.pos.y - tny * BALL_RADIUS * 2,
  };
}

/** Calculate aim angle using ghost-ball method */
export function calculatePotAngle(cueBall: Ball, targetBall: Ball, pocketPos: Vec2): number {
  const ghost = calculateGhostBallPosition(targetBall, pocketPos);
  if (!ghost) return angleBetween(cueBall.pos, targetBall.pos);
  return angleBetween(cueBall.pos, ghost);
}

/** Calculate required power from distance (friction-based) */
export function distanceToPower(dist: number): number {
  const FRICTION = 450;
  const MAX_SPEED = 5000;
  const requiredSpeed = Math.sqrt(2 * FRICTION * dist) * 1.3;
  return Math.max(0.15, Math.min(1.0, requiredSpeed / MAX_SPEED));
}

// ============================================================
// Obstacle Avoidance
// ============================================================

function getFirstBallHitFromPoint(
  origin: Vec2, cueRadius: number, cueBallId: number,
  dir: Vec2, allBalls: Ball[],
): { ballId: number; distance: number } | null {
  let closestBallId: number | null = null;
  let closestDistance = Infinity;

  for (const ball of allBalls) {
    if (ball.pocketed || ball.id === cueBallId) continue;
    const toBall = { x: ball.pos.x - origin.x, y: ball.pos.y - origin.y };
    const projection = toBall.x * dir.x + toBall.y * dir.y;
    if (projection <= 0) continue;
    const radius = cueRadius + ball.radius;
    const centerDistSq = toBall.x * toBall.x + toBall.y * toBall.y;
    const discriminant = radius * radius - (centerDistSq - projection * projection);
    if (discriminant < -0.0001) continue;
    const entryDistance = projection - Math.sqrt(Math.max(0, discriminant));
    if (entryDistance < 0) continue;
    if (entryDistance < closestDistance) {
      closestDistance = entryDistance;
      closestBallId = ball.id;
    }
  }

  return closestBallId === null ? null : { ballId: closestBallId, distance: closestDistance };
}

function getFirstContactOnRay(cueBall: Ball, angle: number, allBalls: Ball[]): number | null {
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  return getFirstBallHitFromPoint(cueBall.pos, cueBall.radius, cueBall.id, dir, allBalls)?.ballId ?? null;
}

export function shotHitsTargetFirst(cueBall: Ball, targetBall: Ball, allBalls: Ball[], angle: number): boolean {
  return getFirstContactOnRay(cueBall, angle, allBalls) === targetBall.id;
}

function isPointInsidePlayableArea(point: Vec2, margin = BALL_RADIUS): boolean {
  return point.x >= margin && point.x <= TABLE_LENGTH - margin &&
    point.y >= margin && point.y <= TABLE_WIDTH - margin;
}

function isBallPathClear(
  from: Vec2, to: Vec2, movingBallRadius: number,
  allBalls: Ball[], ignoredIds: Set<number>,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return false;
  const ux = dx / dist;
  const uy = dy / dist;

  for (const ball of allBalls) {
    if (ball.pocketed || ignoredIds.has(ball.id)) continue;
    const bx = ball.pos.x - from.x;
    const by = ball.pos.y - from.y;
    const projection = bx * ux + by * uy;
    if (projection <= 0 || projection >= dist) continue;
    const perpDist = Math.abs(bx * (-uy) + by * ux);
    if (perpDist < movingBallRadius + ball.radius) return false;
  }
  return true;
}

export function isPotLineAvailable(cueBall: Ball, targetBall: Ball, pocketPos: Vec2, allBalls: Ball[]): boolean {
  const ghost = calculateGhostBallPosition(targetBall, pocketPos);
  if (!ghost || !isPointInsidePlayableArea(ghost, BALL_RADIUS * 0.5)) return false;
  const angle = angleBetween(cueBall.pos, ghost);
  if (!shotHitsTargetFirst(cueBall, targetBall, allBalls, angle)) return false;
  return isBallPathClear(
    targetBall.pos, pocketPos, targetBall.radius, allBalls,
    new Set([cueBall.id, targetBall.id]),
  );
}

// ============================================================
// Contact Angle Search
// ============================================================

/** Find a valid angle to hit the target ball, avoiding obstacles */
export function findContactAngle(
  state: GameState, targetBall: Ball,
): { angle: number; blocked: boolean } | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;

  const directAngle = angleBetween(cueBall.pos, targetBall.pos);
  const activeBalls = state.balls.filter(b => !b.pocketed);
  if (shotHitsTargetFirst(cueBall, targetBall, activeBalls, directAngle)) {
    return { angle: directAngle, blocked: false };
  }

  const dist = distanceBetween(cueBall.pos, targetBall.pos);
  if (dist <= cueBall.radius + targetBall.radius) {
    return { angle: directAngle, blocked: false };
  }

  const maxOffset = Math.asin(Math.min(0.999, (cueBall.radius + targetBall.radius) / dist));
  const steps = 32;
  for (let i = 1; i <= steps; i++) {
    const offset = maxOffset * (i / steps);
    for (const sign of [1, -1]) {
      const testAngle = directAngle + offset * sign;
      if (!shotHitsTargetFirst(cueBall, targetBall, activeBalls, testAngle)) continue;
      const testState = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
      applyShot(testState, testAngle, 0.3, 0, 0);
      const sim = simulateShot(testState, { generateFrames: false });
      if (sim.firstContactBallId === targetBall.id) {
        return { angle: testAngle, blocked: true };
      }
    }
  }

  return null;
}

// ============================================================
// Pot Simulation
// ============================================================

function simulateAndCheckPot(
  balls: Ball[], angle: number, power: number,
  spinX: number, spinY: number, targetBallId: number,
): { potted: boolean; simResult: SimulationResult } {
  const copy = balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
  applyShot(copy, angle, power, spinX, spinY);
  const simResult = simulateShot(copy, { generateFrames: false });
  const firstContactValid = simResult.firstContactBallId === targetBallId;
  const targetPotted = simResult.pottedBalls.some(b => b.id === targetBallId);
  return { potted: firstContactValid && targetPotted, simResult };
}

/** Find the best shot to pot a target ball */
export function calculateBestShot(
  state: GameState, targetBall: Ball, preferredPower: number,
  spinX = 0, spinY = 0,
): { angle: number; power: number; pocketIndex: number } | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;
  const activeBalls = state.balls.filter(b => !b.pocketed);

  const pockets = POCKET_POSITIONS.map((pos, i) => ({
    pos: { x: pos[0], y: pos[1] },
    radius: POCKET_RADII[i],
    dist: distanceBetween(targetBall.pos, { x: pos[0], y: pos[1] }),
    index: i,
  })).sort((a, b) => a.dist - b.dist);

  for (const pocket of pockets) {
    if (pocket.dist > TABLE_LENGTH * 0.8) continue;
    if (!isPotLineAvailable(cueBall, targetBall, pocket.pos, activeBalls)) continue;

    const angle = calculatePotAngle(cueBall, targetBall, pocket.pos);
    const powerLevels = [
      preferredPower,
      preferredPower * 0.8,
      preferredPower * 1.2,
      distanceToPower(distanceBetween(cueBall.pos, targetBall.pos)),
    ];

    for (const power of powerLevels) {
      const clamped = Math.max(0.15, Math.min(1.0, power));
      const { potted } = simulateAndCheckPot(state.balls, angle, clamped, spinX, spinY, targetBall.id);
      if (potted) return { angle, power: clamped, pocketIndex: pocket.index };
    }
  }

  return null;
}

/** Calculate a safety shot */
export function calculateSafetyShot(
  state: GameState, targetBall: Ball, preferredPower: number,
): { angle: number; power: number } | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;

  const contact = findContactAngle(state, targetBall);
  if (!contact) return null;

  const dist = distanceBetween(cueBall.pos, targetBall.pos);
  const power = Math.max(0.25, Math.min(0.7, preferredPower || distanceToPower(dist) * 0.7));
  return { angle: contact.angle, power };
}

// ============================================================
// Legal Target Calculations
// ============================================================

export function getAvailableTargets(state: GameState): { description: string; ballIds: number[] } {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed);
  const colorsOnTable = state.balls.filter(b =>
    COLORS_ORDER.includes(b.color as BallColor) && !b.pocketed
  );

  if (state.freeBall) {
    if (state.phase === 'break_off' || state.phase === 'reds_phase') {
      return { description: 'Free Ball — 提名一颗非红球作为红球', ballIds: colorsOnTable.map(b => b.id) };
    }
    if (state.phase === 'color_after_red') {
      return { description: 'Free Ball — 提名一颗非目标彩球作为彩球', ballIds: colorsOnTable.map(b => b.id) };
    }
    if (state.phase === 'colors_phase' && state.nextColorToPot) {
      return {
        description: `Free Ball — 提名一颗非${state.nextColorToPot}作为目标球`,
        ballIds: colorsOnTable.filter(b => b.color !== state.nextColorToPot).map(b => b.id),
      };
    }
  }

  if (state.phase === 'break_off' || state.phase === 'reds_phase') {
    // §3(g): Until all Reds are off the table, Red is the ball on
    return { description: '必须先碰红球', ballIds: redsOnTable.map(b => b.id) };
  }

  if (state.phase === 'color_after_red') {
    // §3(h)(i): After potting a red, next ball on is a colour of striker's choice
    return { description: '进球红球后，可选择任意彩球', ballIds: colorsOnTable.map(b => b.id) };
  }

  if (state.phase === 'colors_phase' && state.nextColorToPot) {
    const target = state.balls.find(b => b.color === state.nextColorToPot && !b.pocketed);
    if (target) return { description: `必须先碰${state.nextColorToPot}`, ballIds: [target.id] };
  }

  return { description: '红球', ballIds: redsOnTable.map(b => b.id) };
}

export function getLegalTargetBalls(state: GameState): Ball[] {
  const available = getAvailableTargets(state);
  return state.balls.filter(b => available.ballIds.includes(b.id) && !b.pocketed);
}

export function getDirectlyPlayableTargetBalls(state: GameState): Ball[] {
  return getLegalTargetBalls(state).filter(target => findContactAngle(state, target) !== null);
}

export function getPotLineCount(state: GameState, targetBall: Ball): number {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return 0;
  const activeBalls = state.balls.filter(b => !b.pocketed);
  return POCKET_POSITIONS.filter(pos =>
    isPotLineAvailable(cueBall, targetBall, { x: pos[0], y: pos[1] }, activeBalls)
  ).length;
}

/** Find any legal contact shot (including cushion escapes) */
export function findAnyLegalContactShot(
  state: GameState, preferredPower: number,
): { targetBallId: number; angle: number; power: number } | null {
  const legalIds = new Set(getLegalTargetBalls(state).map(b => b.id));
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall || legalIds.size === 0) return null;

  const directTargets = getDirectlyPlayableTargetBalls(state);
  for (const target of directTargets) {
    const safety = calculateSafetyShot(state, target, preferredPower);
    if (safety) return { targetBallId: target.id, angle: safety.angle, power: safety.power };
  }

  // Search for cushion escape
  const powerLevels = [Math.max(0.35, Math.min(0.9, preferredPower || 0.55)), 0.5, 0.7, 0.9];
  const steps = 240;
  const activeBalls = state.balls.filter(b => !b.pocketed);

  for (const power of powerLevels) {
    for (let i = 0; i < steps; i++) {
      const angle = (Math.PI * 2 * i) / steps;
      const testState = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
      applyShot(testState, angle, power, 0, 0);
      const sim = simulateShot(testState, { generateFrames: false });

      if (sim.firstContactBallId !== null && legalIds.has(sim.firstContactBallId)) {
        return { targetBallId: sim.firstContactBallId, angle, power };
      }
    }
  }

  return null;
}

// ============================================================
// Helper descriptions
// ============================================================

export function describeStrategy(strategy: 'attack' | 'safety' | 'snooker'): string {
  if (strategy === 'attack') return '进攻';
  if (strategy === 'snooker') return '做斯诺克';
  return '防守';
}

export function describeSpin(spinX: number, spinY: number): string {
  const side = spinX < -0.05 ? `左塞${Math.abs(spinX).toFixed(2)}` :
    spinX > 0.05 ? `右塞${spinX.toFixed(2)}` : '中杆';
  const vertical = spinY < -0.05 ? `低杆${Math.abs(spinY).toFixed(2)}` :
    spinY > 0.05 ? `高杆${spinY.toFixed(2)}` : '中杆';
  return `${vertical}/${side}`;
}

/** Count escape angles for a snookered position */
export function countEscapeAngles(cueBall: Ball, targetBalls: Ball[], allBalls: Ball[]): number {
  let escapes = 0;
  const steps = 72;
  for (let i = 0; i < steps; i++) {
    const angle = (Math.PI * 2 * i) / steps;
    const contact = getFirstContactOnRay(cueBall, angle, allBalls);
    if (contact !== null && targetBalls.some(t => t.id === contact)) {
      escapes++;
    }
  }
  return escapes;
}

/** Evaluate snooker quality: fewer escape angles = better snooker */
export function evaluateSnookerQuality(
  state: GameState, cueBallFinalPos: Vec2, targetBalls: Ball[],
): number {
  const allBalls = state.balls.filter(b => !b.pocketed).map(b => {
    if (b.color === 'white') return { ...b, pos: { ...cueBallFinalPos } };
    return { ...b };
  });
  const cueBall = allBalls.find(b => b.color === 'white')!;
  const escapes = countEscapeAngles(cueBall, targetBalls, allBalls);
  return Math.max(0, 100 - escapes * 15);
}

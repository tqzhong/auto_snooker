// ============================================================
// LLM Decision Engine
// LLM decides strategy → physics engine calculates angle & power
// ============================================================

import type { GameState, LLMDecision, Ball, BallColor, Vec2, ShotRecord } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import {
  TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS,
  POCKET_POSITIONS, POCKET_RADII,
} from '../engine/constants';
import {
  distanceBetween, angleBetween, simulateShot, applyShot,
  createInitialBalls,
} from '../engine/physics';
import type { SimulationResult } from '../engine/physics';
import { maxPointsRemaining } from '../engine/rules';

// API config from environment
const ENV = import.meta.env || {};
const API_KEY = ENV.VITE_AI_API_KEY || '';
const BASE_URL = ENV.VITE_AI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
const MODEL = ENV.VITE_AI_MODEL || 'mimo-v2.5-pro';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================================
// LLM output: only strategy, not precise angles
// ============================================================

interface LLMStrategyChoice {
  targetBallId: number;
  power: number;
  spinX: number;
  spinY: number;
  strategy: 'attack' | 'safety' | 'snooker';
  reasoning: string;
  source: 'llm' | 'fallback';
}

// ============================================================
// Physics: calculate exact aim angle and power
// ============================================================

/** Find the pocket nearest to a ball */
function nearestPocket(ball: Ball): { pos: Vec2; radius: number; dist: number } {
  let best = { pos: { x: 0, y: 0 }, radius: 54, dist: Infinity };
  for (let i = 0; i < POCKET_POSITIONS.length; i++) {
    const px = POCKET_POSITIONS[i][0];
    const py = POCKET_POSITIONS[i][1];
    const dx = ball.pos.x - px;
    const dy = ball.pos.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < best.dist) {
      best = { pos: { x: px, y: py }, radius: POCKET_RADII[i], dist };
    }
  }
  return best;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function describeStrategy(strategy: 'attack' | 'safety' | 'snooker'): string {
  if (strategy === 'attack') return '进攻';
  if (strategy === 'snooker') return '做斯诺克';
  return '防守';
}

function describeSpin(spinX: number, spinY: number): string {
  const side = spinX < -0.05 ? `左塞${Math.abs(spinX).toFixed(2)}` :
    spinX > 0.05 ? `右塞${spinX.toFixed(2)}` : '中杆';
  const vertical = spinY < -0.05 ? `低杆${Math.abs(spinY).toFixed(2)}` :
    spinY > 0.05 ? `高杆${spinY.toFixed(2)}` : '中杆';
  return `${vertical}/${side}`;
}

function parseTargetBallId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const match = value.match(/-?\d+/);
    if (match) return Number.parseInt(match[0], 10);
  }
  return null;
}

function normalizeStrategy(value: unknown): 'attack' | 'safety' | 'snooker' {
  if (typeof value !== 'string') return 'attack';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'safety' || normalized.includes('safe') || normalized.includes('防守')) return 'safety';
  if (normalized === 'snooker' || normalized.includes('斯诺克')) return 'snooker';
  return 'attack';
}

function parseLLMJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
}

function formatDecisionAnalysis(
  strategy: LLMStrategyChoice,
  targetBall: Ball,
  finalStrategy: 'attack' | 'safety' | 'snooker',
  details: string,
): string {
  const source = strategy.source === 'llm' ? 'LLM' : 'Fallback';
  return `[${source}] ${describeStrategy(finalStrategy)} ${targetBall.color}#${targetBall.id} ` +
    `power=${strategy.power.toFixed(2)} 杆法=${describeSpin(strategy.spinX, strategy.spinY)}。` +
    `${details}${strategy.reasoning ? ` 分析: ${strategy.reasoning}` : ''}`;
}

/**
 * Calculate the aim angle to pot a target ball into a specific pocket.
 * Uses the "ghost ball" method:
 *   - Find where the cue ball must contact the target ball
 *     so that the target ball travels toward the pocket center.
 *   - The contact point is along the line from pocket to target,
 *     offset by one ball radius.
 *   - The cue ball aims at this contact point.
 */
function calculatePotAngle(
  cueBall: Ball,
  targetBall: Ball,
  pocketPos: Vec2,
): number {
  const ghost = calculateGhostBallPosition(targetBall, pocketPos);
  if (!ghost) return angleBetween(cueBall.pos, targetBall.pos);

  // Aim from cue ball to ghost ball
  return angleBetween(cueBall.pos, ghost);
}

function calculateGhostBallPosition(targetBall: Ball, pocketPos: Vec2): Vec2 | null {
  // Direction from target ball to pocket
  const tpx = pocketPos.x - targetBall.pos.x;
  const tpy = pocketPos.y - targetBall.pos.y;
  const tpLen = Math.sqrt(tpx * tpx + tpy * tpy);
  if (tpLen === 0) return null;

  // Unit vector from target to pocket
  const tnx = tpx / tpLen;
  const tny = tpy / tpLen;

  // Ghost ball position: one ball radius behind target ball (opposite pocket direction)
  const ghostX = targetBall.pos.x - tnx * BALL_RADIUS * 2;
  const ghostY = targetBall.pos.y - tny * BALL_RADIUS * 2;

  return { x: ghostX, y: ghostY };
}

/**
 * Calculate required power to send the cue ball a given distance.
 * Based on: speed = sqrt(2 * friction * distance)
 * Returns power as a fraction of MAX_CUE_SPEED.
 */
function distanceToPower(dist: number): number {
  // From friction: v^2 = 2 * a * d, where a = FRICTION_DECELERATION = 450 mm/s^2
  // We want the cue ball to arrive with some remaining speed for ball transfer
  const FRICTION = 450;
  const MAX_SPEED = 5000;
  const requiredSpeed = Math.sqrt(2 * FRICTION * dist) * 1.3; // 1.3x margin
  return Math.max(0.15, Math.min(1.0, requiredSpeed / MAX_SPEED));
}

/**
 * Return which object ball a cue-ball ray would contact first.
 * Each object ball is expanded by cue radius + object radius, so this models
 * the legal first-contact line, including thin edge contacts.
 */
function getFirstBallHitFromPoint(
  origin: Vec2,
  cueRadius: number,
  cueBallId: number,
  dir: Vec2,
  allBalls: Ball[],
): { ballId: number; distance: number } | null {
  let closestBallId: number | null = null;
  let closestDistance = Infinity;

  for (const ball of allBalls) {
    if (ball.pocketed || ball.id === cueBallId) continue;

    const toBall = {
      x: ball.pos.x - origin.x,
      y: ball.pos.y - origin.y,
    };
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

function getFirstContactOnRay(
  cueBall: Ball,
  angle: number,
  allBalls: Ball[],
): number | null {
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  return getFirstBallHitFromPoint(cueBall.pos, cueBall.radius, cueBall.id, dir, allBalls)?.ballId ?? null;
}

function getFirstContactAfterCushions(
  cueBall: Ball,
  angle: number,
  allBalls: Ball[],
  maxBounces = 3,
): number | null {
  let pos = { ...cueBall.pos };
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const minX = cueBall.radius;
  const maxX = TABLE_LENGTH - cueBall.radius;
  const minY = cueBall.radius;
  const maxY = TABLE_WIDTH - cueBall.radius;

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const ballHit = getFirstBallHitFromPoint(pos, cueBall.radius, cueBall.id, dir, allBalls);
    let cushionDistance = Infinity;
    let reflectX = false;
    let reflectY = false;

    if (dir.x > 0) {
      cushionDistance = (maxX - pos.x) / dir.x;
      reflectX = true;
    } else if (dir.x < 0) {
      cushionDistance = (minX - pos.x) / dir.x;
      reflectX = true;
    }

    if (dir.y > 0) {
      const yDistance = (maxY - pos.y) / dir.y;
      if (yDistance < cushionDistance) {
        cushionDistance = yDistance;
        reflectX = false;
        reflectY = true;
      } else if (Math.abs(yDistance - cushionDistance) < 0.0001) {
        reflectY = true;
      }
    } else if (dir.y < 0) {
      const yDistance = (minY - pos.y) / dir.y;
      if (yDistance < cushionDistance) {
        cushionDistance = yDistance;
        reflectX = false;
        reflectY = true;
      } else if (Math.abs(yDistance - cushionDistance) < 0.0001) {
        reflectY = true;
      }
    }

    if (ballHit && ballHit.distance <= cushionDistance) {
      return ballHit.ballId;
    }
    if (!Number.isFinite(cushionDistance) || cushionDistance <= 0) return null;

    pos = {
      x: pos.x + dir.x * cushionDistance,
      y: pos.y + dir.y * cushionDistance,
    };
    if (reflectX) dir.x *= -1;
    if (reflectY) dir.y *= -1;
    pos.x += dir.x * 0.01;
    pos.y += dir.y * 0.01;
  }

  return null;
}

function shotHitsTargetFirst(
  cueBall: Ball,
  targetBall: Ball,
  allBalls: Ball[],
  angle: number,
): boolean {
  return getFirstContactOnRay(cueBall, angle, allBalls) === targetBall.id;
}

function isPointInsidePlayableArea(point: Vec2, margin = BALL_RADIUS): boolean {
  return point.x >= margin &&
    point.x <= TABLE_LENGTH - margin &&
    point.y >= margin &&
    point.y <= TABLE_WIDTH - margin;
}

function isBallPathClear(
  from: Vec2,
  to: Vec2,
  movingBallRadius: number,
  allBalls: Ball[],
  ignoredIds: Set<number>,
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
    if (perpDist < movingBallRadius + ball.radius) {
      return false;
    }
  }

  return true;
}

function isPotLineAvailable(
  cueBall: Ball,
  targetBall: Ball,
  pocketPos: Vec2,
  allBalls: Ball[],
): boolean {
  const ghost = calculateGhostBallPosition(targetBall, pocketPos);
  if (!ghost || !isPointInsidePlayableArea(ghost, BALL_RADIUS * 0.5)) return false;

  const angle = angleBetween(cueBall.pos, ghost);
  if (!shotHitsTargetFirst(cueBall, targetBall, allBalls, angle)) return false;

  return isBallPathClear(
    targetBall.pos,
    pocketPos,
    targetBall.radius,
    allBalls,
    new Set([cueBall.id, targetBall.id]),
  );
}

/**
 * Simulate a shot and verify:
 * 1. The cue ball FIRST contacts the target ball (not another ball)
 * 2. The target ball ends up in a pocket
 * Both conditions must be met for a valid pot.
 */
function simulateAndCheckPot(
  balls: Ball[],
  angle: number,
  power: number,
  spinX: number,
  spinY: number,
  targetBallId: number,
): { potted: boolean; simResult: SimulationResult } {
  const copy = balls.map(b => ({
    ...b,
    pos: { ...b.pos },
    vel: { ...b.vel },
  }));

  applyShot(copy, angle, power, spinX, spinY);
  const simResult = simulateShot(copy);

  // Critical: first contact must be the target ball
  const firstContactValid = simResult.firstContactBallId === targetBallId;
  // Target ball must be potted
  const targetPotted = simResult.pottedBalls.some(b => b.id === targetBallId);

  return { potted: firstContactValid && targetPotted, simResult };
}

/**
 * For a given target ball, find the best pocket to aim for.
 * Uses LLM's preferred power, verifies via simulation.
 * Falls back to nearby power levels if LLM's power doesn't pot.
 */
function calculateBestShot(
  state: GameState,
  targetBall: Ball,
  preferredPower: number,
  spinX = 0,
  spinY = 0,
): { angle: number; power: number; pocketIndex: number } | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;
  const activeBalls = state.balls.filter(b => !b.pocketed);

  // Get all 6 pockets, sorted by distance to target ball
  const pockets = POCKET_POSITIONS.map((pos, i) => ({
    pos: { x: pos[0], y: pos[1] },
    radius: POCKET_RADII[i],
    dist: distanceBetween(targetBall.pos, { x: pos[0], y: pos[1] }),
    index: i,
  })).sort((a, b) => a.dist - b.dist);

  // Try each pocket (nearest first), find one that works
  for (const pocket of pockets) {
    if (pocket.dist > TABLE_LENGTH * 0.8) continue;

    if (!isPotLineAvailable(cueBall, targetBall, pocket.pos, activeBalls)) {
      continue;
    }

    // Calculate ghost-ball aim angle
    const angle = calculatePotAngle(cueBall, targetBall, pocket.pos);

    // Try LLM's preferred power first, then fallback levels
    const powerLevels = [
      preferredPower,
      preferredPower * 0.8,
      preferredPower * 1.2,
      distanceToPower(distanceBetween(cueBall.pos, targetBall.pos)), // physics-calculated fallback
    ];

    for (const power of powerLevels) {
      const clamped = Math.max(0.15, Math.min(1.0, power));
      const { potted } = simulateAndCheckPot(state.balls, angle, clamped, spinX, spinY, targetBall.id);
      if (potted) {
        return { angle, power: clamped, pocketIndex: pocket.index };
      }
    }
  }

  return null; // No pot possible
}

/**
 * Find a valid angle to hit the target ball, avoiding obstacles.
 * Tries centre-ball first, then searches only within the target's contact cone.
 * Returns null instead of falling back to a blocked direct shot.
 */
function findContactAngle(
  state: GameState,
  targetBall: Ball,
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

      // Verify with low-power simulation: does the cue ball hit the target first?
      const testState = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
      applyShot(testState, testAngle, 0.3, 0, 0);
      const sim = simulateShot(testState);

      if (sim.firstContactBallId === targetBall.id) {
        return { angle: testAngle, blocked: true };
      }
    }
  }

  return null;
}

/**
 * For safety shots: find a valid angle that contacts the target ball first,
 * then use medium power to leave the cue ball in a safe position.
 */
function calculateSafetyShot(
  state: GameState,
  targetBall: Ball,
  preferredPower: number,
): { angle: number; power: number } | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;

  const contact = findContactAngle(state, targetBall);
  if (!contact) return null;

  const dist = distanceBetween(cueBall.pos, targetBall.pos);
  const power = Math.max(0.25, Math.min(0.7, preferredPower || distanceToPower(dist) * 0.7));

  return { angle: contact.angle, power };
}

function getLegalTargetBalls(state: GameState): Ball[] {
  const available = getAvailableTargets(state);
  return state.balls.filter(b => available.ballIds.includes(b.id) && !b.pocketed);
}

function getDirectlyPlayableTargetBalls(state: GameState): Ball[] {
  return getLegalTargetBalls(state).filter(target => findContactAngle(state, target) !== null);
}

function getPotLineCount(state: GameState, targetBall: Ball): number {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return 0;

  const activeBalls = state.balls.filter(b => !b.pocketed);
  return POCKET_POSITIONS.filter(pos =>
    isPotLineAvailable(cueBall, targetBall, { x: pos[0], y: pos[1] }, activeBalls)
  ).length;
}

function findAnyLegalContactShot(
  state: GameState,
  preferredPower: number,
): { targetBallId: number; angle: number; power: number } | null {
  const legalIds = new Set(getLegalTargetBalls(state).map(b => b.id));
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;
  if (legalIds.size === 0) return null;

  const directTargets = getDirectlyPlayableTargetBalls(state);
  for (const target of directTargets) {
    const safety = calculateSafetyShot(state, target, preferredPower);
    if (safety) {
      return { targetBallId: target.id, angle: safety.angle, power: safety.power };
    }
  }

  // If snookered, search for a cushion escape that first contacts any ball-on.
  const powerLevels = [
    Math.max(0.35, Math.min(0.9, preferredPower || 0.55)),
    0.5,
    0.7,
    0.9,
  ];
  const steps = 240;
  const activeBalls = state.balls.filter(b => !b.pocketed);

  for (const power of powerLevels) {
    for (let i = 0; i < steps; i++) {
      const angle = (Math.PI * 2 * i) / steps;
      const firstContact = getFirstContactAfterCushions(cueBall, angle, activeBalls);

      if (firstContact !== null && legalIds.has(firstContact)) {
        const testState = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
        applyShot(testState, angle, power, 0, 0);
        const sim = simulateShot(testState);

        if (sim.firstContactBallId !== null && legalIds.has(sim.firstContactBallId)) {
          return { targetBallId: sim.firstContactBallId, angle, power };
        }
      }
    }
  }

  return null;
}

function chooseFallbackSpin(
  strategy: 'attack' | 'safety' | 'snooker',
  cueBall: Ball,
  targetBall: Ball,
): { spinX: number; spinY: number } {
  const dist = distanceBetween(cueBall.pos, targetBall.pos);
  if (strategy === 'attack') {
    return {
      spinX: 0,
      spinY: dist < 900 ? -0.15 : 0.18,
    };
  }

  const sideToOpenTable = targetBall.pos.y >= TABLE_WIDTH / 2 ? -0.25 : 0.25;
  return {
    spinX: sideToOpenTable,
    spinY: -0.1,
  };
}

// ============================================================
// LLM: only decides strategy (which ball, attack/safety)
// ============================================================

function formatShotHistory(history: ShotRecord[], players: [string, string]): string {
  if (history.length === 0) return '暂无';
  const recent = history.slice(-5);
  return recent.map((s, i) => {
    const player = players[s.playerIndex];
    const result = s.result.pointsScored > 0
      ? `+${s.result.pointsScored}分`
      : s.result.fouls.length > 0
        ? `犯规(${s.result.fouls[0]?.description})`
        : '未进球';
    return `${i + 1}. ${player}: ${result}`;
  }).join(' | ');
}

function formatBallState(balls: Ball[]): string {
  const active = balls.filter(b => !b.pocketed);
  const reds = active.filter(b => b.color === 'red');
  const colors = active.filter(b => b.color !== 'red' && b.color !== 'white');
  const cue = active.find(b => b.color === 'white');

  let desc = '';
  desc += `白球(${cue ? `${Math.round(cue.pos.x)},${Math.round(cue.pos.y)}` : '袋中'})`;
  desc += `\n红球(${reds.length}): ${reds.map(b => `#${b.id}`).join(' ')}`;
  desc += `\n彩球: ${colors.map(b => `${b.color}#${b.id}`).join(' ')}`;
  return desc;
}

function buildSystemPrompt(): string {
  return `You are a snooker shot selector. Return exactly one valid JSON object and no markdown.

Required JSON schema:
{
  "targetBallId": 2,
  "power": 0.45,
  "spinX": 0,
  "spinY": 0,
  "strategy": "attack",
  "reasoning": "中文简短分析"
}

Rules:
- targetBallId must be an integer from the legal target ids only. Do not include color names.
- power must be a number from 0.15 to 1.0.
- spinX must be a number from -1 to 1. Negative means left side, positive means right side.
- spinY must be a number from -1 to 1. Negative means back/draw, positive means top/follow.
- strategy must be exactly one of: "attack", "safety", "snooker".
- Aggressive style: choose "attack" whenever any legal target has 可进袋线路 greater than 0.
- Choose "safety" or "snooker" only when every legal target has 可进袋线路0条 or is blocked.
- Prefer a harder pot over safety when the target is legal and has a clear pot line.
- The physics engine will calculate the exact aim angle. You choose target, strategy, power, and spin only.
- Free Ball: when active, you can legally hit ANY ball. Prioritize high-value balls (black=7, pink=6).
- Miss warning: avoid consecutive misses. If miss count >= 2, play safer shots.
- Score-aware: if leading significantly, prefer safety. If trailing with few points left, attack aggressively.`;
}

function buildUserPrompt(state: GameState): string {
  const current = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];
  const available = getAvailableTargets(state);
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);

  // Build target info with pocket proximity
  let targetInfo = '';
  if (cueBall) {
    const targets = state.balls.filter(b =>
      available.ballIds.includes(b.id) && !b.pocketed
    );
    const targetDetails = targets.map(t => {
      const np = nearestPocket(t);
      const distToPocket = Math.round(np.dist);
      const distToCue = Math.round(distanceBetween(cueBall.pos, t.pos));
      const contact = findContactAngle(state, t);
      const potCount = getPotLineCount(state, t);
      const contactStatus = contact
        ? contact.blocked ? '薄边可第一碰撞' : '中心可第一碰撞'
        : '被挡，不能直接选';
      return `#${t.id}(${t.color}) ${contactStatus} 可进袋线路${potCount}条 距袋口${distToPocket}mm 距白球${distToCue}mm`;
    });
    targetInfo = targetDetails.join('\n');
  }

  // Calculate distances for power reference
  let distInfo = '';
  if (cueBall) {
    const targets = state.balls.filter(b => available.ballIds.includes(b.id) && !b.pocketed);
    distInfo = targets.map(t => {
      const dist = Math.round(distanceBetween(cueBall.pos, t.pos));
      return `#${t.id}(${t.color}) 距白球${dist}mm`;
    }).join(' | ');
  }

  // Free ball, miss, touching ball, score context
  let contextInfo = '';
  if (state.freeBall) {
    contextInfo += `\n🟢 Free Ball 激活！需选择一个非当前目标球作为提名自由球，先碰该球，或让该球与目标球同时首碰。`;
  }
  if (state.missCount > 0) {
    contextInfo += `\n⚠️ 连续Miss: ${state.missCount}。若对手要求从原位重打并已警告，再次失败可能被判负；请选择更稳妥的出杆。`;
  }
  if (state.touchingBalls.length > 0) {
    const touchingNames = state.touchingBalls.map(id => {
      const ball = state.balls.find(b => b.id === id);
      return ball ? ball.color : `#${id}`;
    });
    contextInfo += `\n🔵 母球接触中: ${touchingNames.join(', ')}。必须合法离开。`;
  }

  const scoreDiff = current.score - opponent.score;
  const pointsRemaining = maxPointsRemaining(state.balls, state.phase);
  if (scoreDiff > pointsRemaining) {
    contextInfo += `\n📊 领先${scoreDiff}分，剩余${pointsRemaining}分。优势明显，考虑防守。`;
  } else if (scoreDiff < -20) {
    contextInfo += `\n📊 落后${Math.abs(scoreDiff)}分，剩余${pointsRemaining}分。需要积极进攻。`;
  }

  return `Current player: ${current.name}, score ${current.score}, opponent ${opponent.score}.
Phase: ${state.phase}
Table: ${formatBallState(state.balls)}
Legal target rule: ${available.description}
Legal target details:
${targetInfo}
Distance reference: ${distInfo}
Recent history: ${formatShotHistory(state.shotHistory, [state.players[0].name, state.players[1].name])}${contextInfo}

Return valid JSON only. Aggressive style: if any legal target has 可进袋线路 > 0, choose attack and select one of those targets.`;
}

function getAvailableTargets(state: GameState): { description: string; ballIds: number[] } {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed);
  const colorsOnTable = state.balls.filter(b => COLORS_ORDER.includes(b.color as BallColor) && !b.pocketed);

  if (state.freeBall) {
    if (state.phase === 'break_off' || state.phase === 'reds_phase') {
      return {
        description: 'Free Ball — 提名一颗非红球作为红球',
        ballIds: colorsOnTable.map(b => b.id),
      };
    }
    if (state.phase === 'color_after_red') {
      return {
        description: 'Free Ball — 提名一颗非目标彩球作为彩球',
        ballIds: colorsOnTable.map(b => b.id),
      };
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
    return {
      description: '必须先碰红球',
      ballIds: redsOnTable.map(b => b.id),
    };
  }

  if (state.phase === 'color_after_red') {
    // §3(h)(i): After potting a red, next ball on is a colour of striker's choice
    const colors = state.balls.filter(b => COLORS_ORDER.includes(b.color as BallColor) && !b.pocketed);
    return {
      description: '进球红球后，可选择任意彩球',
      ballIds: colors.map(b => b.id),
    };
  }

  if (state.phase === 'colors_phase' && state.nextColorToPot) {
    const target = state.balls.find(b => b.color === state.nextColorToPot && !b.pocketed);
    if (target) {
      return {
        description: `必须先碰${state.nextColorToPot}`,
        ballIds: [target.id],
      };
    }
  }

  return { description: '红球', ballIds: redsOnTable.map(b => b.id) };
}

// ============================================================
// Main decision function: LLM picks target → physics calculates shot
// ============================================================

export async function getAIMoveDecision(state: GameState): Promise<LLMDecision> {
  // Step 1: Get strategy from LLM (or fallback)
  const strategy = await getLLMStrategy(state);

  // Step 2: Find the target ball
  const targetBall = state.balls.find(b => b.id === strategy.targetBallId && !b.pocketed);
  if (!targetBall) {
    return getFallbackDecision(state);
  }

  const directContact = findContactAngle(state, targetBall);
  const forcedAttack = strategy.strategy !== 'attack' && getPotLineCount(state, targetBall) > 0;

  // Step 3: Calculate precise angle via physics, use LLM's power
  if (strategy.strategy === 'attack' || forcedAttack) {
    const shot = calculateBestShot(state, targetBall, strategy.power, strategy.spinX, strategy.spinY);
    if (shot) {
      const detailPrefix = forcedAttack
        ? `agent选择${describeStrategy(strategy.strategy)}，但当前目标有可进袋线路，进攻风格强制转进攻。`
        : '';
      return {
        targetBallId: strategy.targetBallId,
        aimAngle: shot.angle,
        power: shot.power,
        spinX: strategy.spinX,
        spinY: strategy.spinY,
        strategy: 'attack',
        reasoning: formatDecisionAnalysis(strategy, targetBall, 'attack', `${detailPrefix}进攻袋口${shot.pocketIndex}，ghost-ball线路和目标球进袋路线均无遮挡。`),
      };
    }
    // No pot possible → find a valid contact angle, use as safety
    if (!directContact) {
      return getFallbackDecision(state);
    }
    return {
      targetBallId: strategy.targetBallId,
      aimAngle: directContact.angle,
      power: Math.max(0.3, strategy.power * 0.8),
      spinX: strategy.spinX,
      spinY: strategy.spinY,
      strategy: 'safety',
      reasoning: formatDecisionAnalysis(strategy, targetBall, 'safety', '未找到可验证进球袋口，改为先合法碰目标球并控制母球。'),
    };
  }

  // Safety or snooker: find a valid contact angle avoiding obstacles
  if (!directContact) {
    return getFallbackDecision(state);
  }
  return {
    targetBallId: strategy.targetBallId,
    aimAngle: directContact.angle,
    power: strategy.power,
    spinX: strategy.spinX,
    spinY: strategy.spinY,
    strategy: strategy.strategy,
    reasoning: formatDecisionAnalysis(strategy, targetBall, strategy.strategy, '按agent选择执行防守/做球，物理引擎自动取合法第一碰撞角度。'),
  };
}

/** Get LLM strategy choice only (no angle/power) */
async function getLLMStrategy(state: GameState): Promise<LLMStrategyChoice> {
  if (!API_KEY) {
    return getFallbackStrategy(state, '未配置 VITE_AI_API_KEY');
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(state);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.35,
        max_tokens: 900,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.error('LLM API error:', response.status);
      return getFallbackStrategy(state, `LLM API错误 ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    const parsed = parseLLMJson(content);
    if (!parsed) {
      console.error('Failed to parse LLM JSON:', content);
      return getFallbackStrategy(state, 'LLM响应不是JSON');
    }

    const targetBallId = parseTargetBallId(parsed.targetBallId);
    if (targetBallId === null) {
      return getFallbackStrategy(state, 'LLM未返回数字targetBallId');
    }

    // Validate target is legal
    const available = getAvailableTargets(state);
    if (!available.ballIds.includes(targetBallId)) {
      console.warn(`LLM chose illegal target #${targetBallId}, using fallback`);
      return getFallbackStrategy(state, `LLM选择非法目标#${targetBallId}`);
    }

    const chosenTarget = state.balls.find(b => b.id === targetBallId && !b.pocketed);
    if (chosenTarget && findContactAngle(state, chosenTarget) === null) {
      console.warn(`LLM chose blocked target #${targetBallId}, using fallback`);
      return getFallbackStrategy(state, `LLM选择被遮挡目标#${targetBallId}`);
    }

    return {
      targetBallId,
      power: typeof parsed.power === 'number' ? Math.max(0.15, Math.min(1.0, parsed.power)) : 0.5,
      spinX: typeof parsed.spinX === 'number' ? clampUnit(parsed.spinX) : 0,
      spinY: typeof parsed.spinY === 'number' ? clampUnit(parsed.spinY) : 0,
      strategy: normalizeStrategy(parsed.strategy),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      source: 'llm',
    };
  } catch (err) {
    console.error('LLM call failed:', err);
    return getFallbackStrategy(state, `LLM调用失败: ${err instanceof Error ? err.message : '未知错误'}`);
  }
}

function getFallbackStrategy(state: GameState, fallbackReason = '本地兜底策略'): LLMStrategyChoice {
  const available = getAvailableTargets(state);
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) {
    return { targetBallId: available.ballIds[0] || 0, power: 0.5, spinX: 0, spinY: 0, strategy: 'attack', reasoning: `${fallbackReason}；没有找到白球，使用兜底目标。`, source: 'fallback' };
  }

  const legalTargets = state.balls.filter(b =>
    available.ballIds.includes(b.id) && !b.pocketed
  );
  const targets = getDirectlyPlayableTargetBalls(state);

  if (legalTargets.length === 0) {
    return { targetBallId: available.ballIds[0] || 0, power: 0.4, spinX: 0, spinY: 0, strategy: 'safety', reasoning: `${fallbackReason}；当前没有可用合法目标。`, source: 'fallback' };
  }
  if (targets.length === 0) {
    const spin = chooseFallbackSpin('safety', cueBall, legalTargets[0]);
    return { targetBallId: legalTargets[0].id, power: 0.7, ...spin, strategy: 'safety', reasoning: `${fallbackReason}；所有合法目标被挡，搜索解斯诺克线路。`, source: 'fallback' };
  }

  // Aggressive fallback: if any legal target has a verified pot line, attack it.
  let bestTarget = targets[0];
  let bestPotCount = -1;
  let bestPocketDist = Infinity;
  for (const t of targets) {
    const potCount = getPotLineCount(state, t);
    const np = nearestPocket(t);
    if (potCount > bestPotCount || (potCount === bestPotCount && np.dist < bestPocketDist)) {
      bestPotCount = potCount;
      bestPocketDist = np.dist;
      bestTarget = t;
    }
  }

  const hasPotLine = bestPotCount > 0;
  const strategy = hasPotLine ? 'attack' : 'safety';
  const spin = chooseFallbackSpin(strategy, cueBall, bestTarget);
  return {
    targetBallId: bestTarget.id,
    power: hasPotLine ? Math.max(0.42, distanceToPower(distanceBetween(cueBall.pos, bestTarget.pos))) : 0.55,
    ...spin,
    strategy,
    reasoning: hasPotLine
      ? `${fallbackReason}；${bestTarget.color}#${bestTarget.id} 有${bestPotCount}条可验证进球线路，进攻风格优先进攻。`
      : `${fallbackReason}；没有可验证进球线路，才转防守。`,
    source: 'fallback',
  };
}

/** Fallback full decision (used when physics calc fails) */
export function getFallbackDecision(state: GameState): LLMDecision {
  const strategy = getFallbackStrategy(state);
  const targetBall = state.balls.find(b => b.id === strategy.targetBallId && !b.pocketed);

  if (targetBall && strategy.strategy === 'attack') {
    const shot = calculateBestShot(state, targetBall, strategy.power, strategy.spinX, strategy.spinY);
    if (shot) {
      return {
        targetBallId: strategy.targetBallId,
        aimAngle: shot.angle,
        power: shot.power,
        spinX: strategy.spinX,
        spinY: strategy.spinY,
        strategy: 'attack',
        reasoning: formatDecisionAnalysis(strategy, targetBall, 'attack', 'fallback进攻线路模拟通过。'),
      };
    }
  }

  if (targetBall) {
    const safety = calculateSafetyShot(state, targetBall, strategy.power);
    if (safety) {
      return {
        targetBallId: strategy.targetBallId,
        aimAngle: safety.angle,
        power: safety.power,
        spinX: strategy.spinX,
        spinY: strategy.spinY,
        strategy: 'safety',
        reasoning: formatDecisionAnalysis(strategy, targetBall, 'safety', 'fallback选择合法第一碰撞防守角度。'),
      };
    }
  }

  const escape = findAnyLegalContactShot(state, strategy.power);
  if (escape) {
    return {
      targetBallId: escape.targetBallId,
      aimAngle: escape.angle,
      power: escape.power,
      spinX: strategy.spinX,
      spinY: strategy.spinY,
      strategy: 'safety',
      reasoning: `[Fallback] 解斯诺克 target#${escape.targetBallId} power=${escape.power.toFixed(2)} 杆法=${describeSpin(strategy.spinX, strategy.spinY)}。所有直接线路受阻，搜索带库后第一碰撞合法目标。`,
    };
  }

  return {
    targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
    strategy: 'safety', reasoning: '无目标',
  };
}

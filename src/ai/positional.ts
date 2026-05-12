// ============================================================
// Positional Play — Break Building & Snooker Placement
// ============================================================

import type { Ball, BallColor, GameState, Vec2 } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH, CENTER_Y } from '../engine/constants';
import { distanceBetween, applyShot, simulateShot } from '../engine/physics';
import {
  getLegalTargetBalls, calculateBestShot, findContactAngle,
  getPotLineCount, nearestPocket, calculateGhostBallPosition,
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

function countPotLinesFromPos(pos: Vec2, target: Ball, allBalls: Ball[]): number {
  const cueAsBall: Ball = {
    id: -1, color: 'white', pos: { ...pos },
    vel: { x: 0, y: 0 }, radius: BALL_RADIUS, pocketed: false, active: true,
  };
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
  candidates.sort((a, b) => a.snookerQuality - b.snookerQuality);
  return candidates[0];
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

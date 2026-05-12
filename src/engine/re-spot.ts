// ============================================================
// Centralized Re-spotting Logic (WPBSA Rules)
// Based on Section 3(c) of the WPBSA Rules of Snooker
// ============================================================

import type { Ball, BallColor, Vec2 } from '../types';
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH, CENTER_Y, BAULK_LINE_X, D_ZONE_RADIUS } from './constants';

/** Designated spot positions for each color ball */
const COLOR_SPOTS: Record<string, Vec2> = {
  yellow: { x: BAULK_LINE_X, y: CENTER_Y - D_ZONE_RADIUS },
  green:  { x: BAULK_LINE_X, y: CENTER_Y + D_ZONE_RADIUS },
  brown:  { x: BAULK_LINE_X, y: CENTER_Y },
  blue:   { x: TABLE_LENGTH / 2, y: CENTER_Y },
  pink:   { x: 892.25, y: CENTER_Y },
  black:  { x: 324, y: CENTER_Y },
};

const COLORS_REVERSED: BallColor[] = ['black', 'pink', 'blue', 'brown', 'green', 'yellow'];

function distanceBetween(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function isSpotOccupied(spot: Vec2, balls: Ball[]): boolean {
  return balls.some(b =>
    !b.pocketed && distanceBetween(b.pos, spot) < BALL_RADIUS * 2.1
  );
}

/**
 * Find the correct re-spot position for a color ball.
 * WPBSA Section 3(c)(i):
 * 1. Place on the ball's own designated spot
 * 2. If occupied, place on the highest-value available spot
 * 3. If all spots occupied, place as close to its own spot as possible
 *    between its spot and the nearest cushion, along the centre line
 */
export function findReSpotPosition(color: BallColor, balls: Ball[]): Vec2 {
  const ownSpot = COLOR_SPOTS[color];
  if (!ownSpot) return { x: TABLE_LENGTH / 2, y: CENTER_Y };

  // 1. Try own spot
  if (!isSpotOccupied(ownSpot, balls)) return { ...ownSpot };

  // 2. Try highest-value available spot
  for (const candidate of COLORS_REVERSED) {
    if (candidate === color) continue;
    const spot = COLOR_SPOTS[candidate];
    if (spot && !isSpotOccupied(spot, balls)) return { ...spot };
  }

  // 3. All spots occupied: place as near to own spot as possible,
  //    between that spot and the nearest part of the Top Cushion (§7(g)).
  // §7(h): For Pink and Black, if no space toward Top Cushion,
  //         place on the centre longitudinal line as close to own spot as possible.
  return findClosestAvailableOnCenterLine(color, ownSpot, balls);
}

/**
 * §7(g): Place between the spot and the Top Cushion face along the centre line.
 * §7(h): For Pink/Black, if no space toward Top Cushion, use any position on centre line.
 */
function findClosestAvailableOnCenterLine(color: BallColor, targetSpot: Vec2, balls: Ball[]): Vec2 {
  const y = CENTER_Y;

  // §7(g): Try positions between spot and Top Cushion (x decreasing toward 0)
  for (let offset = BALL_RADIUS; offset < TABLE_LENGTH; offset += BALL_RADIUS) {
    const candidate = { x: targetSpot.x - offset, y };
    if (candidate.x < BALL_RADIUS) break;
    if (!isSpotOccupied(candidate, balls)) return candidate;
  }

  // §7(h): For Pink and Black, if no space toward Top Cushion,
  // place as near to own spot as possible on the centre longitudinal line
  if (color === 'pink' || color === 'black') {
    // Try positions beyond own spot toward Baulk (x increasing)
    for (let offset = BALL_RADIUS; offset < TABLE_LENGTH; offset += BALL_RADIUS) {
      const candidate = { x: targetSpot.x + offset, y };
      if (candidate.x > TABLE_LENGTH - BALL_RADIUS) break;
      if (!isSpotOccupied(candidate, balls)) return candidate;
    }
  }

  // Fallback: return the spot itself
  return { ...targetSpot };
}

/**
 * Find the best position in the D-zone for the cue ball after a foul.
 * Evaluates positions based on:
 * 1. Clear line to the ball-on
 * 2. Not touching any other ball
 * 3. Strategic position for the incoming player
 */
export function findBestBaulkPosition(
  balls: Ball[],
  requiredTargetColors: BallColor[],
): Vec2 {
  const cueRadius = BALL_RADIUS;
  const candidates: { pos: Vec2; score: number }[] = [];

  // Generate positions in D-zone (semicircle centered on baulk line, radius D_ZONE_RADIUS)
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / steps;
    const pos: Vec2 = {
      x: BAULK_LINE_X + Math.cos(angle) * D_ZONE_RADIUS * 0.85,
      y: CENTER_Y + Math.sin(angle) * D_ZONE_RADIUS * 0.85,
    };

    // Check validity
    if (pos.x < cueRadius || pos.x > TABLE_LENGTH - cueRadius) continue;
    if (pos.y < cueRadius || pos.y > TABLE_WIDTH - cueRadius) continue;

    // Check not touching any ball
    const isTouching = balls.some(b =>
      !b.pocketed && b.color !== 'white' && distanceBetween(pos, b.pos) < (cueRadius + b.radius) * 1.1
    );
    if (isTouching) continue;

    // Score: prefer positions with clear line to ball-on targets
    let score = 0;
    const targetBalls = balls.filter(b =>
      !b.pocketed && requiredTargetColors.includes(b.color as BallColor)
    );
    for (const target of targetBalls) {
      const dist = distanceBetween(pos, target.pos);
      // Prefer closer targets with clear lines
      score += 1000 / (dist + 100);
      // Bonus for direct line of sight (no blocking ball)
      if (hasClearPath(pos, target.pos, balls, new Set([target.id]))) {
        score += 500;
      }
    }

    candidates.push({ pos, score });
  }

  if (candidates.length === 0) {
    return { x: BAULK_LINE_X, y: CENTER_Y + D_ZONE_RADIUS * 0.4 };
  }

  // Return position with highest score
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].pos;
}

function hasClearPath(from: Vec2, to: Vec2, balls: Ball[], ignoredIds: Set<number>): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return true;

  const ux = dx / dist;
  const uy = dy / dist;

  for (const ball of balls) {
    if (ball.pocketed || ignoredIds.has(ball.id)) continue;
    const bx = ball.pos.x - from.x;
    const by = ball.pos.y - from.y;
    const proj = bx * ux + by * uy;
    if (proj <= 0 || proj >= dist) continue;
    const perp = Math.abs(bx * (-uy) + by * ux);
    if (perp < BALL_RADIUS * 2.2) return false;
  }
  return true;
}

/** Get the designated spot position for a color ball (exported for backward compat) */
export function getColorSpot(color: BallColor): [number, number] {
  const spot = COLOR_SPOTS[color];
  if (!spot) return [TABLE_LENGTH / 2, CENTER_Y];
  return [spot.x, spot.y];
}

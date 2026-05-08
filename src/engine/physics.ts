// ============================================================
// Snooker Physics Engine
// Handles ball movement, collisions, cushion bounces, pocket detection
// ============================================================

import type { Ball, Vec2 } from '../types';
import {
  BALL_RADIUS, BALL_RESTITUTION, CUSHION_RESTITUTION,
  FRICTION_DECELERATION, MAX_CUE_SPEED, TABLE_WIDTH, TABLE_HEIGHT,
  POCKET_POSITIONS, POCKET_RADII, POCKET_PULL_RADIUS_FACTOR,
  PHYSICS_TIMESTEP, MAX_SIMULATION_TIME,
} from './constants';

function vec2(x: number, y: number): Vec2 { return { x, y }; }
function vecAdd(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
function vecSub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function vecScale(v: Vec2, s: number): Vec2 { return { x: v.x * s, y: v.y * s }; }
function vecLen(v: Vec2): number { return Math.sqrt(v.x * v.x + v.y * v.y); }
function vecDot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }
function vecNorm(v: Vec2): Vec2 {
  const l = vecLen(v);
  return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

/** Check if a ball has fallen into any pocket */
function checkPocket(ball: Ball): boolean {
  for (let i = 0; i < POCKET_POSITIONS.length; i++) {
    const pocketPos = vec2(POCKET_POSITIONS[i][0], POCKET_POSITIONS[i][1]);
    const pocketRadius = POCKET_RADII[i];
    const dx = ball.pos.x - pocketPos.x;
    const dy = ball.pos.y - pocketPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Ball center must be within pocket opening
    if (dist < pocketRadius * POCKET_PULL_RADIUS_FACTOR) {
      // Closer to pocket center = stronger pull
      if (dist < pocketRadius) {
        return true;
      }
    }
  }
  return false;
}

/** Resolve collision between two balls */
function resolveBallCollision(a: Ball, b: Ball): void {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = a.radius + b.radius;

  if (dist >= minDist || dist === 0) return;

  // Normal vector from a to b
  const nx = dx / dist;
  const ny = dy / dist;

  // Relative velocity
  const dvx = a.vel.x - b.vel.x;
  const dvy = a.vel.y - b.vel.y;

  // Relative velocity along normal
  const dvn = dvx * nx + dvy * ny;

  // Don't resolve if balls are separating
  if (dvn <= 0) return;

  // Impulse (equal mass, so simplified)
  const impulse = dvn * BALL_RESTITUTION;

  // Update velocities
  a.vel.x -= impulse * nx;
  a.vel.y -= impulse * ny;
  b.vel.x += impulse * nx;
  b.vel.y += impulse * ny;

  // Separate overlapping balls
  const overlap = minDist - dist;
  a.pos.x -= (overlap / 2) * nx;
  a.pos.y -= (overlap / 2) * ny;
  b.pos.x += (overlap / 2) * nx;
  b.pos.y += (overlap / 2) * ny;
}

/** Bounce ball off cushions */
function handleCushionBounce(ball: Ball): void {
  const r = ball.radius;

  // Left cushion
  if (ball.pos.x - r < 0) {
    ball.pos.x = r;
    ball.vel.x = Math.abs(ball.vel.x) * CUSHION_RESTITUTION;
  }
  // Right cushion
  if (ball.pos.x + r > TABLE_WIDTH) {
    ball.pos.x = TABLE_WIDTH - r;
    ball.vel.x = -Math.abs(ball.vel.x) * CUSHION_RESTITUTION;
  }
  // Top cushion
  if (ball.pos.y - r < 0) {
    ball.pos.y = r;
    ball.vel.y = Math.abs(ball.vel.y) * CUSHION_RESTITUTION;
  }
  // Bottom cushion
  if (ball.pos.y + r > TABLE_HEIGHT) {
    ball.pos.y = TABLE_HEIGHT - r;
    ball.vel.y = -Math.abs(ball.vel.y) * CUSHION_RESTITUTION;
  }
}

/** Apply friction to slow ball down */
function applyFriction(ball: Ball, dt: number): void {
  const speed = vecLen(ball.vel);
  if (speed < 0.5) {
    ball.vel = vec2(0, 0);
    return;
  }
  const frictionForce = FRICTION_DECELERATION * dt;
  const newSpeed = Math.max(0, speed - frictionForce);
  const ratio = newSpeed / speed;
  ball.vel.x *= ratio;
  ball.vel.y *= ratio;
}

/** Check if all balls are stationary */
function allBallsStopped(balls: Ball[]): boolean {
  return balls.every(b => b.pocketed || vecLen(b.vel) < 0.5);
}

/** Create initial ball positions for a new frame */
export function createInitialBalls(): Ball[] {
  const balls: Ball[] = [];
  let id = 0;

  // Cue ball
  const breakPos = vec2(BAULK_CENTER_X + 120, TABLE_HEIGHT - 737);
  balls.push({
    id: id++,
    color: 'white',
    pos: breakPos,
    vel: vec2(0, 0),
    radius: BALL_RADIUS,
    pocketed: false,
    active: true,
  });

  // 15 reds in triangle formation near the pink spot
  const pinkY = 1270;
  const startX = TABLE_WIDTH / 2;
  const rowSpacing = BALL_RADIUS * 2 * 0.866; // sqrt(3)/2 for hex packing
  const colSpacing = BALL_RADIUS * 2;
  let redIndex = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const x = startX + (col - row / 2) * colSpacing;
      const y = pinkY - (row + 1) * rowSpacing;
      balls.push({
        id: id++,
        color: 'red',
        pos: vec2(x, y),
        vel: vec2(0, 0),
        radius: BALL_RADIUS,
        pocketed: false,
        active: true,
      });
      redIndex++;
    }
  }

  // Color balls on their spots
  const colorSpots: [string, number, number][] = [
    ['yellow', TABLE_WIDTH / 2 + 292, TABLE_HEIGHT - 737],
    ['green', TABLE_WIDTH / 2 - 292, TABLE_HEIGHT - 737],
    ['brown', TABLE_WIDTH / 2, TABLE_HEIGHT - 737],
    ['blue', TABLE_WIDTH / 2, TABLE_HEIGHT / 2],
    ['pink', TABLE_WIDTH / 2, 1270],
    ['black', TABLE_WIDTH / 2, 324],
  ];

  for (const [color, x, y] of colorSpots) {
    balls.push({
      id: id++,
      color: color as Ball['color'],
      pos: vec2(x, y),
      vel: vec2(0, 0),
      radius: BALL_RADIUS,
      pocketed: false,
      active: true,
    });
  }

  return balls;
}

// Re-export baulk center for use elsewhere
const BAULK_CENTER_X = TABLE_WIDTH / 2;

/** Apply shot: set cue ball velocity based on shot parameters */
export function applyShot(
  balls: Ball[],
  angle: number,
  power: number,
  spinX: number,
  spinY: number,
): void {
  const cueBall = balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return;

  const speed = power * MAX_CUE_SPEED;
  cueBall.vel = vec2(
    Math.cos(angle) * speed,
    Math.sin(angle) * speed,
  );

  // Spin effects are subtle - modify velocity slightly after first contact
  // We'll store spin on the ball temporarily
  (cueBall as any)._spinX = spinX;
  (cueBall as any)._spinY = spinY;
}

/** Physics simulation result */
export interface SimulationResult {
  /** Balls that were potted during this shot */
  pottedBalls: Ball[];
  /** ID of the first ball the cue ball contacted */
  firstContactBallId: number | null;
  /** Whether cue ball was potted */
  cueBallPotted: boolean;
  /** Whether any ball hit a cushion after first contact */
  cushionHitAfterContact: boolean;
  /** Final positions of all balls */
  finalBalls: Ball[];
}

/** Run full physics simulation until all balls stop */
export function simulateShot(balls: Ball[]): SimulationResult {
  const pottedBalls: Ball[] = [];
  let firstContactBallId: number | null = null;
  let cueBallPotted = false;
  let cushionHitAfterContact = false;
  let hasContact = false;

  // Deep copy balls for simulation
  const simBalls = balls.map(b => ({
    ...b,
    pos: { ...b.pos },
    vel: { ...b.vel },
  }));

  const cueBall = simBalls.find(b => b.color === 'white');
  if (!cueBall) {
    return { pottedBalls: [], firstContactBallId: null, cueBallPotted: false, cushionHitAfterContact: false, finalBalls: simBalls };
  }

  const dt = PHYSICS_TIMESTEP;
  let elapsed = 0;

  while (!allBallsStopped(simBalls) && elapsed < MAX_SIMULATION_TIME) {
    // Move balls
    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      ball.pos.x += ball.vel.x * dt;
      ball.pos.y += ball.vel.y * dt;
    }

    // Ball-ball collisions
    for (let i = 0; i < simBalls.length; i++) {
      if (simBalls[i].pocketed) continue;
      for (let j = i + 1; j < simBalls.length; j++) {
        if (simBalls[j].pocketed) continue;
        const beforeVel = { ...simBalls[i].vel };
        resolveBallCollision(simBalls[i], simBalls[j]);

        // Track first contact
        const aIsCue = simBalls[i].color === 'white';
        const bIsCue = simBalls[j].color === 'white';
        if ((aIsCue || bIsCue) && !hasContact) {
          const velChanged =
            beforeVel.x !== simBalls[i].vel.x ||
            beforeVel.y !== simBalls[i].vel.y;
          if (velChanged) {
            firstContactBallId = aIsCue ? simBalls[j].id : simBalls[i].id;
            hasContact = true;
          }
        }
      }
    }

    // Cushion bounces & track
    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      const oldVel = { ...ball.vel };
      handleCushionBounce(ball);
      if (hasContact &&
        (oldVel.x !== ball.vel.x || oldVel.y !== ball.vel.y)) {
        cushionHitAfterContact = true;
      }
    }

    // Pocket detection
    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      if (checkPocket(ball)) {
        ball.pocketed = true;
        ball.vel = vec2(0, 0);
        if (ball.color === 'white') {
          cueBallPotted = true;
        } else {
          pottedBalls.push({ ...ball });
        }
      }
    }

    // Apply friction
    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      applyFriction(ball, dt);
    }

    elapsed += dt;
  }

  // Ensure all stopped
  for (const ball of simBalls) {
    if (!ball.pocketed) {
      ball.vel = vec2(0, 0);
    }
  }

  return {
    pottedBalls,
    firstContactBallId,
    cueBallPotted,
    cushionHitAfterContact,
    finalBalls: simBalls,
  };
}

// ============================================================
// Utility: calculate angle from cue ball to a target position
// ============================================================
export function angleBetween(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function distanceBetween(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Get a human-readable description of ball positions for the LLM */
export function describeBallPositions(balls: Ball[]): string {
  const active = balls.filter(b => !b.pocketed);
  return active.map(b => {
    const label = b.color === 'white' ? 'cue' : b.color;
    return `${label}(${Math.round(b.pos.x)},${Math.round(b.pos.y)})`;
  }).join(', ');
}

// ============================================================
// Snooker Physics Engine
// Handles ball movement, collisions, cushion bounces, pocket detection
// ============================================================

import type { Ball, Vec2 } from '../types';
import {
  BALL_RADIUS, BALL_RESTITUTION, CUSHION_RESTITUTION,
  FRICTION_DECELERATION, MAX_CUE_SPEED,
  TABLE_LENGTH, TABLE_WIDTH,
  POCKET_POSITIONS, POCKET_RADII,
  PHYSICS_TIMESTEP, MAX_SIMULATION_TIME,
  PINK_SPOT_X, BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS,
} from './constants';

function vec2(x: number, y: number): Vec2 { return { x, y }; }
function vecLen(v: Vec2): number { return Math.sqrt(v.x * v.x + v.y * v.y); }
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getSpin(ball: Ball): { x: number; y: number } {
  return {
    x: clamp(ball.spinX ?? 0, -1, 1),
    y: clamp(ball.spinY ?? 0, -1, 1),
  };
}

function setSpin(ball: Ball, spinX: number, spinY: number): void {
  ball.spinX = clamp(spinX, -1, 1);
  ball.spinY = clamp(spinY, -1, 1);
}

/** Check if a ball has fallen into any pocket */
function checkPocket(ball: Ball): boolean {
  for (let i = 0; i < POCKET_POSITIONS.length; i++) {
    const pocketPos = vec2(POCKET_POSITIONS[i][0], POCKET_POSITIONS[i][1]);
    const pocketRadius = POCKET_RADII[i];
    const dx = ball.pos.x - pocketPos.x;
    const dy = ball.pos.y - pocketPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < pocketRadius) {
      return true;
    }
  }
  return false;
}

/** Resolve collision between two balls */
function resolveBallCollision(a: Ball, b: Ball): boolean {
  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = a.radius + b.radius;

  if (dist >= minDist || dist === 0) return false;

  const nx = dx / dist;
  const ny = dy / dist;
  const aVelBefore = { ...a.vel };
  const bVelBefore = { ...b.vel };

  const dvx = a.vel.x - b.vel.x;
  const dvy = a.vel.y - b.vel.y;
  const dvn = dvx * nx + dvy * ny;

  if (dvn <= 0) return false;

  const impulse = dvn * BALL_RESTITUTION;

  a.vel.x -= impulse * nx;
  a.vel.y -= impulse * ny;
  b.vel.x += impulse * nx;
  b.vel.y += impulse * ny;

  const overlap = minDist - dist;
  a.pos.x -= (overlap / 2) * nx;
  a.pos.y -= (overlap / 2) * ny;
  b.pos.x += (overlap / 2) * nx;
  b.pos.y += (overlap / 2) * ny;

  applyCueBallSpinOnContact(a, b, aVelBefore, bVelBefore, nx, ny);

  return true;
}

function applyCueBallSpinOnContact(
  a: Ball,
  b: Ball,
  aVelBefore: Vec2,
  bVelBefore: Vec2,
  nx: number,
  ny: number,
): void {
  const aIsCue = a.color === 'white';
  const bIsCue = b.color === 'white';
  if (!aIsCue && !bIsCue) return;

  const cue = aIsCue ? a : b;
  const cueVelBefore = aIsCue ? aVelBefore : bVelBefore;
  const speedBefore = vecLen(cueVelBefore);
  if (speedBefore < 1) return;

  const normalFromCue = aIsCue ? { x: nx, y: ny } : { x: -nx, y: -ny };
  const tangent = { x: -normalFromCue.y, y: normalFromCue.x };
  const spin = getSpin(cue);

  // Top/back spin changes the cue-ball follow/draw along the object-ball line.
  // Side spin creates a smaller tangent separation after contact.
  const followKick = spin.y * speedBefore * 0.36;
  const sideKick = spin.x * speedBefore * 0.18;
  cue.vel.x += normalFromCue.x * followKick + tangent.x * sideKick;
  cue.vel.y += normalFromCue.y * followKick + tangent.y * sideKick;

  // Collision consumes part of the stored spin while preserving enough side for cushions.
  setSpin(cue, spin.x * 0.82, spin.y * 0.45);
}

/** Bounce ball off cushions */
function applyCushionReflection(ball: Ball, axis: 'x' | 'y', sign: number): void {
  const spin = getSpin(ball);
  const normalSpeed = axis === 'x' ? Math.abs(ball.vel.x) : Math.abs(ball.vel.y);
  const restitution = CUSHION_RESTITUTION + Math.abs(spin.x) * 0.04;
  const sideKick = ball.color === 'white' ? spin.x * normalSpeed * 0.24 : 0;
  const speedFactor = ball.color === 'white' ? 1 + Math.abs(spin.x) * 0.08 : 1;

  if (axis === 'x') {
    ball.vel.x = sign * normalSpeed * restitution;
    ball.vel.y = (ball.vel.y + sideKick * sign) * speedFactor;
  } else {
    ball.vel.y = sign * normalSpeed * restitution;
    ball.vel.x = (ball.vel.x - sideKick * sign) * speedFactor;
  }

  if (ball.color === 'white') {
    setSpin(ball, spin.x * 0.68, spin.y * 0.82);
  }
}

function handleCushionBounce(ball: Ball): void {
  const r = ball.radius;

  // Left cushion (y=0)
  if (ball.pos.y - r < 0) {
    ball.pos.y = r;
    applyCushionReflection(ball, 'y', 1);
  }
  // Right cushion (y=TABLE_WIDTH)
  if (ball.pos.y + r > TABLE_WIDTH) {
    ball.pos.y = TABLE_WIDTH - r;
    applyCushionReflection(ball, 'y', -1);
  }
  // Top cushion (x=0)
  if (ball.pos.x - r < 0) {
    ball.pos.x = r;
    applyCushionReflection(ball, 'x', 1);
  }
  // Bottom / Baulk cushion (x=TABLE_LENGTH)
  if (ball.pos.x + r > TABLE_LENGTH) {
    ball.pos.x = TABLE_LENGTH - r;
    applyCushionReflection(ball, 'x', -1);
  }
}

/** Apply friction to slow ball down */
function applyFriction(ball: Ball, dt: number): void {
  const speed = vecLen(ball.vel);
  if (speed < 0.5) {
    ball.vel = vec2(0, 0);
    setSpin(ball, 0, 0);
    return;
  }
  const spin = getSpin(ball);
  const spinDrag = ball.color === 'white'
    ? 1 + Math.max(0, -spin.y) * 0.18 - Math.max(0, spin.y) * 0.08
    : 1;
  const frictionForce = FRICTION_DECELERATION * spinDrag * dt;
  const newSpeed = Math.max(0, speed - frictionForce);
  const ratio = newSpeed / speed;
  ball.vel.x *= ratio;
  ball.vel.y *= ratio;

  if (ball.color === 'white') {
    setSpin(ball, spin.x * Math.exp(-1.4 * dt), spin.y * Math.exp(-1.8 * dt));
  }
}

/** Check if all balls are stationary */
function allBallsStopped(balls: Ball[]): boolean {
  return balls.every(b => b.pocketed || vecLen(b.vel) < 0.5);
}

/** Create initial ball positions for a new frame */
export function createInitialBalls(): Ball[] {
  const balls: Ball[] = [];
  let id = 0;

  // Cue ball: in D-zone on baulk line
  balls.push({
    id: id++,
    color: 'white',
    pos: vec2(BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS * 0.4),
    vel: vec2(0, 0),
    radius: BALL_RADIUS,
    pocketed: false,
    active: true,
  });

  // 15 reds in triangle formation
  // WPBSA rules: triangle placed with apex CLOSEST to the pink ball.
  // The pink is at x=892.25. The apex (row 0, 1 ball) sits just beyond
  // the pink toward the top cushion (decreasing x), with the base
  // (row 4, 5 balls) opening toward the baulk end (increasing x).
  //
  // Actually per the standard diagram: apex touches the pink.
  // So apex x = PINK_SPOT_X - BALL_RADIUS * 2 (just above pink)
  const apexX = PINK_SPOT_X - BALL_RADIUS * 2;
  const rowSpacing = BALL_RADIUS * 2 * 0.866; // sqrt(3)/2 for hex packing
  const colSpacing = BALL_RADIUS * 2;

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const x = apexX - row * rowSpacing; // rows go toward top cushion (decreasing x)
      const y = CENTER_Y + (col - row / 2) * colSpacing;
      balls.push({
        id: id++,
        color: 'red',
        pos: vec2(x, y),
        vel: vec2(0, 0),
        radius: BALL_RADIUS,
        pocketed: false,
        active: true,
      });
    }
  }

  // Color balls on their designated spots
  const colorSpots: [string, number, number][] = [
    ['yellow', BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS],
    ['green', BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS],
    ['brown', BAULK_LINE_X, CENTER_Y],
    ['blue', TABLE_LENGTH / 2, CENTER_Y],
    ['pink', PINK_SPOT_X, CENTER_Y],
    ['black', 324, CENTER_Y],
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

  setSpin(cueBall, spinX, spinY);
}

/** Physics simulation result */
export interface SimulationResult {
  pottedBalls: Ball[];
  firstContactBallId: number | null;
  cueBallPotted: boolean;
  cushionHitAfterContact: boolean;
  finalBalls: Ball[];
  frames: Ball[][];
}

/** Run full physics simulation until all balls stop */
export function simulateShot(balls: Ball[]): SimulationResult {
  const pottedBalls: Ball[] = [];
  let firstContactBallId: number | null = null;
  let cueBallPotted = false;
  let cushionHitAfterContact = false;
  let hasContact = false;
  const frames: Ball[][] = [];
  const FRAME_INTERVAL_TICKS = Math.round(0.05 / PHYSICS_TIMESTEP);
  let tickCount = 0;

  const simBalls = balls.map(b => ({
    ...b,
    pos: { ...b.pos },
    vel: { ...b.vel },
  }));

  const cueBall = simBalls.find(b => b.color === 'white');
  if (!cueBall) {
    return { pottedBalls: [], firstContactBallId: null, cueBallPotted: false, cushionHitAfterContact: false, finalBalls: simBalls, frames: [] };
  }

  const dt = PHYSICS_TIMESTEP;
  let elapsed = 0;

  while (!allBallsStopped(simBalls) && elapsed < MAX_SIMULATION_TIME) {
    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      ball.pos.x += ball.vel.x * dt;
      ball.pos.y += ball.vel.y * dt;
    }

    for (let i = 0; i < simBalls.length; i++) {
      if (simBalls[i].pocketed) continue;
      for (let j = i + 1; j < simBalls.length; j++) {
        if (simBalls[j].pocketed) continue;
        const collided = resolveBallCollision(simBalls[i], simBalls[j]);

        const aIsCue = simBalls[i].color === 'white';
        const bIsCue = simBalls[j].color === 'white';
        if (collided && (aIsCue || bIsCue) && !hasContact) {
          firstContactBallId = aIsCue ? simBalls[j].id : simBalls[i].id;
          hasContact = true;
        }
      }
    }

    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      const oldVel = { ...ball.vel };
      handleCushionBounce(ball);
      if (hasContact &&
        (oldVel.x !== ball.vel.x || oldVel.y !== ball.vel.y)) {
        cushionHitAfterContact = true;
      }
    }

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

    for (const ball of simBalls) {
      if (ball.pocketed) continue;
      applyFriction(ball, dt);
    }

    tickCount++;
    if (tickCount % FRAME_INTERVAL_TICKS === 0) {
      frames.push(simBalls.map(b => ({
        ...b,
        pos: { ...b.pos },
        vel: { ...b.vel },
      })));
    }

    elapsed += dt;
  }

  for (const ball of simBalls) {
    if (!ball.pocketed) {
      ball.vel = vec2(0, 0);
    }
  }

  frames.push(simBalls.map(b => ({
    ...b,
    pos: { ...b.pos },
    vel: { ...b.vel },
  })));

  return {
    pottedBalls,
    firstContactBallId,
    cueBallPotted,
    cushionHitAfterContact,
    finalBalls: simBalls,
    frames,
  };
}

export function angleBetween(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

export function distanceBetween(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function describeBallPositions(balls: Ball[]): string {
  const active = balls.filter(b => !b.pocketed);
  return active.map(b => {
    const label = b.color === 'white' ? 'cue' : b.color;
    return `${label}(${Math.round(b.pos.x)},${Math.round(b.pos.y)})`;
  }).join(', ');
}

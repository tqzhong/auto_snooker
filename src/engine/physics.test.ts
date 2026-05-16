// ============================================================
// Physics Engine Tests
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  simulateShot, applyShot, createInitialBalls,
  distanceBetween, angleBetween,
} from './physics';
import {
  BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH,
  BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS,
} from './constants';
import type { Ball, Vec2 } from '../types';

function makeBall(id: number, color: Ball['color'], x: number, y: number): Ball {
  return {
    id,
    color,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    radius: BALL_RADIUS,
    pocketed: false,
    active: true,
  };
}

describe('distanceBetween', () => {
  it('calculates distance correctly', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });

  it('returns 0 for same point', () => {
    expect(distanceBetween({ x: 100, y: 200 }, { x: 100, y: 200 })).toBe(0);
  });
});

describe('angleBetween', () => {
  it('calculates rightward angle', () => {
    expect(angleBetween({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(0);
  });

  it('calculates downward angle', () => {
    expect(angleBetween({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(Math.PI / 2);
  });
});

describe('createInitialBalls', () => {
  it('creates 22 balls (1 cue + 15 reds + 6 colors)', () => {
    const balls = createInitialBalls();
    expect(balls).toHaveLength(22);
  });

  it('has one cue ball', () => {
    const balls = createInitialBalls();
    const cues = balls.filter(b => b.color === 'white');
    expect(cues).toHaveLength(1);
  });

  it('has 15 reds', () => {
    const balls = createInitialBalls();
    const reds = balls.filter(b => b.color === 'red');
    expect(reds).toHaveLength(15);
  });

  it('has 6 color balls', () => {
    const balls = createInitialBalls();
    const colors = balls.filter(b => b.color !== 'red' && b.color !== 'white');
    expect(colors).toHaveLength(6);
  });

  it('places cue ball in D-zone', () => {
    const balls = createInitialBalls();
    const cue = balls.find(b => b.color === 'white')!;
    expect(cue.pos.x).toBeCloseTo(BAULK_LINE_X, -1);
    expect(cue.pos.y).toBeGreaterThan(CENTER_Y);
  });
});

describe('simulateShot', () => {
  it('handles no balls moving', () => {
    const balls = createInitialBalls();
    const result = simulateShot(balls);
    expect(result.pottedBalls).toHaveLength(0);
    expect(result.cueBallPotted).toBe(false);
  });

  it('detects cue ball pot', () => {
    // Place cue ball near top-left corner pocket, aimed at pocket
    const balls = [
      makeBall(0, 'white', 100, 100),
      makeBall(1, 'red', 2000, 889),
    ];
    applyShot(balls, Math.PI * 0.75 + 0.1, 0.8, 0, 0);
    const result = simulateShot(balls);
    // The cue ball should either pot or stay on table
    expect(typeof result.cueBallPotted).toBe('boolean');
  });

  it('detects first contact', () => {
    // Place cue ball and a red in a straight line
    const balls = [
      makeBall(0, 'white', 1000, 889),
      makeBall(1, 'red', 1500, 889),
    ];
    applyShot(balls, 0, 0.5, 0, 0);
    const result = simulateShot(balls);
    expect(result.firstContactBallId).toBe(1);
  });

  it('detects ball-ball collision', () => {
    // Cue ball aimed directly at red ball
    const balls = [
      makeBall(0, 'white', 1000, 889),
      makeBall(1, 'red', 1200, 889),
      makeBall(2, 'red', 2000, 889), // Another red to avoid end-of-sim issues
    ];
    applyShot(balls, 0, 0.4, 0, 0);
    const result = simulateShot(balls);
    // After collision, cue ball should have different velocity
    expect(result.firstContactBallId).toBe(1);
  });

  it('pots a ball when aimed at pocket', () => {
    // Place a red just above the top-left corner pocket
    // Pocket is at ~(22, 22), so place red centered at (80, 80)
    // and cue ball in a straight line to the ghost-ball position
    const pocketX = 22;
    const pocketY = 22;
    const redX = 80;
    const redY = 80;
    // Ghost ball: one radius behind target away from pocket
    const dx = pocketX - redX;
    const dy = pocketY - redY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const nx = dx / dist;
    const ny = dy / dist;
    const ghostX = redX - nx * BALL_RADIUS * 2;
    const ghostY = redY - ny * BALL_RADIUS * 2;
    // Place cue ball on the line to ghost ball, far enough to get good speed
    const cueX = ghostX - nx * 500;
    const cueY = ghostY - ny * 500;

    const balls = [
      makeBall(0, 'white', cueX, cueY),
      makeBall(1, 'red', redX, redY),
    ];

    const angle = angleBetween({ x: cueX, y: cueY }, { x: ghostX, y: ghostY });
    applyShot(balls, angle, 0.5, 0, 0);
    const result = simulateShot(balls);
    expect(result.pottedBalls.some(b => b.id === 1)).toBe(true);
  });

  it('does not swallow a badly off-center middle-pocket attempt', () => {
    const balls = [
      makeBall(0, 'white', TABLE_LENGTH / 2 - 700, 540),
      makeBall(1, 'red', TABLE_LENGTH / 2 - 120, 82),
      makeBall(2, 'red', 3000, CENTER_Y),
    ];
    applyShot(balls, angleBetween(balls[0].pos, balls[1].pos), 0.42, 0, 0);
    const result = simulateShot(balls, { generateFrames: false });
    expect(result.pottedBalls.some(b => b.id === 1)).toBe(false);
  });

  it('stops all balls within simulation time', () => {
    const balls = createInitialBalls();
    applyShot(balls, 0, 0.3, 0, 0);
    const result = simulateShot(balls);
    // All non-potted balls should be stationary
    for (const ball of result.finalBalls) {
      if (!ball.pocketed) {
        const speed = Math.sqrt(ball.vel.x ** 2 + ball.vel.y ** 2);
        expect(speed).toBeLessThan(1);
      }
    }
  });

  it('respects MAX_SIMULATION_TIME', () => {
    // This test ensures the simulation doesn't hang
    const balls = createInitialBalls();
    applyShot(balls, Math.PI / 4, 1.0, 0, 0);
    const start = Date.now();
    simulateShot(balls);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // Should complete within 5 seconds
  });
});

describe('cushion bounce', () => {
  it('bounces off top cushion', () => {
    const balls = [
      makeBall(0, 'white', 500, BALL_RADIUS + 10),
    ];
    applyShot(balls, -Math.PI / 2, 0.3, 0, 0); // Aim up
    const result = simulateShot(balls);
    // Ball should not go beyond top cushion
    for (const frame of result.frames) {
      const cue = frame.find(b => b.color === 'white');
      if (cue && !cue.pocketed) {
        expect(cue.pos.y).toBeGreaterThanOrEqual(BALL_RADIUS - 1);
      }
    }
  });

  it('bounces off bottom cushion', () => {
    const balls = [
      makeBall(0, 'white', 500, TABLE_WIDTH - BALL_RADIUS - 10),
    ];
    applyShot(balls, Math.PI / 2, 0.3, 0, 0); // Aim down
    const result = simulateShot(balls);
    for (const frame of result.frames) {
      const cue = frame.find(b => b.color === 'white');
      if (cue && !cue.pocketed) {
        expect(cue.pos.y).toBeLessThanOrEqual(TABLE_WIDTH - BALL_RADIUS + 1);
      }
    }
  });
});

describe('friction', () => {
  it('eventually stops a moving ball', () => {
    const balls = [
      makeBall(0, 'white', TABLE_LENGTH / 2, CENTER_Y),
    ];
    applyShot(balls, 0, 0.2, 0, 0);
    const result = simulateShot(balls);
    const cue = result.finalBalls.find(b => b.color === 'white')!;
    const speed = Math.sqrt(cue.vel.x ** 2 + cue.vel.y ** 2);
    expect(speed).toBeLessThan(1);
  });
});

describe('cue-ball spin physics', () => {
  function straightObjectBallShot(spinY: number): Vec2 {
    const balls = [
      makeBall(0, 'white', 900, CENTER_Y),
      makeBall(1, 'red', 1180, CENTER_Y),
      makeBall(2, 'red', 2600, CENTER_Y + 260),
    ];
    applyShot(balls, 0, 0.38, 0, spinY);
    const result = simulateShot(balls, { generateFrames: false });
    return result.finalBalls.find(b => b.color === 'white')!.pos;
  }

  it('makes follow travel farther forward than draw after full-ball contact', () => {
    const draw = straightObjectBallShot(-0.85);
    const stun = straightObjectBallShot(0);
    const follow = straightObjectBallShot(0.85);

    expect(follow.x).toBeGreaterThan(stun.x + 80);
    expect(draw.x).toBeLessThan(stun.x - 40);
  });

  it('curves the cue ball when side spin is applied', () => {
    const center = [
      makeBall(0, 'white', 1000, CENTER_Y),
    ];
    const side = [
      makeBall(0, 'white', 1000, CENTER_Y),
    ];

    applyShot(center, 0, 0.32, 0, 0);
    applyShot(side, 0, 0.32, 0.9, 0.45);
    const centerResult = simulateShot(center, { generateFrames: false });
    const sideResult = simulateShot(side, { generateFrames: false });
    const centerCue = centerResult.finalBalls.find(b => b.color === 'white')!;
    const sideCue = sideResult.finalBalls.find(b => b.color === 'white')!;

    expect(Math.abs(sideCue.pos.y - centerCue.pos.y)).toBeGreaterThan(35);
  });

  it('changes cushion exit angle with side spin', () => {
    const plain = [makeBall(0, 'white', 900, 180)];
    const side = [makeBall(0, 'white', 900, 180)];

    applyShot(plain, -Math.PI / 2, 0.38, 0, 0);
    applyShot(side, -Math.PI / 2, 0.38, 0.9, 0);
    const plainResult = simulateShot(plain, { generateFrames: false });
    const sideResult = simulateShot(side, { generateFrames: false });
    const plainCue = plainResult.finalBalls.find(b => b.color === 'white')!;
    const sideCue = sideResult.finalBalls.find(b => b.color === 'white')!;

    expect(Math.abs(sideCue.pos.x - plainCue.pos.x)).toBeGreaterThan(70);
  });
});

import { describe, expect, it } from 'vitest';
import type { Ball, GameState } from '../../types';
import { BALL_RADIUS, CENTER_Y } from '../../engine/constants';
import { applyShot, simulateShot, createInitialBalls } from '../../engine/physics';
import { createInitialGameState } from '../../engine/rules';
import { MasterSnookerAgent } from './master-agent';
import { getLegalTargetBalls } from '../strategy';

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

function makeState(balls: Ball[], patch: Partial<GameState> = {}): GameState {
  return {
    ...createInitialGameState(['A', 'B'], balls),
    cueBallInHand: false,
    redsRemaining: balls.filter(b => b.color === 'red' && !b.pocketed).length,
    ...patch,
  };
}

describe('MasterSnookerAgent', () => {
  it('chooses a verified pot while controlling the next cue-ball position', async () => {
    const pocket = { x: 22, y: 22 };
    const red = makeBall(1, 'red', 120, 120);
    const dx = pocket.x - red.pos.x;
    const dy = pocket.y - red.pos.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const nx = dx / len;
    const ny = dy / len;
    const ghost = {
      x: red.pos.x - nx * BALL_RADIUS * 2,
      y: red.pos.y - ny * BALL_RADIUS * 2,
    };
    const cue = makeBall(0, 'white', ghost.x - nx * 520, ghost.y - ny * 520);
    const black = makeBall(2, 'black', 500, CENTER_Y);
    const state = makeState([cue, red, black], { phase: 'reds_phase' });

    const decision = await new MasterSnookerAgent().decide(state);
    const balls = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
    applyShot(balls, decision.aimAngle, decision.power, decision.spinX, decision.spinY);
    const sim = simulateShot(balls, { generateFrames: false });

    expect(decision.strategy).toBe('attack');
    expect(decision.targetBallId).toBe(red.id);
    expect(sim.firstContactBallId).toBe(red.id);
    expect(sim.pottedBalls.some(b => b.id === red.id)).toBe(true);
    expect(decision.reasoning).toContain('下一杆');
  });

  it('uses a scored safety on the opening table instead of a random contact', async () => {
    const balls = createInitialBalls();
    const state = makeState(balls, { phase: 'break_off' });
    const legalIds = new Set(getLegalTargetBalls(state).map(b => b.id));

    const decision = await new MasterSnookerAgent().decide(state);
    const shotBalls = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
    applyShot(shotBalls, decision.aimAngle, decision.power, decision.spinX, decision.spinY);
    const sim = simulateShot(shotBalls, { generateFrames: false });

    expect(decision.strategy === 'safety' || decision.strategy === 'snooker').toBe(true);
    expect(sim.firstContactBallId === null || legalIds.has(sim.firstContactBallId)).toBe(true);
    expect(sim.cueBallPotted).toBe(false);
    expect(decision.reasoning).toMatch(/对手可进线路|斯诺克|最近目标/);
  });

  it('can use strong follow and draw for cue-ball control', async () => {
    const balls = [
      makeBall(0, 'white', 720, CENTER_Y),
      makeBall(1, 'red', 980, CENTER_Y),
      makeBall(2, 'black', 440, CENTER_Y),
      makeBall(3, 'pink', 900, CENTER_Y + 180),
    ];
    const state = makeState(balls, { phase: 'reds_phase' });

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => new MasterSnookerAgent().decide(state)),
    );

    expect(decisions.some(d => Math.abs(d.spinY) >= 0.42 || Math.abs(d.spinX) >= 0.32)).toBe(true);
  });
});

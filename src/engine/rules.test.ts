import { describe, expect, it } from 'vitest';
import type { Ball, GameState, ShotParams } from '../types';
import { BALL_VALUES } from '../types';
import { BALL_RADIUS, BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS } from './constants';
import type { SimulationResult } from './physics';
import { createInitialGameState, evaluateShot, applyShotResult } from './rules';

function ball(id: number, color: Ball['color'], pocketed = false): Ball {
  return {
    id,
    color,
    pos: { x: 500 + id * 80, y: CENTER_Y },
    vel: { x: 0, y: 0 },
    radius: BALL_RADIUS,
    pocketed,
    active: true,
  };
}

function shot(targetBallId: number): ShotParams {
  return { angle: 0, power: 0.5, spinX: 0, spinY: 0, targetBallId };
}

function sim(
  before: Ball[],
  options: {
    potted?: number[];
    first?: number | null;
    firstIds?: number[];
    cuePotted?: boolean;
    offTable?: number[];
  },
): SimulationResult {
  const potted = new Set(options.potted ?? []);
  const offTable = new Set(options.offTable ?? []);
  const finalBalls = before.map(b => ({
    ...b,
    pos: { ...b.pos },
    vel: { x: 0, y: 0 },
    pocketed: b.pocketed || potted.has(b.id) || offTable.has(b.id) || Boolean(options.cuePotted && b.color === 'white'),
  }));

  return {
    pottedBalls: finalBalls.filter(b => potted.has(b.id)),
    firstContactBallId: options.first ?? null,
    firstContactBallIds: options.firstIds ?? (options.first === null || options.first === undefined ? [] : [options.first]),
    cueBallPotted: options.cuePotted ?? false,
    cushionHitAfterContact: false,
    offTableBalls: finalBalls.filter(b => offTable.has(b.id)),
    cushionHitsAfterContact: 0,
    finalBalls,
    frames: [],
  };
}

function stateWith(balls: Ball[], patch: Partial<GameState> = {}): GameState {
  return {
    ...createInitialGameState(['A', 'B'], balls),
    cueBallInHand: false,
    redsRemaining: balls.filter(b => b.color === 'red' && !b.pocketed).length,
    ...patch,
  };
}

describe('WPBSA rules engine', () => {
  it('penalizes a colour pocketed while red is on', () => {
    const balls = [ball(0, 'white'), ball(1, 'red'), ball(2, 'blue')];
    const state = stateWith(balls, { phase: 'reds_phase' });
    const result = evaluateShot(state, shot(1), sim(balls, { first: 1, potted: [2] }));

    expect(result.pointsScored).toBe(0);
    expect(result.fouls.some(f => f.type === 'ball_not_on_pocketed')).toBe(true);
    expect(result.fouls.find(f => f.points > 0)?.points).toBe(BALL_VALUES.blue);
  });

  it('does not score any potted balls in a foul stroke and re-spots pocketed colours', () => {
    const balls = [ball(0, 'white'), ball(1, 'red'), ball(2, 'blue')];
    const state = stateWith(balls, { phase: 'reds_phase' });
    const simulation = sim(balls, { first: 1, potted: [1, 2] });
    const result = evaluateShot(state, shot(1), simulation);
    const next = applyShotResult(state, shot(1), simulation, result, 'test');

    expect(result.pointsScored).toBe(0);
    expect(result.pottedBalls).toHaveLength(0);
    expect(next.balls.find(b => b.id === 1)?.pocketed).toBe(true);
    expect(next.balls.find(b => b.id === 2)?.pocketed).toBe(false);
  });

  it('returns to red-on when a colour-after-red turn ends without potting', () => {
    const balls = [ball(0, 'white'), ball(1, 'red'), ball(2, 'blue')];
    const state = stateWith(balls, { phase: 'color_after_red', currentPlayerIndex: 0 });
    const simulation = sim(balls, { first: 2 });
    const result = evaluateShot(state, shot(2), simulation);
    const next = applyShotResult(state, shot(2), simulation, result, 'test');

    expect(result.fouls).toHaveLength(0);
    expect(next.currentPlayerIndex).toBe(1);
    expect(next.phase).toBe('reds_phase');
  });

  it('ends the frame on a foul when only black remains', () => {
    const balls = [ball(0, 'white'), ball(1, 'black')];
    const state = stateWith(balls, {
      phase: 'colors_phase',
      nextColorToPot: 'black',
      players: [
        { name: 'A', score: 50, currentBreak: 0, highestBreak: 0 },
        { name: 'B', score: 42, currentBreak: 0, highestBreak: 0 },
      ],
    });
    const simulation = sim(balls, { first: null, cuePotted: true });
    const result = evaluateShot(state, shot(1), simulation);
    const next = applyShotResult(state, shot(1), simulation, result, 'test');

    expect(next.phase).toBe('game_over');
    expect(next.players[1].score).toBe(49);
  });

  it('re-spots the final black and puts cue ball in-hand when the scores become level', () => {
    const balls = [ball(0, 'white'), ball(1, 'black')];
    balls[0].pos = { x: BAULK_LINE_X, y: CENTER_Y + D_ZONE_RADIUS * 0.4 };
    const state = stateWith(balls, {
      phase: 'colors_phase',
      nextColorToPot: 'black',
      players: [
        { name: 'A', score: 50, currentBreak: 0, highestBreak: 0 },
        { name: 'B', score: 57, currentBreak: 0, highestBreak: 0 },
      ],
    });
    const simulation = sim(balls, { first: 1, potted: [1] });
    const result = evaluateShot(state, shot(1), simulation);
    const next = applyShotResult(state, shot(1), simulation, result, 'test');

    expect(next.phase).toBe('colors_phase');
    expect(next.nextColorToPot).toBe('black');
    expect(next.cueBallInHand).toBe(true);
    expect(next.balls.find(b => b.color === 'black')?.pocketed).toBe(false);
  });

  it('requires the nominated free ball to be hit first', () => {
    const balls = [ball(0, 'white'), ball(1, 'red'), ball(2, 'yellow')];
    const state = stateWith(balls, { phase: 'reds_phase', freeBall: true });
    const result = evaluateShot(state, shot(2), sim(balls, { first: 1 }));

    expect(result.fouls.some(f => f.type === 'wrong_ball_first_contact')).toBe(true);
  });

  it('scores and re-spots a free ball nominated as red', () => {
    const balls = [ball(0, 'white'), ball(1, 'red'), ball(2, 'yellow')];
    const state = stateWith(balls, { phase: 'reds_phase', freeBall: true });
    const simulation = sim(balls, { first: 2, potted: [2] });
    const result = evaluateShot(state, shot(2), simulation);
    const next = applyShotResult(state, shot(2), simulation, result, 'test');

    expect(result.fouls).toHaveLength(0);
    expect(result.pointsScored).toBe(1);
    expect(next.phase).toBe('color_after_red');
    expect(next.balls.find(b => b.id === 2)?.pocketed).toBe(false);
  });
});

// ============================================================
// Snooker Rules Engine
// Implements international snooker rules for frame play
// ============================================================

import type { Ball, BallColor, GameState, GamePhase, Player, ShotParams, ShotResult, ShotRecord, Foul, FoulType } from '../types';
import { BALL_VALUES, COLORS_ORDER, MIN_FOUL_POINTS, MAX_FOUL_POINTS } from '../types';
import { TABLE_WIDTH, TABLE_HEIGHT } from './constants';
import type { SimulationResult } from './physics';

/** Maximum points remaining on the table (reds + colors) */
export function maxPointsRemaining(balls: Ball[], phase: GamePhase): number {
  const redsOnTable = balls.filter(b => b.color === 'red' && !b.pocketed).length;

  if (phase === 'colors_phase' || redsOnTable === 0) {
    // Colors phase: yellow(2) + green(3) + brown(4) + blue(5) + pink(6) + black(7) = 27
    // Plus remaining colors on table
    let total = 0;
    for (const color of COLORS_ORDER) {
      const ballOnTable = balls.find(b => b.color === color && !b.pocketed);
      if (ballOnTable) total += BALL_VALUES[color];
    }
    return total;
  }

  // Reds phase: each red (1) + best color (black=7) per red
  return redsOnTable * (1 + 7) + COLORS_ORDER.reduce((sum, c) => {
    const ballOnTable = balls.find(b => b.color === c && !b.pocketed);
    return sum + (ballOnTable ? BALL_VALUES[c] : 0);
  }, 0);
}

/** Determine what ball the current player should hit first */
export function getRequiredFirstContact(state: GameState): { required: BallColor[]; description: string } {
  if (state.phase === 'break_off') {
    // On break-off, must hit a red
    return { required: ['red'], description: '开球必须先碰到红球' };
  }

  if (state.phase === 'reds_phase') {
    // When reds remain, must hit red first (unless after potting a red, must hit a color)
    const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
    if (redsOnTable > 0) {
      // Check if we're in "must play color" mode after potting a red
      const lastShot = state.shotHistory[state.shotHistory.length - 1];
      if (lastShot && lastShot.result.pottedBalls.some(b => b.color === 'red')) {
        // After potting a red, must hit a color
        return { required: COLORS_ORDER, description: '进球红球后必须先碰彩球' };
      }
      return { required: ['red'], description: '必须先碰红球' };
    }
  }

  if (state.phase === 'color_after_red') {
    return { required: COLORS_ORDER, description: '进球红球后必须选择一个彩球' };
  }

  if (state.phase === 'colors_phase') {
    // Must hit the next color in order
    if (state.nextColorToPot) {
      return { required: [state.nextColorToPot], description: `必须先碰${state.nextColorToPot}` };
    }
  }

  return { required: ['red'], description: '默认：必须先碰红球' };
}

/** Evaluate a shot result and apply rules */
export function evaluateShot(
  state: GameState,
  shotParams: ShotParams,
  simResult: SimulationResult,
): ShotResult {
  const fouls: Foul[] = [];
  let pointsScored = 0;
  const pottedBalls: Ball[] = [];

  // --- FOUL CHECKS ---

  // 1. Cue ball potted
  if (simResult.cueBallPotted) {
    fouls.push({
      type: 'cue_ball_potted',
      points: Math.max(MIN_FOUL_POINTS, BALL_VALUES.black),
      description: '主球落袋',
    });
  }

  // 2. No ball contacted
  if (simResult.firstContactBallId === null) {
    fouls.push({
      type: 'no_ball_contact',
      points: Math.max(MIN_FOUL_POINTS, BALL_VALUES.black),
      description: '主球未碰到任何球',
    });
  } else {
    // 3. Wrong ball first contact
    const required = getRequiredFirstContact(state);
    const firstBall = state.balls.find(b => b.id === simResult.firstContactBallId);
    if (firstBall && !required.required.includes(firstBall.color)) {
      const foulPoints = Math.max(MIN_FOUL_POINTS, BALL_VALUES[firstBall.color as BallColor] || 4);
      fouls.push({
        type: 'wrong_ball_first_contact',
        points: Math.max(foulPoints, MIN_FOUL_POINTS),
        description: `先碰了${firstBall.color}球，应该先碰${required.description}`,
      });
    }
  }

  // 4. No cushion hit after contact (and no ball potted)
  if (simResult.firstContactBallId !== null &&
    !simResult.cushionHitAfterContact &&
    simResult.pottedBalls.length === 0 &&
    !simResult.cueBallPotted) {
    fouls.push({
      type: 'no_cushion_after_contact',
      points: MIN_FOUL_POINTS,
      description: '碰球后没有球碰到库边且没有进球',
    });
  }

  // --- Calculate fouls penalty ---
  // Per rules: foul points = max of all fouls, or max of ball values involved, minimum 4
  let foulPoints = 0;
  if (fouls.length > 0) {
    foulPoints = Math.max(...fouls.map(f => f.points));
    // Also check if a potted ball has higher value
    for (const potted of simResult.pottedBalls) {
      foulPoints = Math.max(foulPoints, BALL_VALUES[potted.color as BallColor] || 0);
    }
    foulPoints = Math.max(foulPoints, MIN_FOUL_POINTS);
    foulPoints = Math.min(foulPoints, MAX_FOUL_POINTS);
  }

  // --- SCORING ---
  if (fouls.length === 0) {
    // Valid shot - count potted balls
    for (const potted of simResult.pottedBalls) {
      if (potted.color === 'white') continue; // Already handled as foul

      // Check if this pot was legal
      if (state.phase === 'reds_phase' || state.phase === 'break_off') {
        const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
        if (redsOnTable > 0) {
          // Can pot red or a color (but if we already potted a red this shot, only reds score)
          if (potted.color === 'red') {
            pointsScored += BALL_VALUES.red;
            pottedBalls.push(potted);
          } else {
            // Potting a color when reds are available - legal but only scores color value
            pointsScored += BALL_VALUES[potted.color as BallColor];
            pottedBalls.push(potted);
          }
        }
      }

      if (state.phase === 'colors_phase') {
        // Must pot colors in order
        const nextColor = state.nextColorToPot;
        if (nextColor && potted.color === nextColor) {
          pointsScored += BALL_VALUES[potted.color as BallColor];
          pottedBalls.push(potted);
        } else if (nextColor) {
          // Wrong color potted in colors phase
          fouls.push({
            type: 'wrong_ball_first_contact',
            points: Math.max(BALL_VALUES[potted.color as BallColor], MIN_FOUL_POINTS),
            description: `应该进球${nextColor}但进了${potted.color}`,
          });
          foulPoints = Math.max(foulPoints, BALL_VALUES[potted.color as BallColor]);
        }
      }
    }
  }

  return {
    pottedBalls,
    fouls,
    pointsScored,
    cueBallPotted: simResult.cueBallPotted,
    firstContactBallId: simResult.firstContactBallId,
  };
}

/** Apply shot result to game state, producing a new state */
export function applyShotResult(
  state: GameState,
  shotParams: ShotParams,
  simResult: SimulationResult,
  shotResult: ShotResult,
  llmReasoning: string,
): GameState {
  // Deep copy state
  const newState: GameState = {
    ...state,
    players: [
      { ...state.players[0] },
      { ...state.players[1] },
    ],
    balls: simResult.finalBalls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    shotHistory: [...state.shotHistory],
    frameScores: state.frameScores.map(f => [...f]) as [number, number][],
    statusMessage: '',
  };

  // Record the shot
  const record: ShotRecord = {
    playerIndex: state.currentPlayerIndex,
    shotParams,
    result: shotResult,
    ballPositionsBefore: state.balls.map(b => ({ id: b.id, pos: { ...b.pos } })),
    timestamp: Date.now(),
    llmReasoning,
  };
  newState.shotHistory.push(record);

  const currentPlayer = newState.players[state.currentPlayerIndex];

  // Apply fouls - points go to opponent
  if (shotResult.fouls.length > 0) {
    const opponentIndex = 1 - state.currentPlayerIndex;
    const foulPoints = Math.max(...shotResult.fouls.map(f => f.points));
    newState.players[opponentIndex].score += foulPoints;

    // Reset current player's break
    currentPlayer.currentBreak = 0;

    // Handle cue ball potted: re-spot cue ball in D-zone
    if (shotResult.cueBallPotted) {
      const cueBall = newState.balls.find(b => b.color === 'white');
      if (cueBall) {
        cueBall.pocketed = false;
        cueBall.pos = { x: TABLE_WIDTH / 2 + 120, y: TABLE_HEIGHT - 737 };
        cueBall.vel = { x: 0, y: 0 };
      }
    }

    // Switch to opponent
    newState.currentPlayerIndex = 1 - state.currentPlayerIndex;
    newState.statusMessage = `${currentPlayer.name} 犯规: ${shotResult.fouls.map(f => f.description).join(', ')} — 对手得${foulPoints}分`;
    newState.consecutiveFouls = state.currentPlayerIndex === newState.currentPlayerIndex
      ? state.consecutiveFouls + 1
      : 1;
  } else {
    // Valid shot
    if (shotResult.pointsScored > 0) {
      currentPlayer.score += shotResult.pointsScored;
      currentPlayer.currentBreak += shotResult.pointsScored;
      if (currentPlayer.currentBreak > currentPlayer.highestBreak) {
        currentPlayer.highestBreak = currentPlayer.currentBreak;
      }

      // Check if this was a free ball pot (after opponent foul)
      if (state.freeBall) {
        // Free ball: potted ball counts as the nominated ball
        newState.freeBall = false;
      }

      // Player continues (same turn)
      newState.statusMessage = `${currentPlayer.name} 进球! ${shotResult.pottedBalls.map(b => b.color).join(', ')} — 本杆${currentPlayer.currentBreak}分`;
    } else {
      // No pot, switch player
      currentPlayer.currentBreak = 0;
      newState.currentPlayerIndex = 1 - state.currentPlayerIndex;
      newState.statusMessage = `${currentPlayer.name} 未进球，换${newState.players[newState.currentPlayerIndex].name}出杆`;
    }

    newState.consecutiveFouls = 0;
  }

  // Re-spot color balls if potted while reds remain
  const redsOnTable = newState.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  if (redsOnTable > 0) {
    for (const potted of shotResult.pottedBalls) {
      if (potted.color !== 'red') {
        // Re-spot the color ball on its designated spot
        const colorBall = newState.balls.find(b => b.id === potted.id);
        if (colorBall) {
          colorBall.pocketed = false;
          const spot = getColorSpot(potted.color as BallColor);
          colorBall.pos = { x: spot[0], y: spot[1] };
          colorBall.vel = { x: 0, y: 0 };
        }
      }
    }
  }

  // Update reds remaining
  newState.redsRemaining = newState.balls.filter(b => b.color === 'red' && !b.pocketed).length;

  // Update game phase
  if (newState.redsRemaining === 0 && state.phase !== 'colors_phase' && state.phase !== 'game_over') {
    newState.phase = 'colors_phase';
    // Find next color to pot
    newState.nextColorToPot = findNextColor(newState.balls);
  } else if (state.phase === 'break_off') {
    newState.phase = 'reds_phase';
  } else {
    newState.phase = state.phase;
  }

  // In colors phase, track next color
  if (newState.phase === 'colors_phase') {
    newState.nextColorToPot = findNextColor(newState.balls);
  }

  // Check if game over (all colors potted in colors phase)
  if (newState.phase === 'colors_phase') {
    const colorsRemaining = COLORS_ORDER.filter(c =>
      newState.balls.find(b => b.color === c && !b.pocketed)
    );
    if (colorsRemaining.length === 0) {
      newState.phase = 'game_over';
      // Record frame score
      newState.frameScores.push([newState.players[0].score, newState.players[1].score]);
      const p0 = newState.players[0].score;
      const p1 = newState.players[1].score;
      if (p0 > p1) {
        newState.statusMessage = `第${newState.frameNumber}局结束! ${newState.players[0].name}获胜 (${p0}-${p1})`;
      } else if (p1 > p0) {
        newState.statusMessage = `第${newState.frameNumber}局结束! ${newState.players[1].name}获胜 (${p0}-${p1})`;
      } else {
        newState.statusMessage = `第${newState.frameNumber}局结束! 平局 (${p0}-${p1})`;
      }
    }
  }

  return newState;
}

/** Get the designated spot position for a color ball */
function getColorSpot(color: BallColor): [number, number] {
  switch (color) {
    case 'yellow': return [TABLE_WIDTH / 2 + 292, TABLE_HEIGHT - 737];
    case 'green': return [TABLE_WIDTH / 2 - 292, TABLE_HEIGHT - 737];
    case 'brown': return [TABLE_WIDTH / 2, TABLE_HEIGHT - 737];
    case 'blue': return [TABLE_WIDTH / 2, TABLE_HEIGHT / 2];
    case 'pink': return [TABLE_WIDTH / 2, 1270];
    case 'black': return [TABLE_WIDTH / 2, 324];
    default: return [TABLE_WIDTH / 2, TABLE_HEIGHT / 2];
  }
}

/** Find the next color ball to pot in order during colors phase */
function findNextColor(balls: Ball[]): BallColor | null {
  for (const color of COLORS_ORDER) {
    const ball = balls.find(b => b.color === color && !b.pocketed);
    if (ball) return color;
  }
  return null;
}

/** Create initial game state */
export function createInitialGameState(playerNames: [string, string], balls: Ball[]): GameState {
  return {
    players: [
      { name: playerNames[0], score: 0, currentBreak: 0, highestBreak: 0 },
      { name: playerNames[1], score: 0, currentBreak: 0, highestBreak: 0 },
    ],
    currentPlayerIndex: 0,
    balls,
    phase: 'break_off',
    redsRemaining: 15,
    nextColorToPot: null,
    consecutiveFouls: 0,
    freeBall: false,
    shotHistory: [],
    frameNumber: 1,
    frameScores: [],
    simulating: false,
    statusMessage: '比赛开始! 请等待AI决策...',
  };
}

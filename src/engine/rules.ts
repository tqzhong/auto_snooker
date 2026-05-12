// ============================================================
// Snooker Rules Engine — Full WPBSA 2024-25 Implementation
// Based on the official WPBSA Rules of Snooker
// ============================================================

import type { Ball, BallColor, GameState, GamePhase, ShotParams, ShotResult, ShotRecord, Foul } from '../types';
import { BALL_VALUES, COLORS_ORDER, MIN_FOUL_POINTS, MAX_FOUL_POINTS } from '../types';
import { BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS, BALL_RADIUS } from './constants';
import type { SimulationResult } from './physics';
import { distanceBetween, detectTouchingBalls, createInitialBalls } from './physics';
import { findReSpotPosition, findBestBaulkPosition, getColorSpot } from './re-spot';

// ============================================================
// Public API
// ============================================================

/** Maximum points remaining on the table */
export function maxPointsRemaining(balls: Ball[], phase: GamePhase): number {
  const redsOnTable = balls.filter(b => b.color === 'red' && !b.pocketed).length;

  if (phase === 'colors_phase' || redsOnTable === 0) {
    let total = 0;
    for (const color of COLORS_ORDER) {
      const ballOnTable = balls.find(b => b.color === color && !b.pocketed);
      if (ballOnTable) total += BALL_VALUES[color];
    }
    return total;
  }

  return redsOnTable * (1 + 7) + COLORS_ORDER.reduce((sum, c) => {
    const ballOnTable = balls.find(b => b.color === c && !b.pocketed);
    return sum + (ballOnTable ? BALL_VALUES[c] : 0);
  }, 0);
}

/** Determine what ball the current player should hit first */
export function getRequiredFirstContact(state: GameState): { required: BallColor[]; description: string } {
  // Free ball: player can hit any ball
  if (state.freeBall) {
    return { required: COLORS_ORDER.concat(['red']), description: 'Free Ball — 可以击打任意球' };
  }

  if (state.phase === 'break_off') {
    return { required: ['red'], description: '开球必须先碰到红球' };
  }

  if (state.phase === 'reds_phase') {
    const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
    if (redsOnTable > 0) {
      const lastShot = state.shotHistory[state.shotHistory.length - 1];
      if (lastShot && lastShot.result.pottedBalls.some(b => b.color === 'red')) {
        return { required: COLORS_ORDER, description: '进球红球后必须先碰彩球' };
      }
      return { required: ['red'], description: '必须先碰红球' };
    }
    if (wasColorAfterRedShot(state)) {
      return { required: COLORS_ORDER, description: '最后一颗红球后必须先碰彩球' };
    }
  }

  if (state.phase === 'color_after_red') {
    return { required: COLORS_ORDER, description: '进球红球后必须选择一个彩球' };
  }

  if (state.phase === 'colors_phase') {
    if (state.nextColorToPot) {
      return { required: [state.nextColorToPot], description: `必须先碰${state.nextColorToPot}` };
    }
  }

  return { required: ['red'], description: '默认：必须先碰红球' };
}

/** Evaluate a shot result and apply all WPBSA rules */
export function evaluateShot(
  state: GameState,
  shotParams: ShotParams,
  simResult: SimulationResult,
): ShotResult {
  const fouls: Foul[] = [];
  let pointsScored = 0;
  let foulPoints = 0;
  const pottedBalls: Ball[] = [];

  // --- FOUL CHECKS ---

  // 1. Cue ball potted (Section 6(a))
  if (simResult.cueBallPotted) {
    const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams));
    fouls.push({
      type: 'cue_ball_potted',
      points: penalty,
      description: `主球落袋，罚${penalty}分`,
    });
  }

  // 2. No ball contacted (Section 10)
  if (simResult.firstContactBallId === null) {
    const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams));
    fouls.push({
      type: 'no_ball_contact',
      points: penalty,
      description: `主球未碰到任何球，罚${penalty}分`,
    });
  } else {
    // 3. Wrong ball first contact (Section 10)
    const required = getRequiredFirstContact(state);
    const firstBall = state.balls.find(b => b.id === simResult.firstContactBallId);
    if (firstBall && !required.required.includes(firstBall.color)) {
      const foulPoints = Math.max(
        MIN_FOUL_POINTS,
        getBallOnPenaltyValue(state, shotParams),
        BALL_VALUES[firstBall.color as BallColor] || 0,
      );
      fouls.push({
        type: 'wrong_ball_first_contact',
        points: foulPoints,
        description: `先碰了${firstBall.color}球，应该先碰${required.description}，罚${foulPoints}分`,
      });
    }
  }

  // 4. Ball off table (Section 5(b))
  for (const offBall of simResult.offTableBalls) {
    if (offBall.color === 'white') continue; // Already handled as cue_ball_potted
    const penalty = Math.max(MIN_FOUL_POINTS, BALL_VALUES[offBall.color as BallColor] || 0);
    fouls.push({
      type: 'hit_off_table',
      points: penalty,
      description: `${offBall.color}球飞出球台，罚${penalty}分`,
    });
  }

  // 5. Touching ball violation (Section 4)
  if (state.touchingBalls.length > 0) {
    const touchingViolation = checkTouchingBallViolation(state, simResult);
    if (touchingViolation) {
      fouls.push(touchingViolation);
    }
  }

  // 6. Miss rule (Section 14) — called when player fails to hit the ball on
  const hasContactFoul = fouls.some(f =>
    f.type === 'no_ball_contact' || f.type === 'wrong_ball_first_contact'
  );
  if (hasContactFoul && state.missCount < 3) {
    fouls.push({
      type: 'miss',
      points: 0, // Miss itself doesn't add points, it just allows replay
      description: `Miss! 连续第${state.missCount + 1}次未击中目标球`,
    });
  }

  // --- SCORING (only if no fouls that result in penalty) ---
  const hasScoringFoul = fouls.some(f => f.points > 0);
  if (!hasScoringFoul) {
    // Valid shot - count potted balls
    for (const potted of simResult.pottedBalls) {
      if (potted.color === 'white') continue;

      if (state.phase === 'reds_phase' || state.phase === 'break_off') {
        const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
        const colorAfterRed = wasColorAfterRedShot(state);
        if (redsOnTable > 0 || colorAfterRed) {
          if (potted.color === 'red') {
            pointsScored += BALL_VALUES.red;
            pottedBalls.push(potted);
          } else if (colorAfterRed) {
            // Free ball: if active, the nominated ball value applies
            if (state.freeBall && state.freeBallNominee) {
              pointsScored += BALL_VALUES[state.freeBallNominee];
            } else {
              pointsScored += BALL_VALUES[potted.color as BallColor];
            }
            pottedBalls.push(potted);
          }
        }
      }

      if (state.phase === 'colors_phase') {
        const nextColor = state.nextColorToPot;
        if (nextColor && potted.color === nextColor) {
          pointsScored += BALL_VALUES[potted.color as BallColor];
          pottedBalls.push(potted);
        } else if (nextColor) {
          // Wrong color potted in colors phase - this is a foul
          const penalty = Math.max(
            BALL_VALUES[nextColor],
            BALL_VALUES[potted.color as BallColor],
            MIN_FOUL_POINTS,
          );
          fouls.push({
            type: 'wrong_ball_first_contact',
            points: penalty,
            description: `应该进球${nextColor}但进了${potted.color}，罚${penalty}分`,
          });
          foulPoints = Math.max(foulPoints, penalty);
        }
      }
    }
  }

  // 7. WPBSA Section 3(g)(i): If a player plays at a Red and simultaneously
  //    pots a Colour, the points for the Colour do not count and the Colour is spotted.
  //    This is a foul.
  if (!hasScoringFoul && (state.phase === 'reds_phase' || state.phase === 'break_off')) {
    const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
    const colorAfterRed = wasColorAfterRedShot(state);

    if (redsOnTable > 0 && !colorAfterRed) {
      // Player was playing at reds - check if any color was potted simultaneously
      const colorsPotted = simResult.pottedBalls.filter(b => b.color !== 'red' && b.color !== 'white');
      const redsPotted = simResult.pottedBalls.filter(b => b.color === 'red');

      if (colorsPotted.length > 0 && redsPotted.length > 0) {
        // Section 3(g)(i): Playing at red, simultaneously potted a colour
        // The colour points do not count, colour is spotted, AND it's a foul
        const penalty = Math.max(
          MIN_FOUL_POINTS,
          ...colorsPotted.map(c => BALL_VALUES[c.color as BallColor])
        );
        fouls.push({
          type: 'wrong_ball_first_contact',
          points: penalty,
          description: `击红球时意外带入${colorsPotted.map(c => c.color).join('、')}球，罚${penalty}分`,
        });
        foulPoints = Math.max(foulPoints, penalty);

        // Remove the color pots from scored points
        for (const colorBall of colorsPotted) {
          pointsScored -= BALL_VALUES[colorBall.color as BallColor];
        }
      }
    }
  }

  // Calculate final foul penalty (max of all fouls, min 4, max 7)
  if (fouls.length > 0) {
    const pointFouls = fouls.filter(f => f.points > 0);
    if (pointFouls.length > 0) {
      foulPoints = Math.max(...pointFouls.map(f => f.points));
    }
    for (const potted of simResult.pottedBalls) {
      if (potted.color !== 'white') {
        foulPoints = Math.max(foulPoints, BALL_VALUES[potted.color as BallColor] || 0);
      }
    }
    foulPoints = Math.max(foulPoints, MIN_FOUL_POINTS);
    foulPoints = Math.min(foulPoints, MAX_FOUL_POINTS);
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
    freeBall: false,
    freeBallNominee: null,
    missCount: state.missCount,
    lastFoulPosition: state.lastFoulPosition,
    touchingBalls: [],
    stalemateCount: state.stalemateCount,
    breakCushionHits: state.breakCushionHits,
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

  // --- APPLY FOULS ---
  const hasScoringFoul = shotResult.fouls.some(f => f.points > 0);
  if (hasScoringFoul) {
    const opponentIndex = 1 - state.currentPlayerIndex;
    const foulPoints = Math.max(...shotResult.fouls.filter(f => f.points > 0).map(f => f.points));
    newState.players[opponentIndex].score += foulPoints;
    currentPlayer.currentBreak = 0;

    // Re-spot cue ball if potted or off table
    if (shotResult.cueBallPotted) {
      const cueBall = newState.balls.find(b => b.color === 'white');
      if (cueBall) {
        cueBall.pocketed = false;
        // Strategic baulk placement
        const required = getRequiredFirstContact(newState);
        const baulkPos = findBestBaulkPosition(newState.balls, required.required);
        cueBall.pos = baulkPos;
        cueBall.vel = { x: 0, y: 0 };
      }
    }

    // Store foul position for miss rule replay
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (cueBall) {
      newState.lastFoulPosition = { ...cueBall.pos };
    }

    // Miss rule: track consecutive misses
    const isMiss = shotResult.fouls.some(f => f.type === 'miss');
    if (isMiss) {
      newState.missCount = state.missCount + 1;
      // 4th consecutive miss: frame awarded to opponent
      if (newState.missCount >= 4) {
        newState.phase = 'game_over';
        newState.frameScores.push([newState.players[0].score, newState.players[1].score]);
        newState.players[opponentIndex].score = Math.max(
          newState.players[0].score,
          newState.players[1].score,
        ) + 1; // Ensure opponent wins
        newState.statusMessage = `${currentPlayer.name} 连续4次Miss，${newState.players[opponentIndex].name}赢得本局`;
        return newState;
      }
    } else {
      newState.missCount = 0;
    }

    // Re-spot off-table balls
    for (const offBall of simResult.offTableBalls) {
      if (offBall.color === 'white') continue;
      const ball = newState.balls.find(b => b.id === offBall.id);
      if (ball) {
        ball.pocketed = false;
        const spot = findReSpotPosition(offBall.color as BallColor, newState.balls);
        ball.pos = spot;
        ball.vel = { x: 0, y: 0 };
      }
    }

    // Check free ball: if cue ball is snookered after a foul
    if (isIncomingPlayerSnookered(newState, simResult)) {
      newState.freeBall = true;
      newState.statusMessage += ' — Free Ball!';
    }

    // Switch to opponent
    newState.currentPlayerIndex = 1 - state.currentPlayerIndex;
    if (!newState.statusMessage) {
      newState.statusMessage = `${currentPlayer.name} 犯规: ${shotResult.fouls.filter(f => f.points > 0).map(f => f.description).join(', ')} — 对手得${foulPoints}分`;
    }

    // Consecutive fouls tracking (Section 14)
    const isSamePlayerAgain = state.currentPlayerIndex === newState.currentPlayerIndex;
    newState.consecutiveFouls = isSamePlayerAgain ? state.consecutiveFouls + 1 : 1;

    if (newState.consecutiveFouls >= 4) {
      // Frame awarded to opponent
      newState.phase = 'game_over';
      newState.frameScores.push([newState.players[0].score, newState.players[1].score]);
      const opponent = newState.players[1 - state.currentPlayerIndex];
      newState.statusMessage = `${currentPlayer.name} 连续犯规4次，${opponent.name}赢得本局`;
      return newState;
    }
    if (newState.consecutiveFouls >= 3) {
      newState.statusMessage += ' ⚠️ 连续犯规3次警告！再次犯规将判负';
    }
  } else {
    // --- VALID SHOT ---
    if (shotResult.pointsScored > 0) {
      currentPlayer.score += shotResult.pointsScored;
      currentPlayer.currentBreak += shotResult.pointsScored;
      if (currentPlayer.currentBreak > currentPlayer.highestBreak) {
        currentPlayer.highestBreak = currentPlayer.currentBreak;
      }

      // Clear free ball after use
      if (state.freeBall) {
        newState.freeBall = false;
        newState.freeBallNominee = null;
      }

      // Reset stalemate count on scoring
      newState.stalemateCount = 0;
      // Reset miss count on successful play
      newState.missCount = 0;

      newState.statusMessage = `${currentPlayer.name} 进球! ${shotResult.pottedBalls.map(b => b.color).join(', ')} — 本杆${currentPlayer.currentBreak}分`;
    } else {
      // No pot, switch player
      currentPlayer.currentBreak = 0;
      newState.currentPlayerIndex = 1 - state.currentPlayerIndex;
      newState.statusMessage = `${currentPlayer.name} 未进球，换${newState.players[newState.currentPlayerIndex].name}出杆`;

      // Stalemate detection (Section 3)
      newState.stalemateCount = state.stalemateCount + 1;
      if (newState.stalemateCount >= 6) {
        newState.statusMessage = '僵局! 重新开始本局';
        return createInitialGameState(
          [state.players[0].name, state.players[1].name],
          createInitialBalls()
        );
      }
    }

    newState.consecutiveFouls = 0;
    newState.missCount = 0;
  }

  // --- RE-SPOT COLORS ---
  // WPBSA Section 3(c): colours are spotted while reds remain on the table
  const redsOnTableBefore = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const colorAfterRed = wasColorAfterRedShot(state);
  if (redsOnTableBefore > 0 || colorAfterRed) {
    for (const potted of shotResult.pottedBalls) {
      if (potted.color !== 'red') {
        const colorBall = newState.balls.find(b => b.id === potted.id);
        if (colorBall) {
          colorBall.pocketed = false;
          const spot = findReSpotPosition(potted.color as BallColor, newState.balls);
          colorBall.pos = spot;
          colorBall.vel = { x: 0, y: 0 };
        }
      }
    }
  }

  // --- PHASE TRANSITIONS ---
  newState.redsRemaining = newState.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const pottedARedThisShot = shotResult.pottedBalls.some(b => b.color === 'red');

  if (newState.redsRemaining === 0 && !pottedARedThisShot && state.phase !== 'colors_phase' && state.phase !== 'game_over') {
    newState.phase = 'colors_phase';
    newState.nextColorToPot = findNextColor(newState.balls);
  } else if (newState.redsRemaining === 0 && pottedARedThisShot) {
    newState.phase = 'reds_phase';
  } else if (state.phase === 'break_off') {
    newState.phase = 'reds_phase';
  } else {
    newState.phase = state.phase;
  }

  if (newState.phase === 'colors_phase') {
    newState.nextColorToPot = findNextColor(newState.balls);
  }

  // --- TOUCHING BALL DETECTION ---
  newState.touchingBalls = detectTouchingBalls(newState.balls);

  // --- GAME OVER CHECK ---
  if (newState.phase === 'colors_phase') {
    const colorsRemaining = COLORS_ORDER.filter(c =>
      newState.balls.find(b => b.color === c && !b.pocketed)
    );
    if (colorsRemaining.length === 0) {
      newState.phase = 'game_over';
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
    freeBallNominee: null,
    missCount: 0,
    lastFoulPosition: null,
    touchingBalls: [],
    stalemateCount: 0,
    breakCushionHits: 0,
    shotHistory: [],
    frameNumber: 1,
    frameScores: [],
    simulating: false,
    statusMessage: '比赛开始! 请等待AI决策...',
  };
}

// ============================================================
// Internal helpers
// ============================================================

function getTargetBall(state: GameState, shotParams: ShotParams): Ball | undefined {
  return state.balls.find(b => b.id === shotParams.targetBallId && !b.pocketed);
}

function getBallOnPenaltyValue(state: GameState, shotParams: ShotParams): number {
  const required = getRequiredFirstContact(state);
  const targetBall = getTargetBall(state, shotParams);

  if (targetBall && required.required.includes(targetBall.color)) {
    return BALL_VALUES[targetBall.color] || MIN_FOUL_POINTS;
  }

  if (required.required.length === 1) {
    return BALL_VALUES[required.required[0]] || MIN_FOUL_POINTS;
  }

  return MIN_FOUL_POINTS;
}

function wasColorAfterRedShot(state: GameState): boolean {
  const lastShot = state.shotHistory[state.shotHistory.length - 1];
  return state.phase === 'reds_phase' &&
    Boolean(lastShot?.result.pottedBalls.some(b => b.color === 'red'));
}

function findNextColor(balls: Ball[]): BallColor | null {
  for (const color of COLORS_ORDER) {
    const ball = balls.find(b => b.color === color && !b.pocketed);
    if (ball) return color;
  }
  return null;
}

/** Check if the incoming player is snookered (for free ball determination) */
function isIncomingPlayerSnookered(state: GameState, simResult: SimulationResult): boolean {
  const cueBall = simResult.finalBalls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return false;

  // Determine what balls the incoming player needs to hit
  const nextState: GameState = { ...state, balls: simResult.finalBalls };
  const required = getRequiredFirstContact(nextState);

  // Check if every required ball is blocked (no direct line of sight)
  return required.required.every(color => {
    const targets = simResult.finalBalls.filter(b => b.color === color && !b.pocketed);
    return targets.every(target => !hasDirectLineOfSight(cueBall, target, simResult.finalBalls));
  });
}

/** Check if there's a direct line of sight between two balls */
function hasDirectLineOfSight(from: Ball, to: Ball, allBalls: Ball[]): boolean {
  const dx = to.pos.x - from.pos.x;
  const dy = to.pos.y - from.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return true;

  const ux = dx / dist;
  const uy = dy / dist;

  for (const ball of allBalls) {
    if (ball.pocketed || ball.id === from.id || ball.id === to.id) continue;
    const bx = ball.pos.x - from.pos.x;
    const by = ball.pos.y - from.pos.y;
    const proj = bx * ux + by * uy;
    if (proj <= 0 || proj >= dist) continue;
    const perp = Math.abs(bx * (-uy) + by * ux);
    if (perp < BALL_RADIUS * 2.2) return false;
  }
  return true;
}

/** Check touching ball violation */
function checkTouchingBallViolation(state: GameState, simResult: SimulationResult): Foul | null {
  if (state.touchingBalls.length === 0) return null;

  const required = getRequiredFirstContact(state);
  const cueBall = simResult.finalBalls.find(b => b.color === 'white');
  if (!cueBall) return null;

  // If the touching ball is the ball-on, player must play towards it (valid)
  // If the touching ball is NOT the ball-on, player must play away without moving it
  const touchingIsBallOn = state.touchingBalls.some(id => {
    const ball = state.balls.find(b => b.id === id);
    return ball && required.required.includes(ball.color);
  });

  if (touchingIsBallOn) return null; // Valid: touching ball is the ball-on

  // Check if any touching ball was moved
  for (const touchingId of state.touchingBalls) {
    const before = state.balls.find(b => b.id === touchingId);
    const after = simResult.finalBalls.find(b => b.id === touchingId);
    if (before && after) {
      const moved = distanceBetween(before.pos, after.pos) > 1;
      if (moved) {
        const penalty = Math.max(MIN_FOUL_POINTS, BALL_VALUES[before.color as BallColor] || 0);
        return {
          type: 'touching_ball_violation',
          points: penalty,
          description: `移动了接触中的${before.color}球，罚${penalty}分`,
        };
      }
    }
  }

  return null;
}

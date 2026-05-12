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
    // §3(g): Until all Reds are off the table, Red is the ball on
    return { required: ['red'], description: '必须先碰红球' };
  }

  if (state.phase === 'color_after_red') {
    // §3(h)(i): After potting a red, next ball on is a colour of the striker's choice
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

  // 6. Miss rule (Section 14)
  // Only called when:
  //   (a) player failed to hit ball-on (no_ball_contact or wrong_ball_first_contact)
  //   (b) there IS a clear path to a ball-on (§14(c))
  //   (c) the score difference does not exceed remaining points (§14(a)(i) exception)
  const hasContactFoul = fouls.some(f =>
    f.type === 'no_ball_contact' || f.type === 'wrong_ball_first_contact'
  );
  if (hasContactFoul) {
    // §14(a)(i) exception: if a player requires more points than remaining
    // and the miss was not intentional, miss is not called
    const opponent = state.players[1 - state.currentPlayerIndex];
    const player = state.players[state.currentPlayerIndex];
    const trailingByMoreThanRemaining = Math.abs(player.score - opponent.score) > maxPointsRemaining(state.balls, state.phase);

    // §14(c)/(d): Only call miss if there is a clear path to ball-on
    const hasClearPath = checkClearPathToBallOn(state, simResult);

    // Miss is NOT called if:
    // - trailing by more than remaining points (§14(a)(i))
    // - no clear path exists (§14(a)(ii))
    if (!trailingByMoreThanRemaining && hasClearPath) {
      fouls.push({
        type: 'miss',
        points: 0, // Miss itself doesn't add points, it just allows replay
        description: `Miss! 连续第${state.missCount + 1}次未击中目标球`,
      });
    }
  }

  // --- SCORING (only if no fouls that result in penalty) ---
  const hasScoringFoul = fouls.some(f => f.points > 0);
  if (!hasScoringFoul) {
    // Valid shot - count potted balls
    for (const potted of simResult.pottedBalls) {
      if (potted.color === 'white') continue;

      if (state.phase === 'reds_phase' || state.phase === 'break_off') {
        // §3(g): Red is ball on → pot reds for 1 point each
        if (potted.color === 'red') {
          pointsScored += BALL_VALUES.red;
          pottedBalls.push(potted);
        }
      } else if (state.phase === 'color_after_red') {
        // §3(h)(i): After potting red, colour of striker's choice is ball on
        if (potted.color !== 'red') {
          // §12(a)(ii): Free ball acquires the value of the ball on, not its own value
          const ballOnValue = getBallOnValue(state);
          pointsScored += ballOnValue;
          pottedBalls.push(potted);
        }
      }

      if (state.phase === 'colors_phase') {
        const nextColor = state.nextColorToPot;
        if (nextColor && potted.color === nextColor) {
          pointsScored += BALL_VALUES[potted.color as BallColor];
          pottedBalls.push(potted);
        } else if (nextColor) {
          // §11(b)(iii): causing a ball not on to be pocketed
          // Penalty = value of the ball on or the ball concerned, whichever is higher
          const penalty = Math.max(
            BALL_VALUES[nextColor],
            BALL_VALUES[potted.color as BallColor],
            MIN_FOUL_POINTS,
          );
          fouls.push({
            type: 'ball_not_on_pocketed',
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
  //    This is a foul. (Checked regardless of other fouls — affects re-spot logic)
  if (state.phase === 'reds_phase' || state.phase === 'break_off') {
    // Only applies when player is playing at reds (not after potting a red)
    // phase === 'reds_phase' or 'break_off' means Red is the ball on
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

    // Miss rule (§14): track consecutive misses
    // §14(d)(i): 2nd failure from original position → must be Warned
    // §14(d)(ii): 3rd failure after Warning → frame awarded to opponent
    const isMiss = shotResult.fouls.some(f => f.type === 'miss');
    if (isMiss) {
      newState.missCount = state.missCount + 1;
      if (newState.missCount === 2) {
        // §14(d)(ii): 2nd miss — warn the player
        newState.statusMessage += ` ⚠️ Miss警告！再次Miss将判负`;
      }
      if (newState.missCount >= 3) {
        // §14(d)(ii): 3rd miss after warning → frame awarded to opponent
        newState.phase = 'game_over';
        newState.frameScores.push([newState.players[0].score, newState.players[1].score]);
        newState.players[opponentIndex].score = Math.max(
          newState.players[0].score,
          newState.players[1].score,
        ) + 1; // Ensure opponent wins
        newState.statusMessage = `${currentPlayer.name} 连续3次Miss（已警告），${newState.players[opponentIndex].name}赢得本局`;
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

    newState.missCount = 0;
  }

  // --- RE-SPOT COLORS ---
  // WPBSA §7: colours are spotted while reds remain on the table,
  // or when in color_after_red phase (last red was just potted, playing at colour)
  const redsOnTableBefore = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const needsReSpot = redsOnTableBefore > 0 || state.phase === 'color_after_red';
  if (needsReSpot) {
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
  // WPBSA §3(g)/(h): Phase flow
  //   break_off → potted red → color_after_red
  //   reds_phase → potted red → color_after_red
  //   color_after_red → potted color → reds_phase (if reds remain) or colors_phase (if no reds)
  //   reds_phase → no pot → opponent's turn, stay reds_phase
  newState.redsRemaining = newState.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const pottedARedThisShot = shotResult.pottedBalls.some(b => b.color === 'red');
  const pottedAColorThisShot = shotResult.pottedBalls.some(b => b.color !== 'red' && b.color !== 'white');

  if (hasScoringFoul) {
    // Foul: phase doesn't advance — opponent plays from current state
    // Keep phase as-is (or revert to reds_phase if was color_after_red)
    if (state.phase === 'color_after_red') {
      // §3 Rule 10(i)(iii): after foul in color_after_red, ball-on becomes
      // "a colour of the striker's choice" for the opponent
      newState.phase = 'color_after_red'; // opponent also needs to play a color
    } else {
      newState.phase = state.phase;
    }
  } else if (pottedARedThisShot) {
    // §3(h)(i): Red potted → next ball on is a colour of striker's choice
    newState.phase = 'color_after_red';
  } else if (state.phase === 'color_after_red' && pottedAColorThisShot) {
    // §3(h)(ii)/(iii): Colour potted after red → continue with reds or colors phase
    if (newState.redsRemaining > 0) {
      newState.phase = 'reds_phase';
    } else {
      newState.phase = 'colors_phase';
      newState.nextColorToPot = findNextColor(newState.balls);
    }
  } else if (state.phase === 'color_after_red' && !pottedAColorThisShot) {
    // Didn't pot the color → opponent's turn, still need to play a color
    newState.phase = 'color_after_red';
  } else if (newState.redsRemaining === 0 && state.phase !== 'colors_phase' && state.phase !== 'game_over') {
    // All reds gone (last red was potted earlier) → colors phase
    newState.phase = 'colors_phase';
    newState.nextColorToPot = findNextColor(newState.balls);
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
  // WPBSA §4(a): When Black is the only object ball remaining, first pot or foul
  // ends the frame EXCEPT when scores are equal and aggregate not relevant.
  // §4(b): If equal → re-spot Black, draw lots, play from in-hand, first pot/foul ends frame.
  if (newState.phase === 'colors_phase') {
    const colorsRemaining = COLORS_ORDER.filter(c =>
      newState.balls.find(b => b.color === c && !b.pocketed)
    );
    if (colorsRemaining.length === 0) {
      const p0 = newState.players[0].score;
      const p1 = newState.players[1].score;

      if (p0 === p1) {
        // §4(b): Scores equal — re-spot the Black
        const blackBall = newState.balls.find(b => b.color === 'black');
        if (blackBall) {
          blackBall.pocketed = false;
          blackBall.pos = { x: 324, y: CENTER_Y }; // Black spot
          blackBall.vel = { x: 0, y: 0 };
        }
        // Random choice of next player (§4(b)(ii))
        newState.currentPlayerIndex = Math.random() < 0.5 ? 0 : 1;
        // Reset cue ball to in-hand
        const cueBall = newState.balls.find(b => b.color === 'white');
        if (cueBall) {
          cueBall.pocketed = false;
          cueBall.pos = { x: BAULK_LINE_X, y: CENTER_Y + D_ZONE_RADIUS * 0.4 };
          cueBall.vel = { x: 0, y: 0 };
        }
        // Stay in colors_phase so the re-spotted Black is the next target
        newState.nextColorToPot = 'black';
        newState.statusMessage = `比分平局! 黑球已放回，${newState.players[newState.currentPlayerIndex].name}先手`;
      } else {
        // §4(a): Scores not equal — frame ends
        newState.phase = 'game_over';
        newState.frameScores.push([p0, p1]);
        if (p0 > p1) {
          newState.statusMessage = `第${newState.frameNumber}局结束! ${newState.players[0].name}获胜 (${p0}-${p1})`;
        } else {
          newState.statusMessage = `第${newState.frameNumber}局结束! ${newState.players[1].name}获胜 (${p0}-${p1})`;
        }
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

/** Get the current ball-on's scoring value (§12(a)(ii): free ball acquires ball-on value) */
function getBallOnValue(state: GameState): number {
  const required = getRequiredFirstContact(state);
  if (required.required.length === 1) {
    return BALL_VALUES[required.required[0]] || MIN_FOUL_POINTS;
  }
  // Multiple possible ball-ons (e.g., reds phase) — use ball-on value
  if (state.phase === 'reds_phase' || state.phase === 'break_off') {
    return BALL_VALUES.red; // Ball-on is red = 1 point
  }
  return MIN_FOUL_POINTS;
}

function findNextColor(balls: Ball[]): BallColor | null {
  for (const color of COLORS_ORDER) {
    const ball = balls.find(b => b.color === color && !b.pocketed);
    if (ball) return color;
  }
  return null;
}

/**
 * Check if there is a clear path from the cue ball to any ball-on (§14(c)(d)).
 * Returns true if full-ball contact is available on at least one ball-on
 * (i.e., no obstructing ball blocks the path).
 */
function checkClearPathToBallOn(state: GameState, simResult: SimulationResult): boolean {
  const cueBall = simResult.finalBalls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return false;

  const required = getRequiredFirstContact(state);
  const allBalls = simResult.finalBalls.filter(b => !b.pocketed);

  for (const color of required.required) {
    const targets = allBalls.filter(b => b.color === color && b.color !== 'white');
    for (const target of targets) {
      if (hasDirectLineOfSight(cueBall, target, allBalls)) {
        return true; // At least one ball-on has a clear path
      }
    }
  }
  return false;
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

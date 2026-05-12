// ============================================================
// Snooker Rules Engine — Full WPBSA 2024-25 Implementation
// Based on the official WPBSA Rules of Snooker
// ============================================================

import type { Ball, BallColor, GameState, GamePhase, ShotParams, ShotResult, ShotRecord, Foul } from '../types';
import { BALL_VALUES, COLORS_ORDER, MIN_FOUL_POINTS, MAX_FOUL_POINTS } from '../types';
import { BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS, BALL_RADIUS } from './constants';
import type { SimulationResult } from './physics';
import { distanceBetween, detectTouchingBalls, createInitialBalls } from './physics';
import { findReSpotPosition, findBestBaulkPosition } from './re-spot';

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
  if (state.freeBall) {
    const ballOn = getNaturalBallOnColors(state);
    return {
      required: ballOn,
      description: 'Free Ball — 必须先碰提名自由球，或与目标球同时接触',
    };
  }

  const required = getNaturalBallOnColors(state);
  if (required.length === 1 && required[0] === 'red') {
    return { required: ['red'], description: '必须先碰红球' };
  }
  if (state.phase === 'color_after_red') {
    return { required: COLORS_ORDER, description: '进球红球后必须选择一个彩球' };
  }
  if (required.length === 1) {
    return { required, description: `必须先碰${required[0]}` };
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
  const pottedBalls: Ball[] = [];
  const nominatedFreeBall = getNominatedFreeBall(state, shotParams);
  const firstContactIds = getFirstContactIds(simResult);
  const firstContactBalls = firstContactIds
    .map(id => state.balls.find(b => b.id === id))
    .filter((b): b is Ball => Boolean(b));
  const hasLegalTouchingBall = hasTouchingBallThatIsOrCouldBeOn(state, shotParams);

  // --- FOUL CHECKS ---

  if (state.cueBallInHand && !isCueBallInD(state.balls)) {
    const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams));
    fouls.push({
      type: 'improper_in_hand',
      points: penalty,
      description: `主球未从D区内开打，罚${penalty}分`,
    });
  }

  // 1. Cue ball potted (§3 Rule 11(a)(vii))
  if (simResult.cueBallPotted) {
    const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams));
    fouls.push({
      type: 'cue_ball_potted',
      points: penalty,
      description: `主球落袋，罚${penalty}分`,
    });
  }

  // 2. No ball contacted (§3 Rule 11(a)(vi)). A legal touching-ball
  // position counts as the ball on already being contacted, provided it
  // is played away without moving the touching object ball.
  if (firstContactIds.length === 0 && !hasLegalTouchingBall) {
    const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams));
    fouls.push({
      type: 'no_ball_contact',
      points: penalty,
      description: `主球未碰到任何球，罚${penalty}分`,
    });
  } else {
    const contactFoul = checkFirstContact(state, shotParams, firstContactBalls, nominatedFreeBall);
    if (contactFoul) fouls.push(contactFoul);

    const simultaneousFoul = checkSimultaneousFirstContact(state, shotParams, firstContactBalls, nominatedFreeBall);
    if (simultaneousFoul) fouls.push(simultaneousFoul);
  }

  // 3. Ball not on pocketed (§3 Rule 11(b)(iii))
  for (const potted of simResult.pottedBalls) {
    if (potted.color === 'white') continue;
    if (!isPottedBallLegal(state, shotParams, potted, nominatedFreeBall)) {
      const penalty = Math.max(
        MIN_FOUL_POINTS,
        getBallOnPenaltyValue(state, shotParams),
        BALL_VALUES[potted.color],
      );
      fouls.push({
        type: 'ball_not_on_pocketed',
        points: penalty,
        description: `${potted.color}不是目标球却落袋，罚${penalty}分`,
      });
    }
  }

  // 4. Ball off table (§3 Rule 11(b)(x))
  for (const offBall of simResult.offTableBalls) {
    if (offBall.color === 'white') continue; // Already handled as cue_ball_potted
    const penalty = Math.max(
      MIN_FOUL_POINTS,
      getBallOnPenaltyValue(state, shotParams),
      BALL_VALUES[offBall.color],
    );
    fouls.push({
      type: 'hit_off_table',
      points: penalty,
      description: `${offBall.color}球飞出球台，罚${penalty}分`,
    });
  }

  // 5. Touching ball violation (§3 Rule 8(b), §2 Rule 19)
  if (state.touchingBalls.length > 0) {
    const touchingViolation = checkTouchingBallViolation(state, simResult);
    if (touchingViolation) {
      fouls.push(touchingViolation);
    }
  }

  // 6. Miss rule (§3 Rule 14)
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
    const anyPlayerNeedsPenaltyPoints = Math.abs(player.score - opponent.score) > maxPointsRemaining(state.balls, state.phase);

    // §14(c)/(d): Only call miss if there is a clear path to ball-on
    const hasClearPath = checkClearPathToBallOn(state, simResult);

    // Miss is NOT called if:
    // - trailing by more than remaining points (§14(a)(i))
    // - no clear path exists (§14(a)(ii))
    if (!anyPlayerNeedsPenaltyPoints && hasClearPath) {
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
    const scoring = scoreLegalPots(state, shotParams, simResult.pottedBalls, nominatedFreeBall);
    pointsScored = scoring.points;
    pottedBalls.push(...scoring.balls);

    const freeBallSnookerFoul = checkFreeBallSnooker(state, shotParams, simResult, nominatedFreeBall, pointsScored);
    if (freeBallSnookerFoul) {
      fouls.push(freeBallSnookerFoul);
      pointsScored = 0;
      pottedBalls.length = 0;
    }
  }

  // Calculate final foul penalty (max of all fouls, min 4, max 7)
  if (fouls.length > 0) {
    const pointFouls = fouls.filter(f => f.points > 0);
    if (pointFouls.length > 0) {
      const finalPenalty = Math.min(
        MAX_FOUL_POINTS,
        Math.max(MIN_FOUL_POINTS, ...pointFouls.map(f => f.points)),
      );
      for (const foul of pointFouls) foul.points = finalPenalty;
      pointsScored = 0;
      pottedBalls.length = 0;
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
    freeBall: false,
    freeBallNominee: null,
    missCount: state.missCount,
    missWarningIssued: state.missWarningIssued,
    cueBallInHand: false,
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
  const blackOnlyBefore = isBlackOnlyObjectBall(state.balls);

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
        newState.cueBallInHand = true;
      }
    }

    // Store foul position for miss rule replay
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (cueBall) {
      newState.lastFoulPosition = { ...cueBall.pos };
    }

    // Miss rule (§3 Rule 14): track calls and warnings. A frame is only
    // awarded after the non-offender asks for play from the original
    // position and a Warning has actually been issued; this autonomous
    // loop does not make that election for the player.
    const isMiss = shotResult.fouls.some(f => f.type === 'miss');
    if (isMiss) {
      newState.missCount = state.missCount + 1;
      if (newState.missCount >= 2) {
        newState.missWarningIssued = true;
        newState.statusMessage += ` Miss警告：若从原位重打后再次失败，可判负`;
      }
    } else {
      newState.missCount = 0;
      newState.missWarningIssued = false;
    }

    // Switch to opponent
    newState.currentPlayerIndex = 1 - state.currentPlayerIndex;
    const foulSummary = `${currentPlayer.name} 犯规: ${shotResult.fouls.filter(f => f.points > 0).map(f => f.description).join(', ')} — 对手得${foulPoints}分`;
    newState.statusMessage = newState.statusMessage
      ? `${foulSummary} ${newState.statusMessage}`
      : foulSummary;

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
      newState.missWarningIssued = false;

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
    newState.missWarningIssued = false;
  }

  // --- RE-SPOT COLORS ---
  reSpotRequiredColors(state, newState, simResult, shotResult, hasScoringFoul);

  // --- PHASE TRANSITIONS ---
  // WPBSA §3(g)/(h): Phase flow
  //   break_off → potted red → color_after_red
  //   reds_phase → potted red → color_after_red
  //   color_after_red → potted color → reds_phase (if reds remain) or colors_phase (if no reds)
  //   reds_phase → no pot → opponent's turn, stay reds_phase
  newState.redsRemaining = newState.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  const nominatedFreeBall = getNominatedFreeBall(state, shotParams);
  const pottedFreeBallAsRed = Boolean(
    nominatedFreeBall &&
    getNaturalBallOnColors(state).includes('red') &&
    shotResult.pottedBalls.some(b => b.id === nominatedFreeBall.id)
  );
  const pottedARedThisShot = shotResult.pottedBalls.some(b => b.color === 'red') || pottedFreeBallAsRed;
  const pottedAColorThisShot = shotResult.pottedBalls.some(b => b.color !== 'red' && b.color !== 'white');

  if (hasScoringFoul) {
    newState.phase = phaseForIncomingTurnAfterBreakEnds(state, newState);
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
    newState.phase = phaseForIncomingTurnAfterBreakEnds(state, newState);
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
  } else {
    newState.nextColorToPot = null;
  }

  // Check free ball after the foul position and phase for the incoming
  // player are known (§3 Rule 12).
  if (hasScoringFoul && newState.phase !== 'game_over' && isIncomingPlayerSnookered(newState, newState.balls)) {
    newState.freeBall = true;
    newState.statusMessage += ' — Free Ball!';
  }

  // --- TOUCHING BALL DETECTION ---
  newState.touchingBalls = detectTouchingBalls(newState.balls);

  // --- GAME OVER CHECK ---
  // WPBSA §4(a): When Black is the only object ball remaining, first pot or foul
  // ends the frame EXCEPT when scores are equal and aggregate not relevant.
  // §4(b): If equal → re-spot Black, draw lots, play from in-hand, first pot/foul ends frame.
  const blackPotted = simResult.pottedBalls.some(b => b.color === 'black');
  if (
    (blackOnlyBefore && (hasScoringFoul || blackPotted)) ||
    (newState.phase === 'colors_phase' && findNextColor(newState.balls) === null)
  ) {
    settleFrameAfterFinalBlack(newState);
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
    missWarningIssued: false,
    cueBallInHand: true,
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

function getNaturalBallOnColors(state: GameState): BallColor[] {
  if (state.phase === 'break_off' || state.phase === 'reds_phase') return ['red'];
  if (state.phase === 'color_after_red') {
    return COLORS_ORDER.filter(color => state.balls.some(b => b.color === color && !b.pocketed));
  }
  if (state.phase === 'colors_phase' && state.nextColorToPot) return [state.nextColorToPot];
  return ['red'];
}

function getBallOnPenaltyValue(state: GameState, shotParams: ShotParams): number {
  const requiredColors = getNaturalBallOnColors(state);
  const targetBall = getTargetBall(state, shotParams);

  if (targetBall && requiredColors.includes(targetBall.color)) {
    return BALL_VALUES[targetBall.color];
  }

  if (requiredColors.length === 1) {
    return BALL_VALUES[requiredColors[0]];
  }

  return MIN_FOUL_POINTS;
}

/** Get the current ball-on's scoring value (§12(a)(ii): free ball acquires ball-on value) */
function getBallOnValue(state: GameState, shotParams?: ShotParams): number {
  const requiredColors = getNaturalBallOnColors(state);
  const targetBall = shotParams ? getTargetBall(state, shotParams) : undefined;
  if (targetBall && requiredColors.includes(targetBall.color)) {
    return BALL_VALUES[targetBall.color];
  }
  if (requiredColors.length === 1) {
    return BALL_VALUES[requiredColors[0]];
  }
  return MIN_FOUL_POINTS;
}

function getNominatedFreeBall(state: GameState, shotParams: ShotParams): Ball | null {
  if (!state.freeBall) return null;
  const targetBall = getTargetBall(state, shotParams);
  if (!targetBall || targetBall.color === 'white') return null;
  return getNaturalBallOnColors(state).includes(targetBall.color) ? null : targetBall;
}

function getFirstContactIds(simResult: SimulationResult): number[] {
  if (simResult.firstContactBallIds?.length) return simResult.firstContactBallIds;
  return simResult.firstContactBallId === null ? [] : [simResult.firstContactBallId];
}

function checkFirstContact(
  state: GameState,
  shotParams: ShotParams,
  firstContactBalls: Ball[],
  nominatedFreeBall: Ball | null,
): Foul | null {
  if (firstContactBalls.length === 0) return null;
  const firstBall = firstContactBalls[0];
  const ballOnColors = getNaturalBallOnColors(state);

  if (nominatedFreeBall) {
    const hitNominee = firstContactBalls.some(b => b.id === nominatedFreeBall.id);
    if (hitNominee) return null;

    const penalty = Math.max(
      MIN_FOUL_POINTS,
      getBallOnPenaltyValue(state, shotParams),
      BALL_VALUES[firstBall.color],
    );
    return {
      type: 'wrong_ball_first_contact',
      points: penalty,
      description: `Free Ball先碰了${firstBall.color}，应先碰提名的${nominatedFreeBall.color}，罚${penalty}分`,
    };
  }

  if (ballOnColors.includes(firstBall.color)) return null;

  const penalty = Math.max(
    MIN_FOUL_POINTS,
    getBallOnPenaltyValue(state, shotParams),
    BALL_VALUES[firstBall.color],
  );
  return {
    type: 'wrong_ball_first_contact',
    points: penalty,
    description: `先碰了${firstBall.color}球，罚${penalty}分`,
  };
}

function checkSimultaneousFirstContact(
  state: GameState,
  shotParams: ShotParams,
  firstContactBalls: Ball[],
  nominatedFreeBall: Ball | null,
): Foul | null {
  if (firstContactBalls.length < 2) return null;

  const ballOnColors = getNaturalBallOnColors(state);
  const legalTwoReds = ballOnColors.includes('red') && firstContactBalls.every(b => b.color === 'red');
  const legalFreeBallAndOn = nominatedFreeBall !== null &&
    firstContactBalls.some(b => b.id === nominatedFreeBall.id) &&
    firstContactBalls.some(b => ballOnColors.includes(b.color));

  if (legalTwoReds || legalFreeBallAndOn) return null;

  const concernedValue = Math.max(...firstContactBalls.map(b => BALL_VALUES[b.color]));
  const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams), concernedValue);
  return {
    type: 'simultaneous_first_contact',
    points: penalty,
    description: `首碰同时碰到${firstContactBalls.map(b => b.color).join('、')}，罚${penalty}分`,
  };
}

function isPottedBallLegal(
  state: GameState,
  shotParams: ShotParams,
  potted: Ball,
  nominatedFreeBall: Ball | null,
): boolean {
  if (nominatedFreeBall && potted.id === nominatedFreeBall.id) return true;

  const ballOnColors = getNaturalBallOnColors(state);
  if (state.phase === 'break_off' || state.phase === 'reds_phase') return potted.color === 'red';
  if (state.phase === 'color_after_red') {
    const target = getTargetBall(state, shotParams);
    return Boolean(target && potted.id === target.id && ballOnColors.includes(potted.color));
  }
  if (state.phase === 'colors_phase') return potted.color === state.nextColorToPot;
  return false;
}

function scoreLegalPots(
  state: GameState,
  shotParams: ShotParams,
  pottedBalls: Ball[],
  nominatedFreeBall: Ball | null,
): { points: number; balls: Ball[] } {
  let points = 0;
  const scoredBalls: Ball[] = [];
  const ballOnValue = getBallOnValue(state, shotParams);
  const ballOnColors = getNaturalBallOnColors(state);
  const ballOnPotted = pottedBalls.filter(b => b.color !== 'white' && ballOnColors.includes(b.color));
  const freeBallPotted = nominatedFreeBall
    ? pottedBalls.find(b => b.id === nominatedFreeBall.id)
    : undefined;

  if (nominatedFreeBall) {
    if (ballOnColors.includes('red')) {
      for (const red of ballOnPotted.filter(b => b.color === 'red')) {
        points += BALL_VALUES.red;
        scoredBalls.push(red);
      }
      if (freeBallPotted) {
        points += BALL_VALUES.red;
        scoredBalls.push(freeBallPotted);
      }
      return { points, balls: scoredBalls };
    }

    if (ballOnPotted.length > 0) {
      points += ballOnValue;
      scoredBalls.push(ballOnPotted[0]);
    } else if (freeBallPotted) {
      points += ballOnValue;
      scoredBalls.push(freeBallPotted);
    }
    return { points, balls: scoredBalls };
  }

  for (const potted of pottedBalls) {
    if (potted.color === 'white') continue;
    if (state.phase === 'break_off' || state.phase === 'reds_phase') {
      if (potted.color === 'red') {
        points += BALL_VALUES.red;
        scoredBalls.push(potted);
      }
    } else if (state.phase === 'color_after_red') {
      const target = getTargetBall(state, shotParams);
      if (target && potted.id === target.id) {
        points += BALL_VALUES[potted.color];
        scoredBalls.push(potted);
      }
    } else if (state.phase === 'colors_phase' && potted.color === state.nextColorToPot) {
      points += BALL_VALUES[potted.color];
      scoredBalls.push(potted);
    }
  }

  return { points, balls: scoredBalls };
}

function checkFreeBallSnooker(
  state: GameState,
  shotParams: ShotParams,
  simResult: SimulationResult,
  nominatedFreeBall: Ball | null,
  pointsScored: number,
): Foul | null {
  if (!nominatedFreeBall || pointsScored > 0) return null;
  const objectBalls = simResult.finalBalls.filter(b => b.color !== 'white' && !b.pocketed);
  if (objectBalls.length <= 2) return null;

  const nomineeAfter = simResult.finalBalls.find(b => b.id === nominatedFreeBall.id && !b.pocketed);
  if (!nomineeAfter) return null;

  const nextState = {
    ...state,
    balls: simResult.finalBalls,
    phase: phaseForIncomingTurnAfterBreakEnds(state, { ...state, balls: simResult.finalBalls }),
    freeBall: false,
    freeBallNominee: null,
  } as GameState;

  if (!isIncomingPlayerSnookered(nextState, simResult.finalBalls)) return null;
  if (!isEffectiveSnookeringBall(nextState, nomineeAfter, simResult.finalBalls)) return null;

  const penalty = Math.max(MIN_FOUL_POINTS, getBallOnPenaltyValue(state, shotParams));
  return {
    type: 'free_ball_snooker',
    points: penalty,
    description: `提名自由球${nominatedFreeBall.color}在未得分后形成斯诺克，罚${penalty}分`,
  };
}

function hasTouchingBallThatIsOrCouldBeOn(state: GameState, shotParams: ShotParams): boolean {
  if (state.touchingBalls.length === 0) return false;
  const ballOnColors = getNaturalBallOnColors(state);
  const targetBall = getTargetBall(state, shotParams);

  return state.touchingBalls.some(id => {
    const ball = state.balls.find(b => b.id === id && !b.pocketed);
    if (!ball) return false;
    if (ballOnColors.includes(ball.color)) return true;
    return state.phase === 'color_after_red' && targetBall?.id === ball.id;
  });
}

function findNextColor(balls: Ball[]): BallColor | null {
  for (const color of COLORS_ORDER) {
    const ball = balls.find(b => b.color === color && !b.pocketed);
    if (ball) return color;
  }
  return null;
}

function phaseForIncomingTurnAfterBreakEnds(previousState: GameState, stateAfterShot: Pick<GameState, 'balls' | 'phase'>): GamePhase {
  const redsRemaining = stateAfterShot.balls.filter(b => b.color === 'red' && !b.pocketed).length;
  if (redsRemaining > 0) return previousState.phase === 'break_off' ? 'reds_phase' : 'reds_phase';
  if (previousState.phase === 'game_over') return 'game_over';
  return 'colors_phase';
}

function reSpotRequiredColors(
  previousState: GameState,
  newState: GameState,
  simResult: SimulationResult,
  shotResult: ShotResult,
  hasScoringFoul: boolean,
): void {
  const colorsToConsider = [...simResult.pottedBalls, ...simResult.offTableBalls]
    .filter(b => b.color !== 'white' && b.color !== 'red');
  const legalFinalColorIds = new Set(
    !hasScoringFoul && previousState.phase === 'colors_phase'
      ? shotResult.pottedBalls.filter(b => b.color === previousState.nextColorToPot).map(b => b.id)
      : [],
  );

  for (const color of COLORS_ORDER) {
    const balls = colorsToConsider.filter(b => b.color === color && !legalFinalColorIds.has(b.id));
    for (const potted of balls) {
      const colorBall = newState.balls.find(b => b.id === potted.id);
      if (!colorBall) continue;
      colorBall.pocketed = false;
      colorBall.vel = { x: 0, y: 0 };
      colorBall.pos = findReSpotPosition(potted.color, newState.balls);
    }
  }
}

function isBlackOnlyObjectBall(balls: Ball[]): boolean {
  const objectBalls = balls.filter(b => b.color !== 'white' && !b.pocketed);
  return objectBalls.length === 1 && objectBalls[0].color === 'black';
}

function settleFrameAfterFinalBlack(state: GameState): void {
  const p0 = state.players[0].score;
  const p1 = state.players[1].score;

  if (p0 === p1) {
    const blackBall = state.balls.find(b => b.color === 'black');
    if (blackBall) {
      blackBall.pocketed = false;
      const spot = findReSpotPosition('black', state.balls);
      blackBall.pos = spot;
      blackBall.vel = { x: 0, y: 0 };
    }

    state.currentPlayerIndex = Math.random() < 0.5 ? 0 : 1;
    const cueBall = state.balls.find(b => b.color === 'white');
    if (cueBall) {
      cueBall.pocketed = false;
      cueBall.pos = { x: BAULK_LINE_X, y: CENTER_Y + D_ZONE_RADIUS * 0.4 };
      cueBall.vel = { x: 0, y: 0 };
    }
    state.cueBallInHand = true;
    state.phase = 'colors_phase';
    state.nextColorToPot = 'black';
    state.freeBall = false;
    state.statusMessage = `比分平局! 黑球已放回，${state.players[state.currentPlayerIndex].name}先手`;
    return;
  }

  state.phase = 'game_over';
  state.nextColorToPot = null;
  state.frameScores.push([p0, p1]);
  state.statusMessage = p0 > p1
    ? `第${state.frameNumber}局结束! ${state.players[0].name}获胜 (${p0}-${p1})`
    : `第${state.frameNumber}局结束! ${state.players[1].name}获胜 (${p0}-${p1})`;
}

function isCueBallInD(balls: Ball[]): boolean {
  const cueBall = balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return true;
  const dx = cueBall.pos.x - BAULK_LINE_X;
  const dy = cueBall.pos.y - CENTER_Y;
  const withinCircle = dx * dx + dy * dy <= D_ZONE_RADIUS * D_ZONE_RADIUS + 0.01;
  const inBaulkHalf = cueBall.pos.x >= BAULK_LINE_X - 0.01;
  return withinCircle && inBaulkHalf;
}

/**
 * Check if there is a clear path from the cue ball to any ball-on (§14(c)(d)).
 * Returns true if full-ball contact is available on at least one ball-on
 * (i.e., no obstructing ball blocks the path).
 */
function checkClearPathToBallOn(state: GameState, simResult: SimulationResult): boolean {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return false;

  const required = getRequiredFirstContact(state);
  const allBalls = state.balls.filter(b => !b.pocketed);

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
function isIncomingPlayerSnookered(state: GameState, balls: Ball[]): boolean {
  const cueBall = balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return false;

  const nextState: GameState = { ...state, balls };
  const required = getRequiredFirstContact(nextState);

  // Check if every required ball is blocked (no direct line of sight)
  return required.required.every(color => {
    const targets = balls.filter(b => b.color === color && !b.pocketed);
    return targets.length > 0 && targets.every(target => !hasDirectLineOfSight(cueBall, target, balls));
  });
}

function isEffectiveSnookeringBall(state: GameState, blocker: Ball, balls: Ball[]): boolean {
  const cueBall = balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return false;

  const required = getRequiredFirstContact(state);
  for (const color of required.required) {
    const targets = balls.filter(b => b.color === color && !b.pocketed);
    for (const target of targets) {
      if (hasDirectLineOfSight(cueBall, target, balls.filter(b => b.id !== blocker.id))) {
        return false;
      }
    }
  }
  return true;
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

  // Whether the touching ball is on or not, it must be played away from
  // without moving that object ball (§3 Rule 8(b)).
  for (const touchingId of state.touchingBalls) {
    const before = state.balls.find(b => b.id === touchingId);
    const after = simResult.finalBalls.find(b => b.id === touchingId);
    if (before && after) {
      const moved = distanceBetween(before.pos, after.pos) > 1;
      if (moved) {
        const penalty = Math.max(MIN_FOUL_POINTS, getBallOnValue(state), BALL_VALUES[before.color]);
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

// ============================================================
// Headless Game Loop — No React, No DOM
// For self-play training and CLI usage
// ============================================================

import type { GameState, ShotParams, ShotRecord } from '../types';
import type { Agent, AgentDecision } from '../ai/agents/agent';
import { createInitialBalls, simulateShot, applyShot } from './physics';
import { createInitialGameState, evaluateShot, applyShotResult } from './rules';

export interface GameLoopOptions {
  player1: Agent;
  player2: Agent;
  onShot?: (record: ShotRecord) => void;
  onFrameStart?: (frameNumber: number) => void;
  maxShots?: number; // Safety: prevent infinite loops
}

export interface FrameResult {
  winner: number; // 0 or 1
  scores: [number, number];
  totalShots: number;
  highestBreak: [number, number];
  fouls: [number, number];
  duration: number;
  shotRecords: ShotRecord[];
}

/**
 * Run a single frame headlessly (no rendering, no delays).
 */
export async function runHeadlessFrame(options: GameLoopOptions): Promise<FrameResult> {
  const balls = createInitialBalls();
  let state = createInitialGameState(
    [options.player1.name, options.player2.name],
    balls,
  );
  const agents = [options.player1, options.player2];
  const startTime = Date.now();
  const shotRecords: ShotRecord[] = [];
  const maxShots = options.maxShots ?? 500;
  let shotCount = 0;

  while (state.phase !== 'game_over' && shotCount < maxShots) {
    const currentAgent = agents[state.currentPlayerIndex];

    try {
      const decision = await currentAgent.decide(state);

      // Apply shot physics (headless — no animation frames)
      const ballsCopy = state.balls.map(b => ({
        ...b,
        pos: { ...b.pos },
        vel: { ...b.vel },
      }));
      applyShot(ballsCopy, decision.aimAngle, decision.power, decision.spinX, decision.spinY);
      const simResult = simulateShot(ballsCopy, { generateFrames: false });

      const shotParams: ShotParams = {
        angle: decision.aimAngle,
        power: decision.power,
        spinX: decision.spinX,
        spinY: decision.spinY,
        targetBallId: decision.targetBallId,
      };

      const shotResult = evaluateShot(state, shotParams, simResult);
      const newState = applyShotResult(state, shotParams, simResult, shotResult, decision.reasoning);

      // Record shot
      const record: ShotRecord = {
        playerIndex: state.currentPlayerIndex,
        shotParams,
        result: shotResult,
        ballPositionsBefore: state.balls.map(b => ({ id: b.id, pos: { ...b.pos } })),
        timestamp: Date.now(),
        llmReasoning: decision.reasoning,
      };
      shotRecords.push(record);
      options.onShot?.(record);

      state = newState;
      shotCount++;
    } catch (err) {
      // On error, give the turn to the opponent
      state = {
        ...state,
        currentPlayerIndex: 1 - state.currentPlayerIndex,
        statusMessage: `Error: ${err instanceof Error ? err.message : 'unknown'}`,
      };
      shotCount++;
    }
  }

  const duration = Date.now() - startTime;
  const p0 = state.players[0].score;
  const p1 = state.players[1].score;

  return {
    winner: p0 > p1 ? 0 : p1 > p0 ? 1 : -1, // -1 for draw
    scores: [p0, p1],
    totalShots: shotCount,
    highestBreak: [state.players[0].highestBreak, state.players[1].highestBreak],
    fouls: [
      shotRecords.filter(r => r.playerIndex === 0 && r.result.fouls.length > 0).length,
      shotRecords.filter(r => r.playerIndex === 1 && r.result.fouls.length > 0).length,
    ],
    duration,
    shotRecords,
  };
}

/**
 * Run multiple frames in a match (best of N).
 */
export async function runHeadlessMatch(
  player1: Agent,
  player2: Agent,
  bestOf: number = 3,
  onFrameComplete?: (result: FrameResult, frameNumber: number) => void,
): Promise<{ winner: number; frameResults: FrameResult[] }> {
  const frameResults: FrameResult[] = [];
  const winsNeeded = Math.ceil(bestOf / 2);
  let wins = [0, 0];

  for (let frame = 1; frame <= bestOf; frame++) {
    // Alternate who breaks
    const [p1, p2] = frame % 2 === 1 ? [player1, player2] : [player2, player1];
    const result = await runHeadlessFrame({ player1: p1, player2: p2 });

    // Normalize winner index back to original player1/player2
    const normalizedResult = frame % 2 === 1
      ? result
      : { ...result, winner: result.winner === 0 ? 1 : result.winner === 1 ? 0 : -1 };

    frameResults.push(normalizedResult);
    if (normalizedResult.winner >= 0) {
      wins[normalizedResult.winner]++;
    }
    onFrameComplete?.(normalizedResult, frame);

    if (wins[0] >= winsNeeded || wins[1] >= winsNeeded) break;
  }

  return {
    winner: wins[0] > wins[1] ? 0 : wins[1] > wins[0] ? 1 : -1,
    frameResults,
  };
}

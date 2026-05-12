// ============================================================
// Game Recorder — Records and analyzes game data
// ============================================================

import type { ShotRecord } from '../types';
import type { FrameRecord, PositionPattern } from './types';

export class GameRecorder {
  private records: FrameRecord[] = [];
  private currentShots: ShotRecord[] = [];

  recordShot(shot: ShotRecord): void {
    this.currentShots.push(shot);
  }

  endFrame(result: {
    winner: number;
    scores: [number, number];
    highestBreak: [number, number];
    fouls: [number, number];
    duration: number;
  }): void {
    this.records.push({
      ...result,
      shots: [...this.currentShots],
    });
    this.currentShots = [];
  }

  getRecords(): FrameRecord[] {
    return [...this.records];
  }

  /** Extract position->action patterns from winning play */
  extractPatterns(): PositionPattern[] {
    const patterns: PositionPattern[] = [];

    for (const frame of this.records) {
      if (frame.winner < 0) continue;
      for (const shot of frame.shots) {
        if (shot.playerIndex !== frame.winner) continue;

        const outcome = shot.result.fouls.length > 0
          ? 'foul'
          : shot.result.pointsScored > 0
            ? 'pot'
            : shot.result.pottedBalls.length === 0 && shot.result.fouls.length === 0
              ? 'safety'
              : 'miss';

        patterns.push({
          ballPositions: shot.ballPositionsBefore,
          action: {
            angle: shot.shotParams.angle,
            power: shot.shotParams.power,
            spinX: shot.shotParams.spinX,
            spinY: shot.shotParams.spinY,
            strategy: outcome === 'pot' ? 'attack' : outcome === 'safety' ? 'safety' : 'attack',
          },
          outcome,
          score: shot.result.pointsScored,
        });
      }
    }

    return patterns;
  }

  /** Get summary statistics for the recording session */
  getSummary(): { totalFrames: number; totalShots: number; avgFrameLength: number } {
    const totalShots = this.records.reduce((s, f) => s + f.shots.length, 0);
    return {
      totalFrames: this.records.length,
      totalShots,
      avgFrameLength: this.records.length > 0 ? totalShots / this.records.length : 0,
    };
  }

  clear(): void {
    this.records = [];
    this.currentShots = [];
  }
}

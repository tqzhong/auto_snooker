// ============================================================
// Break-building metrics for maximum-break-oriented training
// ============================================================

import type { BallColor } from '../types';
import type { FrameRecord } from './types';

export interface BreakBuildingStats {
  totalScoringShots: number;
  totalBreakVisits: number;
  maxBreakVisitPoints: number;
  avgBreakVisitPoints: number;
  maxBreakVisitShots: number;
  redColorPairs: number;
  redBlackPairs: number;
  redPinkPairs: number;
  redBluePairs: number;
  blackAfterRedRate: number;
  premiumColorAfterRedRate: number;
  fiftyBreaks: number;
  centuryBreaks: number;
  maxBreakProximity: number;
}

interface BreakVisit {
  points: number;
  shots: number;
  colors: BallColor[];
}

function emptyStats(): BreakBuildingStats {
  return {
    totalScoringShots: 0,
    totalBreakVisits: 0,
    maxBreakVisitPoints: 0,
    avgBreakVisitPoints: 0,
    maxBreakVisitShots: 0,
    redColorPairs: 0,
    redBlackPairs: 0,
    redPinkPairs: 0,
    redBluePairs: 0,
    blackAfterRedRate: 0,
    premiumColorAfterRedRate: 0,
    fiftyBreaks: 0,
    centuryBreaks: 0,
    maxBreakProximity: 0,
  };
}

function scoredColors(record: FrameRecord['shots'][number]): BallColor[] {
  if (record.result.fouls.length > 0 || record.result.pointsScored <= 0) return [];
  return record.result.pottedBalls
    .filter(ball => ball.color !== 'white')
    .map(ball => ball.color);
}

function finishVisit(visits: BreakVisit[], current: BreakVisit | null): void {
  if (current && current.points > 0) visits.push(current);
}

function collectBreakVisits(frames: FrameRecord[], playerIndex: number): BreakVisit[] {
  const visits: BreakVisit[] = [];

  for (const frame of frames) {
    let current: BreakVisit | null = null;

    for (const shot of frame.shots) {
      const colors = scoredColors(shot);
      const isPlayerShot = shot.playerIndex === playerIndex;
      const isScoringPlayerShot = isPlayerShot && colors.length > 0;

      if (!isScoringPlayerShot) {
        if (isPlayerShot || shot.playerIndex !== playerIndex) {
          finishVisit(visits, current);
          current = null;
        }
        continue;
      }

      if (!current) current = { points: 0, shots: 0, colors: [] };
      current.points += shot.result.pointsScored;
      current.shots += 1;
      current.colors.push(...colors);
    }

    finishVisit(visits, current);
  }

  return visits;
}

export function calculateBreakBuildingStats(
  frames: FrameRecord[],
  playerIndex = 0,
): BreakBuildingStats {
  if (frames.length === 0) return emptyStats();

  const visits = collectBreakVisits(frames, playerIndex);
  if (visits.length === 0) return emptyStats();

  let redColorPairs = 0;
  let redBlackPairs = 0;
  let redPinkPairs = 0;
  let redBluePairs = 0;
  let totalScoringShots = 0;

  for (const visit of visits) {
    totalScoringShots += visit.shots;
    for (let i = 0; i < visit.colors.length - 1; i++) {
      if (visit.colors[i] !== 'red') continue;
      const next = visit.colors[i + 1];
      if (next === 'red' || next === 'white') continue;
      redColorPairs++;
      if (next === 'black') redBlackPairs++;
      if (next === 'pink') redPinkPairs++;
      if (next === 'blue') redBluePairs++;
    }
  }

  const totalVisitPoints = visits.reduce((sum, visit) => sum + visit.points, 0);
  const maxBreakVisitPoints = Math.max(...visits.map(visit => visit.points), 0);
  const maxBreakVisitShots = Math.max(...visits.map(visit => visit.shots), 0);
  const premiumPairs = redBlackPairs + redPinkPairs + redBluePairs;

  return {
    totalScoringShots,
    totalBreakVisits: visits.length,
    maxBreakVisitPoints,
    avgBreakVisitPoints: totalVisitPoints / visits.length,
    maxBreakVisitShots,
    redColorPairs,
    redBlackPairs,
    redPinkPairs,
    redBluePairs,
    blackAfterRedRate: redColorPairs > 0 ? redBlackPairs / redColorPairs : 0,
    premiumColorAfterRedRate: redColorPairs > 0 ? premiumPairs / redColorPairs : 0,
    fiftyBreaks: visits.filter(visit => visit.points >= 50).length,
    centuryBreaks: visits.filter(visit => visit.points >= 100).length,
    maxBreakProximity: maxBreakVisitPoints / 147,
  };
}


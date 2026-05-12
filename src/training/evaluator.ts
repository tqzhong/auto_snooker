// ============================================================
// Agent Evaluator — Calculates performance metrics
// ============================================================

import type { FrameRecord, AgentStats } from './types';

export function calculateAgentStats(
  agentName: string,
  frames: FrameRecord[],
  playerIndex: number,
): AgentStats {
  if (frames.length === 0) {
    return emptyStats(agentName);
  }

  const wins = frames.filter(f => f.winner === playerIndex).length;
  const losses = frames.filter(f => f.winner !== playerIndex && f.winner >= 0).length;
  const draws = frames.filter(f => f.winner === -1).length;

  const myShots = frames.flatMap(f => f.shots.filter(s => s.playerIndex === playerIndex));
  const totalPoints = frames.reduce((s, f) => s + f.scores[playerIndex], 0);
  const breaks = frames.map(f => f.highestBreak[playerIndex]);
  const highestBreak = Math.max(...breaks, 0);
  const avgBreak = breaks.reduce((a, b) => a + b, 0) / breaks.length;

  const centuryBreaks = breaks.filter(b => b >= 100).length;

  const potShots = myShots.filter(s => s.result.pointsScored > 0);
  const foulShots = myShots.filter(s => s.result.fouls.length > 0);
  const safetyShots = myShots.filter(s => s.result.pointsScored === 0 && s.result.fouls.length === 0);
  const totalShots = myShots.length;

  return {
    name: agentName,
    gamesPlayed: frames.length,
    wins,
    losses,
    draws,
    winRate: frames.length > 0 ? wins / frames.length : 0,
    avgPointsPerGame: frames.length > 0 ? totalPoints / frames.length : 0,
    avgBreak,
    highestBreak,
    centuryBreaks,
    safetySuccessRate: totalShots > 0 ? safetyShots.length / totalShots : 0,
    foulRate: totalShots > 0 ? foulShots.length / totalShots : 0,
    potSuccessRate: totalShots > 0 ? potShots.length / totalShots : 0,
    avgFrameLength: frames.reduce((s, f) => s + f.shots.length, 0) / frames.length,
  };
}

function emptyStats(name: string): AgentStats {
  return {
    name, gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    winRate: 0, avgPointsPerGame: 0, avgBreak: 0, highestBreak: 0,
    centuryBreaks: 0, safetySuccessRate: 0, foulRate: 0,
    potSuccessRate: 0, avgFrameLength: 0,
  };
}

/** Print stats as formatted table */
export function formatStats(stats: AgentStats[]): string {
  const header = [
    'Agent', 'Games', 'W/L/D', 'Win%', 'Avg Pts',
    'Avg Brk', 'High Brk', 'Cent.', 'Pot%', 'Foul%',
  ].join('\t');

  const rows = stats.map(s => [
    s.name, s.gamesPlayed,
    `${s.wins}/${s.losses}/${s.draws}`,
    (s.winRate * 100).toFixed(1) + '%',
    s.avgPointsPerGame.toFixed(1),
    s.avgBreak.toFixed(1),
    s.highestBreak,
    s.centuryBreaks,
    (s.potSuccessRate * 100).toFixed(1) + '%',
    (s.foulRate * 100).toFixed(1) + '%',
  ].join('\t'));

  return [header, ...rows].join('\n');
}

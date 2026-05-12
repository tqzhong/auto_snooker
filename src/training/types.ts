// ============================================================
// Training Types
// ============================================================

import type { ShotRecord } from '../types';
import type { Agent } from '../ai/agents/agent';

export interface FrameRecord {
  winner: number;
  scores: [number, number];
  shots: ShotRecord[];
  highestBreak: [number, number];
  fouls: [number, number];
  duration: number;
}

export interface TrainingConfig {
  agentPairs: [Agent, Agent][];
  framesPerPair: number;
  onProgress?: (completed: number, total: number) => void;
  onFrameComplete?: (record: FrameRecord, pairIndex: number, frameIndex: number) => void;
}

export interface AgentStats {
  name: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  avgPointsPerGame: number;
  avgBreak: number;
  highestBreak: number;
  centuryBreaks: number;
  safetySuccessRate: number;
  foulRate: number;
  potSuccessRate: number;
  avgFrameLength: number;
}

export interface TrainingResults {
  agentStats: Map<string, AgentStats>;
  frameRecords: FrameRecord[];
  summary: {
    bestAgent: string;
    worstAgent: string;
    totalFrames: number;
    totalDuration: number;
  };
}

export interface PositionPattern {
  ballPositions: { id: number; pos: { x: number; y: number } }[];
  action: { angle: number; power: number; spinX: number; spinY: number; strategy: string };
  outcome: 'pot' | 'miss' | 'foul' | 'safety';
  score: number;
}

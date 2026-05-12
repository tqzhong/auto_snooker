// ============================================================
// Agent Interface
// Common interface for all snooker AI agents
// ============================================================

import type { GameState, LLMDecision } from '../../types';

export interface AgentDecision {
  targetBallId: number;
  aimAngle: number;
  power: number;
  spinX: number;
  spinY: number;
  strategy: 'attack' | 'safety' | 'snooker';
  reasoning: string;
}

export interface Agent {
  readonly name: string;
  readonly version: string;

  decide(state: GameState): Promise<AgentDecision>;

  /** Optional: tunable parameters for training */
  getParameters?(): Record<string, number>;
  setParameters?(params: Record<string, number>): void;
}

/** Agent registry for CLI usage */
const AGENT_REGISTRY = new Map<string, () => Agent>();

export function registerAgent(id: string, factory: () => Agent): void {
  AGENT_REGISTRY.set(id, factory);
}

export function getAgent(id: string): Agent | null {
  const factory = AGENT_REGISTRY.get(id);
  return factory ? factory() : null;
}

export function listRegisteredAgents(): string[] {
  return [...AGENT_REGISTRY.keys()];
}

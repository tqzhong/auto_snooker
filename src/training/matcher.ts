// ============================================================
// Agent Matcher — Pairing strategies for training
// ============================================================

import type { Agent } from '../ai/agents/agent';

/** Round-robin: every agent pair plays against each other */
export function createRoundRobinPairs(agents: Agent[]): [Agent, Agent][] {
  const pairs: [Agent, Agent][] = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      pairs.push([agents[i], agents[j]]);
    }
  }
  return pairs;
}

/** Self-play: same agent plays both sides */
export function createSelfPlayPairs(agents: Agent[]): [Agent, Agent][] {
  return agents.map(agent => [agent, agent]);
}

/** Champion vs Challengers: one agent plays against all others */
export function createChampionPairs(champion: Agent, challengers: Agent[]): [Agent, Agent][] {
  return challengers.map(challenger => [champion, challenger]);
}

/** Random pairing from a pool */
export function createRandomPairs(agents: Agent[], count: number): [Agent, Agent][] {
  const pairs: [Agent, Agent][] = [];
  for (let i = 0; i < count; i++) {
    const a = agents[Math.floor(Math.random() * agents.length)];
    let b = agents[Math.floor(Math.random() * agents.length)];
    while (b.name === a.name && agents.length > 1) {
      b = agents[Math.floor(Math.random() * agents.length)];
    }
    pairs.push([a, b]);
  }
  return pairs;
}

#!/usr/bin/env tsx
// ============================================================
// Evaluate CLI — Tournament evaluation of agents
// ============================================================

import { AggressiveAgent } from '../src/ai/agents/aggressive-agent';
import { DefensiveAgent } from '../src/ai/agents/defensive-agent';
import { BalancedAgent } from '../src/ai/agents/balanced-agent';
import { NeuralAgent } from '../src/ai/agents/neural-agent';
import { runHeadlessMatch, type FrameResult } from '../src/engine/game-loop';
import { calculateAgentStats, formatStats } from '../src/training/evaluator';
import type { FrameRecord, AgentStats } from '../src/training/types';
import type { Agent } from '../src/ai/agents/agent';

/** Convert FrameResult to FrameRecord */
function toFrameRecord(fr: FrameResult): FrameRecord {
  return {
    winner: fr.winner,
    scores: fr.scores,
    shots: fr.shotRecords,
    highestBreak: fr.highestBreak,
    fouls: fr.fouls,
    duration: fr.duration,
  };
}

const AGENTS: Record<string, () => Agent> = {
  aggressive: () => new AggressiveAgent(),
  defensive: () => new DefensiveAgent(),
  balanced: () => new BalancedAgent(),
  neural: () => new NeuralAgent('Neural-v1'),
};

async function main() {
  const args = process.argv.slice(2);

  const agentNames: string[] = [];
  let bestOf = 5;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agents':
        agentNames.push(...args[++i].split(','));
        break;
      case '--best-of':
        bestOf = parseInt(args[++i], 10);
        break;
      case '--help':
        console.log(`
Auto Snooker Evaluate CLI

Usage:
  npm run evaluate -- --agents aggressive,defensive,balanced --best-of 5

Options:
  --agents <names>    Comma-separated agent names
  --best-of <n>       Best of N frames per match (default: 5)
  --help              Show this help
`);
        process.exit(0);
    }
  }

  if (agentNames.length === 0) {
    agentNames.push('aggressive', 'defensive', 'balanced');
  }

  const agents = agentNames.map(name => {
    const factory = AGENTS[name];
    if (!factory) {
      console.error(`Unknown agent: ${name}. Available: ${Object.keys(AGENTS).join(', ')}`);
      process.exit(1);
    }
    return factory();
  });

  console.log(`🎱 Auto Snooker Tournament Evaluation`);
  console.log(`   Agents: ${agents.map(a => a.name).join(', ')}`);
  console.log(`   Best of: ${bestOf} frames per match`);
  console.log('');

  // Track frames per agent with their player index in each frame
  // Use actual agent name (from object) as key
  const agentFrameMap = new Map<string, { frame: FrameRecord; playerIndex: number }[]>();
  for (const agent of agents) {
    agentFrameMap.set(agent.name, []);
  }

  let matchCount = 0;
  const totalMatches = (agents.length * (agents.length - 1)) / 2;

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      matchCount++;
      process.stdout.write(`\r   Match ${matchCount}/${totalMatches}: ${agents[i].name} vs ${agents[j].name}`);

      const result = await runHeadlessMatch(agents[i], agents[j], bestOf);

      // Each frame: agent[i] was player 0 in alternating pattern
      for (let fi = 0; fi < result.frameResults.length; fi++) {
        const frameResult = result.frameResults[fi];
        const frame = toFrameRecord(frameResult);
        // In runHeadlessMatch, odd frames: player1=agents[i], player2=agents[j]
        // Even frames: player1=agents[j], player2=agents[i]
        const agentIWasPlayer0 = (fi + 1) % 2 === 1; // frame 1,3,5,... → agents[i] is player 0
        if (agentIWasPlayer0) {
          agentFrameMap.get(agents[i].name)?.push({ frame, playerIndex: 0 });
          agentFrameMap.get(agents[j].name)?.push({ frame, playerIndex: 1 });
        } else {
          agentFrameMap.get(agents[i].name)?.push({ frame, playerIndex: 1 });
          agentFrameMap.get(agents[j].name)?.push({ frame, playerIndex: 0 });
        }
      }
    }
  }

  console.log('\n');

  // Calculate and display stats
  const allStats: AgentStats[] = [];
  for (const agent of agents) {
    const entries = agentFrameMap.get(agent.name) || [];
    const normalizedFrames: FrameRecord[] = entries.map(({ frame, playerIndex }) => {
      if (playerIndex === 0) return frame;
      // Swap so that the agent is always player 0
      return {
        winner: frame.winner === 0 ? 1 : frame.winner === 1 ? 0 : -1,
        scores: [frame.scores[1], frame.scores[0]] as [number, number],
        highestBreak: [frame.highestBreak[1], frame.highestBreak[0]] as [number, number],
        fouls: [frame.fouls[1], frame.fouls[0]] as [number, number],
        shots: frame.shots.map(s => ({
          ...s,
          playerIndex: 1 - s.playerIndex,
        })),
        duration: frame.duration,
      };
    });
    allStats.push(calculateAgentStats(agent.name, normalizedFrames, 0));
  }

  allStats.sort((a, b) => b.winRate - a.winRate);

  console.log('   Tournament Results:');
  console.log('');
  console.log(formatStats(allStats));
  console.log('');

  console.log(`   🏆 Champion: ${allStats[0].name} (${(allStats[0].winRate * 100).toFixed(1)}% win rate)`);
}

main().catch(err => {
  console.error('Evaluation failed:', err);
  process.exit(1);
});

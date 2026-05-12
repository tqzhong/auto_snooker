#!/usr/bin/env tsx
// ============================================================
// Training CLI — Run agent self-play training
// ============================================================

import { AggressiveAgent } from '../src/ai/agents/aggressive-agent';
import { DefensiveAgent } from '../src/ai/agents/defensive-agent';
import { BalancedAgent } from '../src/ai/agents/balanced-agent';
import { NeuralAgent } from '../src/ai/agents/neural-agent';
import { createTrainer, formatTrainingResults } from '../src/training/trainer';
import { createRoundRobinPairs, createSelfPlayPairs } from '../src/training/matcher';
import { writeFileSync } from 'fs';

const AGENTS: Record<string, () => any> = {
  aggressive: () => new AggressiveAgent(),
  defensive: () => new DefensiveAgent(),
  balanced: () => new BalancedAgent(),
  neural: () => new NeuralAgent('Neural-v1'),
};

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const agentNames: string[] = [];
  let frames = 10;
  let mode: 'round-robin' | 'self-play' = 'round-robin';
  let outputFile = 'training-results.json';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--agents':
        agentNames.push(...args[++i].split(','));
        break;
      case '--frames':
        frames = parseInt(args[++i], 10);
        break;
      case '--mode':
        mode = args[++i] as 'round-robin' | 'self-play';
        break;
      case '--output':
        outputFile = args[++i];
        break;
      case '--help':
        console.log(`
Auto Snooker Training CLI

Usage:
  npm run train -- --agents aggressive,defensive,balanced --frames 100

Options:
  --agents <names>    Comma-separated agent names: aggressive, defensive, balanced, neural
  --frames <n>        Number of frames per matchup (default: 10)
  --mode <mode>       'round-robin' or 'self-play' (default: round-robin)
  --output <file>     Output JSON file (default: training-results.json)
  --help              Show this help
`);
        process.exit(0);
    }
  }

  // Default agents
  if (agentNames.length === 0) {
    agentNames.push('aggressive', 'defensive', 'balanced');
  }

  // Create agents
  const agents = agentNames.map(name => {
    const factory = AGENTS[name];
    if (!factory) {
      console.error(`Unknown agent: ${name}. Available: ${Object.keys(AGENTS).join(', ')}`);
      process.exit(1);
    }
    return factory();
  });

  console.log(`🎱 Auto Snooker Training`);
  console.log(`   Agents: ${agents.map(a => a.name).join(', ')}`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Frames per matchup: ${frames}`);
  console.log('');

  // Create pairs
  const pairs = mode === 'self-play'
    ? createSelfPlayPairs(agents)
    : createRoundRobinPairs(agents);

  const totalFrames = pairs.length * frames;
  console.log(`   Matchups: ${pairs.length}`);
  console.log(`   Total frames: ${totalFrames}`);
  console.log('');

  // Run training
  const startTime = Date.now();
  let lastPercent = -1;

  const trainer = createTrainer({
    agentPairs: pairs,
    framesPerPair: frames,
    onProgress: (completed, total) => {
      const percent = Math.floor((completed / total) * 100);
      if (percent !== lastPercent) {
        process.stdout.write(`\r   Progress: ${completed}/${total} (${percent}%)`);
        lastPercent = percent;
      }
    },
  });

  const results = await trainer.run();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n');
  console.log(formatTrainingResults(results));
  console.log(`\n   Completed in ${elapsed}s`);

  // Save results
  const exportData = {
    summary: results.summary,
    agentStats: Object.fromEntries(results.agentStats),
    frameCount: results.frameRecords.length,
  };
  writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
  console.log(`   Results saved to ${outputFile}`);
}

main().catch(err => {
  console.error('Training failed:', err);
  process.exit(1);
});

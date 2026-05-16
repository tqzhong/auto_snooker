#!/usr/bin/env tsx
// ============================================================
// Training CLI — Run agent self-play training
// ============================================================

import { MasterSnookerAgent } from '../src/ai/agents/master-agent';
import { createTrainer, formatTrainingResults } from '../src/training/trainer';
import { createRoundRobinPairs, createSelfPlayPairs } from '../src/training/matcher';
import { optimizeMasterParams } from '../src/training/master-optimizer';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const AGENTS: Record<string, () => any> = {
  master: () => new MasterSnookerAgent('Master'),
  'master-a': () => new MasterSnookerAgent('Master-A'),
  'master-b': () => new MasterSnookerAgent('Master-B'),
};

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const agentNames: string[] = [];
  let frames = 10;
  let mode: 'round-robin' | 'self-play' = 'round-robin';
  let outputFile = 'training-results.json';
  let optimizeMaster = false;
  let generations = 5;
  let populationSize = 4;
  let maxShots = 420;
  let curriculumVisits = 4;
  let maxCurriculumShots = 18;
  let resumeFrom = '';

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
      case '--optimize-master':
        optimizeMaster = true;
        break;
      case '--generations':
        generations = parseInt(args[++i], 10);
        break;
      case '--population':
        populationSize = parseInt(args[++i], 10);
        break;
      case '--max-shots':
        maxShots = parseInt(args[++i], 10);
        break;
      case '--curriculum-visits':
        curriculumVisits = parseInt(args[++i], 10);
        break;
      case '--max-curriculum-shots':
        maxCurriculumShots = parseInt(args[++i], 10);
        break;
      case '--resume-from':
        resumeFrom = args[++i];
        break;
      case '--help':
        console.log(`
Auto Snooker Training CLI

Usage:
  npm run train -- --agents master-a,master-b --frames 100

Options:
  --agents <names>    Comma-separated agent names: master, master-a, master-b
  --frames <n>        Number of frames per matchup (default: 10)
  --mode <mode>       'round-robin' or 'self-play' (default: round-robin)
  --output <file>     Output JSON file (default: training-results.json)
  --optimize-master   Tune Master scoring weights for high-break self-play
  --generations <n>   Generations for --optimize-master (default: 5)
  --population <n>    Candidates per generation for optimization (default: 4)
  --max-shots <n>     Max shots per optimization frame (default: 420)
  --curriculum-visits <n>  Break-building practice visits per eval (default: 4)
  --max-curriculum-shots <n> Max shots per practice visit (default: 18)
  --resume-from <file> Continue optimization from a previous result JSON
  --help              Show this help
`);
        process.exit(0);
    }
  }

  if (optimizeMaster) {
    console.log(`🎱 Auto Snooker Master Optimization`);
    console.log(`   Generations: ${generations}`);
    console.log(`   Frames per eval: ${frames}`);
    console.log(`   Curriculum visits per eval: ${curriculumVisits}`);
    if (resumeFrom) console.log(`   Resume from: ${resumeFrom}`);
    console.log('');

    let initialParams = {};
    if (resumeFrom) {
      if (!existsSync(resumeFrom)) {
        console.error(`Resume file not found: ${resumeFrom}`);
        process.exit(1);
      }
      const previous = JSON.parse(readFileSync(resumeFrom, 'utf8'));
      initialParams = previous.bestParams ?? {};
    }

    const result = await optimizeMasterParams({
      generations,
      framesPerEval: frames,
      populationSize,
      maxShotsPerFrame: maxShots,
      curriculumVisits,
      maxCurriculumShots,
      initialParams,
      onProgress: (generation, bestFitness, bestParams) => {
        process.stdout.write(`\r   Generation ${generation + 1}/${generations} best fitness ${bestFitness.toFixed(1)}`);
      },
    });

    console.log('\n');
    console.log(`   Best fitness: ${result.bestFitness.toFixed(1)}`);
    console.log(`   Highest break: ${result.bestStats.highestBreak}`);
    console.log(`   Century breaks: ${result.bestStats.centuryBreaks}`);
    console.log(`   Red-black pairs: ${result.bestBreakStats.redBlackPairs}`);
    console.log(`   Black after red: ${(result.bestBreakStats.blackAfterRedRate * 100).toFixed(1)}%`);
    console.log(`   Premium color after red: ${(result.bestBreakStats.premiumColorAfterRedRate * 100).toFixed(1)}%`);
    console.log(`   Pot success: ${(result.bestStats.potSuccessRate * 100).toFixed(1)}%`);
    console.log(`   Foul rate: ${(result.bestStats.foulRate * 100).toFixed(1)}%`);

    writeFileSync(outputFile, JSON.stringify(result, null, 2));
    console.log(`   Results saved to ${outputFile}`);
    return;
  }

  // Default agents
  if (agentNames.length === 0) {
    agentNames.push('master-a', 'master-b');
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

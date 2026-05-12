// ============================================================
// Progressive Difficulty — Training positions by skill level
// ============================================================

import type { Ball, GameState } from '../types';
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH, BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS, PINK_SPOT_X } from '../engine/constants';
import { createInitialGameState } from '../engine/rules';
import { createInitialBalls } from '../engine/physics';

interface TrainingPosition {
  name: string;
  level: number;
  description: string;
  createBalls: () => Ball[];
}

const POSITIONS: TrainingPosition[] = [
  // Level 1: Simple straight pots
  {
    name: 'straight-pot',
    level: 1,
    description: '直线进球 — 红球在袋口正前方',
    createBalls: () => [
      makeBall(0, 'white', 2000, CENTER_Y),
      makeBall(1, 'red', 1500, CENTER_Y),
      makeBall(2, 'black', 324, CENTER_Y),
      makeBall(3, 'pink', PINK_SPOT_X, CENTER_Y),
    ],
  },
  {
    name: 'easy-corner',
    level: 1,
    description: '角袋进球 — 红球靠近角袋',
    createBalls: () => [
      makeBall(0, 'white', 2500, 400),
      makeBall(1, 'red', 150, 150),
      makeBall(2, 'black', 324, CENTER_Y),
      makeBall(3, 'pink', PINK_SPOT_X, CENTER_Y),
    ],
  },
  {
    name: 'color-pot',
    level: 1,
    description: '彩球进球 — 黄球在点位附近',
    createBalls: () => [
      makeBall(0, 'white', 2500, CENTER_Y + 200),
      makeBall(1, 'yellow', BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS),
    ],
  },

  // Level 2: Angled pots, basic position
  {
    name: 'angled-red',
    level: 2,
    description: '角度进球 — 红球有角度偏移',
    createBalls: () => [
      makeBall(0, 'white', 2000, CENTER_Y),
      makeBall(1, 'red', 1400, CENTER_Y - 100),
      makeBall(2, 'black', 324, CENTER_Y),
      makeBall(3, 'pink', PINK_SPOT_X, CENTER_Y),
      makeBall(4, 'blue', TABLE_LENGTH / 2, CENTER_Y),
    ],
  },
  {
    name: 'break-off',
    level: 2,
    description: '标准开局 — 15颗红球+6颗彩球',
    createBalls: () => createInitialBalls(),
  },
  {
    name: 'position-play',
    level: 2,
    description: '位置控制 — 进球红球后需走到黑球',
    createBalls: () => [
      makeBall(0, 'white', 2000, CENTER_Y + 150),
      makeBall(1, 'red', 1200, CENTER_Y),
      makeBall(2, 'black', 324, CENTER_Y),
    ],
  },

  // Level 3: Safety, snooker laying
  {
    name: 'basic-safety',
    level: 3,
    description: '基础防守 — 红球无进球线路',
    createBalls: () => [
      makeBall(0, 'white', 2500, CENTER_Y),
      makeBall(1, 'red', 300, CENTER_Y + 50),
      makeBall(2, 'brown', BAULK_LINE_X, CENTER_Y),
      makeBall(3, 'green', BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS),
    ],
  },
  {
    name: 'snooker-behind-brown',
    level: 3,
    description: '斯诺克做球 — 母球在咖啡球后面',
    createBalls: () => [
      makeBall(0, 'white', 2700, CENTER_Y),
      makeBall(1, 'red', 800, CENTER_Y),
      makeBall(2, 'brown', BAULK_LINE_X, CENTER_Y),
    ],
  },
  {
    name: 'cushion-escape',
    level: 3,
    description: '解球 — 母球被多球包围',
    createBalls: () => [
      makeBall(0, 'white', 2800, CENTER_Y),
      makeBall(1, 'red', 800, CENTER_Y),
      makeBall(2, 'yellow', 2600, CENTER_Y - 60),
      makeBall(3, 'green', 2600, CENTER_Y + 60),
      makeBall(4, 'brown', BAULK_LINE_X, CENTER_Y),
    ],
  },

  // Level 4: Complex endgame, break building
  {
    name: 'break-building',
    level: 4,
    description: '连续进攻 — 多颗红球+彩球布局',
    createBalls: () => {
      const balls: Ball[] = [makeBall(0, 'white', 2500, CENTER_Y)];
      // 8 reds in a loose formation
      for (let i = 0; i < 8; i++) {
        balls.push(makeBall(
          i + 1, 'red',
          800 + (i % 4) * 120,
          CENTER_Y - 150 + Math.floor(i / 4) * 300,
        ));
      }
      balls.push(makeBall(9, 'black', 324, CENTER_Y));
      balls.push(makeBall(10, 'pink', PINK_SPOT_X, CENTER_Y));
      balls.push(makeBall(11, 'blue', TABLE_LENGTH / 2, CENTER_Y));
      return balls;
    },
  },
  {
    name: 'endgame-pressure',
    level: 4,
    description: '残局压力 — 分数接近，最后几颗球',
    createBalls: () => [
      makeBall(0, 'white', 2500, CENTER_Y),
      makeBall(1, 'red', 600, CENTER_Y - 80),
      makeBall(2, 'black', 324, CENTER_Y),
      makeBall(3, 'pink', PINK_SPOT_X, CENTER_Y),
      makeBall(4, 'blue', TABLE_LENGTH / 2, CENTER_Y),
      makeBall(5, 'brown', BAULK_LINE_X, CENTER_Y),
      makeBall(6, 'green', BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS),
      makeBall(7, 'yellow', BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS),
    ],
  },
  {
    name: 'multi-red-snooker',
    level: 4,
    description: '复杂斯诺克 — 多球遮挡',
    createBalls: () => [
      makeBall(0, 'white', 2800, CENTER_Y - 100),
      makeBall(1, 'red', 500, CENTER_Y),
      makeBall(2, 'red', 550, CENTER_Y + 50),
      makeBall(3, 'black', 324, CENTER_Y),
      makeBall(4, 'pink', PINK_SPOT_X, CENTER_Y),
      makeBall(5, 'blue', TABLE_LENGTH / 2, CENTER_Y),
      makeBall(6, 'brown', BAULK_LINE_X, CENTER_Y),
      makeBall(7, 'green', BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS),
      makeBall(8, 'yellow', BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS),
    ],
  },
];

function makeBall(id: number, color: Ball['color'], x: number, y: number): Ball {
  return {
    id,
    color,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    radius: BALL_RADIUS,
    pocketed: false,
    active: true,
  };
}

/** Get training positions for a specific level (includes all lower levels) */
export function getTrainingPositions(level: number): TrainingPosition[] {
  return POSITIONS.filter(p => p.level <= level);
}

/** Get positions for a specific level only */
export function getPositionsForLevel(level: number): TrainingPosition[] {
  return POSITIONS.filter(p => p.level === level);
}

/** Create a game state from a training position */
export function createTrainingState(position: TrainingPosition): GameState {
  return createInitialGameState(['训练 Agent', '对手'], position.createBalls());
}

/** Get all available levels */
export function getAvailableLevels(): number[] {
  return [...new Set(POSITIONS.map(p => p.level))].sort();
}

/** Get a random position at or below a given level */
export function getRandomPosition(maxLevel: number): TrainingPosition {
  const eligible = POSITIONS.filter(p => p.level <= maxLevel);
  return eligible[Math.floor(Math.random() * eligible.length)];
}

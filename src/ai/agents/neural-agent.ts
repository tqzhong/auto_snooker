// ============================================================
// Neural Agent — Parameter-tunable for training
// ============================================================

import type { GameState, Ball, BallColor } from '../../types';
import { BALL_VALUES, COLORS_ORDER } from '../../types';
import type { Agent, AgentDecision } from './agent';
import {
  getLegalTargetBalls, getDirectlyPlayableTargetBalls, calculateBestShot,
  calculateSafetyShot, findAnyLegalContactShot,
  getPotLineCount, nearestPocket,
} from '../strategy';
import { findSnookerPlacement } from '../positional';
import { distanceBetween } from '../../engine/physics';
import { registerAgent } from './agent';

export interface NeuralParams {
  positionWeight: number;
  riskAversion: number;
  breakBuildingBias: number;
  snookerLayingSkill: number;
  safetyPower: number;
  escapeAbility: number;
  attackThreshold: number;
  concedeThreshold: number;
  spinPreference: number;
  powerBias: number;
  easyPotThreshold: number;
  valueWeight: number;
}

export const DEFAULT_NEURAL_PARAMS: NeuralParams = {
  positionWeight: 0.5,
  riskAversion: 0.5,
  breakBuildingBias: 0.5,
  snookerLayingSkill: 0.5,
  safetyPower: 0.45,
  escapeAbility: 0.5,
  attackThreshold: 0.5,
  concedeThreshold: 0.8,
  spinPreference: 0,
  powerBias: 0.55,
  easyPotThreshold: 2,
  valueWeight: 0.5,
};

export class NeuralAgent implements Agent {
  readonly name: string;
  readonly version = '1.0';
  private params: NeuralParams;

  constructor(name: string, params: Partial<NeuralParams> = {}) {
    this.name = name;
    this.params = { ...DEFAULT_NEURAL_PARAMS, ...params };
  }

  async decide(state: GameState): Promise<AgentDecision> {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    const legalTargets = getLegalTargetBalls(state);
    if (legalTargets.length === 0) return this.emptyDecision();

    // Concession check
    const current = state.players[state.currentPlayerIndex];
    const opponent = state.players[1 - state.currentPlayerIndex];
    const pointsRemaining = this.calcPointsRemaining(state);
    if (current.score + pointsRemaining < opponent.score * this.params.concedeThreshold) {
      // Don't concede formally, but play very safe
      return this.findBestSafety(state, legalTargets);
    }

    // Evaluate all options and pick the highest-scored one
    const options = this.evaluateAllOptions(state, legalTargets, cueBall);
    if (options.length === 0) return this.findBestSafety(state, legalTargets);

    options.sort((a, b) => b.score - a.score);
    const best = options[0];

    return {
      targetBallId: best.target.id,
      aimAngle: best.angle,
      power: best.power,
      spinX: best.spinX,
      spinY: best.spinY,
      strategy: best.strategy,
      reasoning: `[Neural:${this.name}] ${best.strategy} ${best.target.color} 评分${best.score.toFixed(1)}`,
    };
  }

  private evaluateAllOptions(
    state: GameState, targets: Ball[], cueBall: Ball,
  ): ScoredOption[] {
    const options: ScoredOption[] = [];
    const playable = getDirectlyPlayableTargetBalls(state);

    for (const target of playable) {
      // Attack option
      const shot = calculateBestShot(state, target, this.params.powerBias);
      if (shot) {
        const potCount = getPotLineCount(state, target);
        const np = nearestPocket(target);
        const value = BALL_VALUES[target.color as BallColor];

        // Score calculation
        let score = 0;
        score += value * this.params.valueWeight * 10;
        score += potCount * 20;
        score -= np.dist * 0.002;
        score += (1 - this.params.riskAversion) * 30; // Less risk-averse = bonus for attacking

        // Use break building bias
        score += this.params.breakBuildingBias * potCount * 15;

        options.push({
          target, angle: shot.angle, power: shot.power,
          spinX: 0, spinY: this.params.spinPreference * 0.3,
          strategy: 'attack', score,
        });
      }
    }

    // Snooker options
    if (this.params.snookerLayingSkill > 0.3) {
      for (const target of targets.slice(0, 3)) {
        const snooker = findSnookerPlacement(state, target);
        if (snooker) {
          const score = snooker.snookerQuality * this.params.snookerLayingSkill * 0.5;
          options.push({
            target, angle: snooker.angle, power: snooker.power,
            spinX: snooker.spinX, spinY: snooker.spinY,
            strategy: 'snooker', score,
          });
        }
      }
    }

    // Safety options
    for (const target of targets) {
      const safety = calculateSafetyShot(state, target, this.params.safetyPower);
      if (safety) {
        const np = nearestPocket(target);
        const score = -np.dist * 0.003 + this.params.riskAversion * 20;
        options.push({
          target, angle: safety.angle, power: safety.power,
          spinX: 0, spinY: -0.1,
          strategy: 'safety', score,
        });
      }
    }

    return options;
  }

  private findBestSafety(state: GameState, targets: Ball[]): AgentDecision {
    const escape = findAnyLegalContactShot(state, this.params.safetyPower);
    if (escape) {
      return {
        targetBallId: escape.targetBallId,
        aimAngle: escape.angle,
        power: escape.power,
        spinX: 0, spinY: 0,
        strategy: 'safety',
        reasoning: `[Neural:${this.name}] 解球`,
      };
    }
    return this.emptyDecision();
  }

  private calcPointsRemaining(state: GameState): number {
    const reds = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;
    if (reds === 0) {
      return COLORS_ORDER.reduce((s, c) => {
        const ball = state.balls.find(b => b.color === c && !b.pocketed);
        return s + (ball ? BALL_VALUES[c] : 0);
      }, 0);
    }
    return reds * 8 + COLORS_ORDER.reduce((s, c) => {
      const ball = state.balls.find(b => b.color === c && !b.pocketed);
      return s + (ball ? BALL_VALUES[c] : 0);
    }, 0);
  }

  private emptyDecision(): AgentDecision {
    return {
      targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '无目标',
    };
  }

  getParameters(): Record<string, number> {
    return { ...this.params };
  }

  setParameters(params: Record<string, number>): void {
    this.params = { ...this.params, ...params };
  }

  /** Save agent parameters to JSON */
  toJSON(): { name: string; params: NeuralParams } {
    return { name: this.name, params: { ...this.params } };
  }

  /** Load agent from JSON */
  static fromJSON(data: { name: string; params: NeuralParams }): NeuralAgent {
    return new NeuralAgent(data.name, data.params);
  }
}

interface ScoredOption {
  target: Ball;
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
  strategy: 'attack' | 'safety' | 'snooker';
  score: number;
}

registerAgent('neural', () => new NeuralAgent('default'));

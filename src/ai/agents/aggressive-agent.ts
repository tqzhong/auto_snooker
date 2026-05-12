// ============================================================
// Aggressive Agent — Attack-first personality
// ============================================================

import type { GameState, Ball, BallColor } from '../../types';
import { BALL_VALUES, COLORS_ORDER } from '../../types';
import type { Agent, AgentDecision } from './agent';
import {
  getLegalTargetBalls, getDirectlyPlayableTargetBalls, calculateBestShot,
  calculateSafetyShot, findAnyLegalContactShot, findContactAngle,
  getPotLineCount, nearestPocket, distanceToPower, describeStrategy,
} from '../strategy';
import { planBreakSequence, shouldAttack, findSnookerPlacement } from '../positional';
import { distanceBetween } from '../../engine/physics';
import { registerAgent } from './agent';

export class AggressiveAgent implements Agent {
  readonly name = 'Aggressive';
  readonly version = '1.0';

  // Tunable parameters
  private riskTolerance = 0.85;
  private minPotProbability = 0.15;
  private powerBias = 0.65;

  async decide(state: GameState): Promise<AgentDecision> {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    const legalTargets = getLegalTargetBalls(state);
    if (legalTargets.length === 0) return this.emptyDecision();

    const playable = getDirectlyPlayableTargetBalls(state);

    // AGGRESSIVE: Attack if ANY pot is available
    if (playable.length > 0) {
      // Try break planning for best continuation
      const breakPlan = planBreakSequence(state, 3);
      if (breakPlan.length >= 2) {
        // Follow the planned sequence
        const firstShot = breakPlan[0];
        return {
          targetBallId: firstShot.targetBallId,
          aimAngle: firstShot.angle,
          power: firstShot.power,
          spinX: firstShot.spinX,
          spinY: firstShot.spinY,
          strategy: 'attack',
          reasoning: `[Aggressive] 连续进攻规划：${breakPlan.length}杆，优先高分彩球`,
        };
      }

      // No break plan: pick the best single pot
      const best = this.selectBestPot(state, playable);
      if (best) return best;
    }

    // No direct pot: try snooker laying
    const snooker = this.trySnooker(state, legalTargets);
    if (snooker) return snooker;

    // Fallback: safety
    return this.findBestSafety(state, legalTargets);
  }

  private selectBestPot(state: GameState, targets: Ball[]): AgentDecision | null {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return null;

    let bestDecision: AgentDecision | null = null;
    let bestScore = -Infinity;

    for (const target of targets) {
      const shot = calculateBestShot(state, target, this.powerBias);
      if (!shot) continue;

      const potCount = getPotLineCount(state, target);
      const np = nearestPocket(target);
      const value = BALL_VALUES[target.color as BallColor];

      // Score: pot value * 10 + pot lines * 50 - distance penalty
      const score = value * 10 + potCount * 50 - np.dist * 0.005;

      if (score > bestScore) {
        bestScore = score;
        bestDecision = {
          targetBallId: target.id,
          aimAngle: shot.angle,
          power: shot.power,
          spinX: 0,
          spinY: this.chooseAttackSpin(cueBall, target),
          strategy: 'attack',
          reasoning: `[Aggressive] 进攻${target.color}#${target.id} ${potCount}条线路 值${value}`,
        };
      }
    }

    return bestDecision;
  }

  private trySnooker(state: GameState, targets: Ball[]): AgentDecision | null {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return null;

    for (const target of targets.slice(0, 3)) {
      const snooker = findSnookerPlacement(state, target);
      if (snooker && snooker.snookerQuality > 60) {
        const contact = findContactAngle(state, target);
        if (contact) {
          return {
            targetBallId: target.id,
            aimAngle: snooker.angle,
            power: snooker.power,
            spinX: snooker.spinX,
            spinY: snooker.spinY,
            strategy: 'snooker',
            reasoning: `[Aggressive] 做斯诺克${target.color} 质量${snooker.snookerQuality} 逃脱${snooker.escapeAngles}条`,
          };
        }
      }
    }
    return null;
  }

  private findBestSafety(state: GameState, targets: Ball[]): AgentDecision {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    for (const target of targets) {
      const safety = calculateSafetyShot(state, target, 0.55);
      if (safety) {
        return {
          targetBallId: target.id,
          aimAngle: safety.angle,
          power: safety.power,
          spinX: 0,
          spinY: -0.15,
          strategy: 'safety',
          reasoning: `[Aggressive] 无法进攻，防守${target.color}`,
        };
      }
    }

    const escape = findAnyLegalContactShot(state, 0.55);
    if (escape) {
      return {
        targetBallId: escape.targetBallId,
        aimAngle: escape.angle,
        power: escape.power,
        spinX: 0, spinY: 0,
        strategy: 'safety',
        reasoning: `[Aggressive] 解球 #${escape.targetBallId}`,
      };
    }

    return this.emptyDecision();
  }

  private chooseAttackSpin(cueBall: { pos: { x: number; y: number } }, target: { pos: { x: number; y: number } }): number {
    const dist = distanceBetween(cueBall.pos, target.pos);
    return dist < 900 ? -0.18 : 0.22; // Follow or draw based on distance
  }

  private emptyDecision(): AgentDecision {
    return {
      targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '无目标',
    };
  }

  getParameters(): Record<string, number> {
    return {
      riskTolerance: this.riskTolerance,
      minPotProbability: this.minPotProbability,
      powerBias: this.powerBias,
    };
  }

  setParameters(params: Record<string, number>): void {
    if (params.riskTolerance !== undefined) this.riskTolerance = params.riskTolerance;
    if (params.minPotProbability !== undefined) this.minPotProbability = params.minPotProbability;
    if (params.powerBias !== undefined) this.powerBias = params.powerBias;
  }
}

registerAgent('aggressive', () => new AggressiveAgent());

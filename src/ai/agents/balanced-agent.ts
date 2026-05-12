// ============================================================
// Balanced Agent — Situation-adaptive strategy
// ============================================================

import type { GameState, Ball, BallColor } from '../../types';
import { BALL_VALUES, COLORS_ORDER } from '../../types';
import type { Agent, AgentDecision } from './agent';
import {
  getLegalTargetBalls, getDirectlyPlayableTargetBalls, calculateBestShot,
  calculateSafetyShot, findAnyLegalContactShot, findContactAngle,
  getPotLineCount, nearestPocket, distanceToPower,
} from '../strategy';
import { shouldAttack, planBreakSequence, findSnookerPlacement, evaluatePositionQuality } from '../positional';
import { distanceBetween } from '../../engine/physics';
import { registerAgent } from './agent';

export class BalancedAgent implements Agent {
  readonly name = 'Balanced';
  readonly version = '1.0';

  private aggressionLevel = 0.5;

  async decide(state: GameState): Promise<AgentDecision> {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    const legalTargets = getLegalTargetBalls(state);
    if (legalTargets.length === 0) return this.emptyDecision();

    // Update aggression based on game situation
    this.updateAggression(state);

    if (this.aggressionLevel > 0.65) {
      return this.attackDecision(state, legalTargets);
    } else if (this.aggressionLevel < 0.35) {
      return this.defendDecision(state, legalTargets);
    }
    return this.balancedDecision(state, legalTargets);
  }

  private updateAggression(state: GameState): void {
    const decision = shouldAttack(state);
    this.aggressionLevel = decision.aggressionLevel;
  }

  private attackDecision(state: GameState, targets: Ball[]): AgentDecision {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    // Break planning
    const breakPlan = planBreakSequence(state, 3);
    if (breakPlan.length >= 2) {
      const first = breakPlan[0];
      return {
        targetBallId: first.targetBallId,
        aimAngle: first.angle,
        power: first.power,
        spinX: first.spinX,
        spinY: first.spinY,
        strategy: 'attack',
        reasoning: `[Balanced] 进攻模式 ${breakPlan.length}杆规划`,
      };
    }

    // Best single pot
    const playable = getDirectlyPlayableTargetBalls(state);
    return this.findBestPot(state, playable.length > 0 ? playable : targets) ??
      this.findBestSafety(state, targets);
  }

  private defendDecision(state: GameState, targets: Ball[]): AgentDecision {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    // Try snooker
    for (const target of targets.slice(0, 3)) {
      const snooker = findSnookerPlacement(state, target);
      if (snooker && snooker.snookerQuality > 55) {
        const contact = findContactAngle(state, target);
        if (contact) {
          return {
            targetBallId: target.id,
            aimAngle: snooker.angle,
            power: snooker.power,
            spinX: snooker.spinX,
            spinY: snooker.spinY,
            strategy: 'snooker',
            reasoning: `[Balanced] 防守模式 做斯诺克 ${target.color} 质量${snooker.snookerQuality}`,
          };
        }
      }
    }

    return this.findBestSafety(state, targets);
  }

  private balancedDecision(state: GameState, targets: Ball[]): AgentDecision {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    // Check for easy pots (>= 2 pot lines)
    const easyPots = targets.filter(t => getPotLineCount(state, t) >= 2);
    if (easyPots.length > 0) {
      const pot = this.findBestPot(state, easyPots);
      if (pot) return pot;
    }

    // Mixed: try snooker then safety
    const snooker = findSnookerPlacement(state, targets[0]);
    if (snooker && snooker.snookerQuality > 60) {
      const contact = findContactAngle(state, targets[0]);
      if (contact) {
        return {
          targetBallId: targets[0].id,
          aimAngle: snooker.angle,
          power: snooker.power,
          spinX: snooker.spinX,
          spinY: snooker.spinY,
          strategy: 'snooker',
          reasoning: `[Balanced] 均衡模式 做斯诺克`,
        };
      }
    }

    return this.findBestSafety(state, targets);
  }

  private findBestPot(state: GameState, targets: Ball[]): AgentDecision | null {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return null;

    let best: AgentDecision | null = null;
    let bestScore = -Infinity;

    for (const target of targets) {
      const shot = calculateBestShot(state, target, 0.55);
      if (!shot) continue;

      const potCount = getPotLineCount(state, target);
      const value = BALL_VALUES[target.color as BallColor];
      const np = nearestPocket(target);
      const score = value * 10 + potCount * 40 - np.dist * 0.003;

      if (score > bestScore) {
        bestScore = score;
        best = {
          targetBallId: target.id,
          aimAngle: shot.angle,
          power: shot.power,
          spinX: 0,
          spinY: distanceBetween(cueBall.pos, target.pos) < 900 ? -0.12 : 0.18,
          strategy: 'attack',
          reasoning: `[Balanced] 进攻${target.color} 值${value} ${potCount}条线路`,
        };
      }
    }

    return best;
  }

  private findBestSafety(state: GameState, targets: Ball[]): AgentDecision {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    for (const target of targets) {
      const safety = calculateSafetyShot(state, target, 0.45);
      if (safety) {
        return {
          targetBallId: target.id,
          aimAngle: safety.angle,
          power: safety.power,
          spinX: 0, spinY: -0.1,
          strategy: 'safety',
          reasoning: `[Balanced] 防守 ${target.color}`,
        };
      }
    }

    const escape = findAnyLegalContactShot(state, 0.45);
    if (escape) {
      return {
        targetBallId: escape.targetBallId,
        aimAngle: escape.angle,
        power: escape.power,
        spinX: 0, spinY: 0,
        strategy: 'safety',
        reasoning: `[Balanced] 解球`,
      };
    }

    return this.emptyDecision();
  }

  private emptyDecision(): AgentDecision {
    return {
      targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '无目标',
    };
  }

  getParameters(): Record<string, number> {
    return { aggressionLevel: this.aggressionLevel };
  }

  setParameters(params: Record<string, number>): void {
    if (params.aggressionLevel !== undefined) this.aggressionLevel = params.aggressionLevel;
  }
}

registerAgent('balanced', () => new BalancedAgent());

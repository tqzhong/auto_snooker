// ============================================================
// Rule-Based Agent — Extracted from llm-engine fallback
// ============================================================

import type { GameState } from '../../types';
import type { Agent, AgentDecision } from './agent';
import {
  getAvailableTargets, getLegalTargetBalls, getDirectlyPlayableTargetBalls,
  calculateBestShot, calculateSafetyShot, findAnyLegalContactShot,
  findContactAngle, getPotLineCount, nearestPocket, distanceToPower,
  describeStrategy, describeSpin,
} from '../strategy';
import { distanceBetween } from '../../engine/physics';
import { registerAgent } from './agent';

export class RuleBasedAgent implements Agent {
  readonly name = 'RuleBased';
  readonly version = '1.0';

  async decide(state: GameState): Promise<AgentDecision> {
    const available = getAvailableTargets(state);
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    const legalTargets = state.balls.filter(b =>
      available.ballIds.includes(b.id) && !b.pocketed
    );
    const targets = getDirectlyPlayableTargetBalls(state);

    if (legalTargets.length === 0) return this.emptyDecision();

    if (targets.length === 0) {
      const target = legalTargets[0];
      const spin = this.chooseSpin('safety', cueBall, target);
      return {
        targetBallId: target.id, aimAngle: 0, power: 0.7, ...spin,
        strategy: 'safety',
        reasoning: `[RuleBased] 所有合法目标被挡，搜索解斯诺克线路`,
      };
    }

    // Aggressive: prefer attack if any target has pot lines
    let bestTarget = targets[0];
    let bestPotCount = -1;
    let bestPocketDist = Infinity;
    for (const t of targets) {
      const potCount = getPotLineCount(state, t);
      const np = nearestPocket(t);
      if (potCount > bestPotCount || (potCount === bestPotCount && np.dist < bestPocketDist)) {
        bestPotCount = potCount;
        bestPocketDist = np.dist;
        bestTarget = t;
      }
    }

    const hasPotLine = bestPotCount > 0;
    if (hasPotLine) {
      const shot = calculateBestShot(state, bestTarget, 0.5);
      if (shot) {
        const spin = this.chooseSpin('attack', cueBall, bestTarget);
        return {
          targetBallId: bestTarget.id, aimAngle: shot.angle, power: shot.power,
          ...spin, strategy: 'attack',
          reasoning: `[RuleBased] ${bestTarget.color}#${bestTarget.id} 有${bestPotCount}条进球线路`,
        };
      }
    }

    const safety = calculateSafetyShot(state, bestTarget, 0.5);
    if (safety) {
      const spin = this.chooseSpin('safety', cueBall, bestTarget);
      return {
        targetBallId: bestTarget.id, aimAngle: safety.angle, power: safety.power,
        ...spin, strategy: 'safety',
        reasoning: `[RuleBased] 无进球线路，防守`,
      };
    }

    const escape = findAnyLegalContactShot(state, 0.5);
    if (escape) {
      return {
        targetBallId: escape.targetBallId, aimAngle: escape.angle, power: escape.power,
        spinX: 0, spinY: 0, strategy: 'safety',
        reasoning: `[RuleBased] 解斯诺克 #${escape.targetBallId}`,
      };
    }

    return this.emptyDecision();
  }

  private chooseSpin(
    strategy: 'attack' | 'safety' | 'snooker',
    cueBall: { pos: { x: number; y: number } },
    target: { pos: { x: number; y: number } },
  ): { spinX: number; spinY: number } {
    const dist = distanceBetween(cueBall.pos, target.pos);
    if (strategy === 'attack') {
      return { spinX: 0, spinY: dist < 900 ? -0.15 : 0.18 };
    }
    return { spinX: 0, spinY: -0.1 };
  }

  private emptyDecision(): AgentDecision {
    return {
      targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '无目标',
    };
  }
}

registerAgent('rule-based', () => new RuleBasedAgent());

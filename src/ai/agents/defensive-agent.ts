// ============================================================
// Defensive Agent — Safety-first personality
// ============================================================

import type { GameState, Ball } from '../../types';
import type { Agent, AgentDecision } from './agent';
import {
  getLegalTargetBalls, calculateBestShot,
  calculateSafetyShot, findAnyLegalContactShot, findContactAngle,
  getPotLineCount, nearestPocket,
} from '../strategy';
import { shouldAttack, findSnookerPlacement } from '../positional';
import { distanceBetween } from '../../engine/physics';
import { registerAgent } from './agent';

export class DefensiveAgent implements Agent {
  readonly name = 'Defensive';
  readonly version = '1.0';

  private safetyPreference = 0.8;
  private snookerSkill = 0.7;

  async decide(state: GameState): Promise<AgentDecision> {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    const legalTargets = getLegalTargetBalls(state);
    if (legalTargets.length === 0) return this.emptyDecision();

    const decision = shouldAttack(state);

    // Only attack when clearly advantageous
    if (decision.attack && decision.aggressionLevel > 0.6) {
      const attackResult = this.findControlledPot(state, legalTargets);
      if (attackResult) return attackResult;
    }

    // Try snooker laying
    const snooker = this.tryLaySnooker(state, legalTargets);
    if (snooker) return snooker;

    // Safety shot
    return this.findBestSafety(state, legalTargets);
  }

  private findControlledPot(state: GameState, targets: Ball[]): AgentDecision | null {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return null;

    // Prefer easy pots with good position
    for (const target of targets) {
      const potCount = getPotLineCount(state, target);
      if (potCount < 2) continue; // Only easy pots

      const shot = calculateBestShot(state, target, 0.45);
      if (!shot) continue;

      return {
        targetBallId: target.id,
        aimAngle: shot.angle,
        power: shot.power,
        spinX: 0,
        spinY: 0.15, // Slight follow for position
        strategy: 'attack',
        reasoning: `[Defensive] 控制性进攻 ${target.color} ${potCount}条线路`,
      };
    }

    return null;
  }

  private tryLaySnooker(state: GameState, targets: Ball[]): AgentDecision | null {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return null;

    for (const target of targets.slice(0, 3)) {
      const snooker = findSnookerPlacement(state, target);
      if (snooker && snooker.snookerQuality > 50) {
        const contact = findContactAngle(state, target);
        if (contact) {
          return {
            targetBallId: target.id,
            aimAngle: snooker.angle,
            power: snooker.power,
            spinX: snooker.spinX,
            spinY: snooker.spinY,
            strategy: 'snooker',
            reasoning: `[Defensive] 做斯诺克 ${target.color} 质量${snooker.snookerQuality} 逃脱${snooker.escapeAngles}条`,
          };
        }
      }
    }
    return null;
  }

  private findBestSafety(state: GameState, targets: Ball[]): AgentDecision {
    const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
    if (!cueBall) return this.emptyDecision();

    let bestSafety: AgentDecision | null = null;
    let bestScore = -Infinity;

    for (const target of targets) {
      const safety = calculateSafetyShot(state, target, 0.4);
      if (!safety) continue;

      // Evaluate: hit target, leave cue ball far from any pocket
      const copy = state.balls.map(b => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } }));
      // Prefer leaving the cue ball in baulk area
      const distToTarget = distanceBetween(cueBall.pos, target.pos);
      const np = nearestPocket(target);
      const score = distToTarget * 0.01 - np.dist * 0.005; // Far from target, target far from pocket

      if (score > bestScore) {
        bestScore = score;
        bestSafety = {
          targetBallId: target.id,
          aimAngle: safety.angle,
          power: safety.power,
          spinX: 0,
          spinY: -0.1,
          strategy: 'safety',
          reasoning: `[Defensive] 防守 ${target.color} 远离袋口`,
        };
      }
    }

    if (bestSafety) return bestSafety;

    const escape = findAnyLegalContactShot(state, 0.4);
    if (escape) {
      return {
        targetBallId: escape.targetBallId,
        aimAngle: escape.angle,
        power: escape.power,
        spinX: 0, spinY: 0,
        strategy: 'safety',
        reasoning: `[Defensive] 解球`,
      };
    }

    return this.emptyDecision();
  }

  private emptyDecision(): AgentDecision {
    return {
      targetBallId: 0, aimAngle: 0, power: 0.35, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '无目标',
    };
  }

  getParameters(): Record<string, number> {
    return { safetyPreference: this.safetyPreference, snookerSkill: this.snookerSkill };
  }

  setParameters(params: Record<string, number>): void {
    if (params.safetyPreference !== undefined) this.safetyPreference = params.safetyPreference;
    if (params.snookerSkill !== undefined) this.snookerSkill = params.snookerSkill;
  }
}

registerAgent('defensive', () => new DefensiveAgent());

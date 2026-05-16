// ============================================================
// Master Snooker Agent - one agent for attack, position, safety
// ============================================================

import type { GameState } from '../../types';
import type { Agent, AgentDecision } from './agent';
import { getLegalTargetBalls, findAnyLegalContactShot } from '../strategy';
import type { MacroStrategyAdvice, MasterScoringParams } from '../positional';
import { selectMasterPositionalShot } from '../positional';
import { registerAgent } from './agent';

export interface MasterAgentParams extends Partial<MasterScoringParams> {
  creativity: number;
  llmInfluence: number;
  searchDepth: number;
  beamWidth: number;
  branchWidth: number;
}

export class MasterSnookerAgent implements Agent {
  readonly version = '1.0';
  private params: MasterAgentParams;

  constructor(
    readonly name = 'Master',
    params: Partial<MasterAgentParams> = {},
    private macroAdvice: MacroStrategyAdvice | null = null,
  ) {
    this.params = {
      creativity: 0.18,
      llmInfluence: 0,
      searchDepth: 2,
      beamWidth: 3,
      branchWidth: 3,
      difficultyPenalty: 7.2,
      highDifficultyPenalty: 220,
      cueTravelPenalty: 1,
      positionReward: 1,
      safetyReward: 1,
      valueReward: 1,
      blackPinkBias: 1.25,
      spinUseReward: 1.1,
      ...params,
    };
  }

  setMacroAdvice(advice: MacroStrategyAdvice | null): void {
    this.macroAdvice = advice;
  }

  async decide(state: GameState): Promise<AgentDecision> {
    const macroAdvice = this.params.llmInfluence > 0 ? this.macroAdvice : null;
    const shot = selectMasterPositionalShot(state, {
      creativity: this.params.creativity,
      macroAdvice,
      searchDepth: this.params.searchDepth,
      beamWidth: this.params.beamWidth,
      branchWidth: this.params.branchWidth,
      scoring: this.params,
    });
    if (shot) {
      const llmReason = macroAdvice?.reasoning ? `；LLM宏观: ${macroAdvice.reasoning}` : '';
      return {
        targetBallId: shot.targetBallId,
        aimAngle: shot.angle,
        power: shot.power,
        spinX: shot.spinX,
        spinY: shot.spinY,
        strategy: shot.strategy,
        reasoning: `[Master] ${shot.reasoning}；评分${shot.score.toFixed(1)}，杆法 spinX=${shot.spinX.toFixed(2)} spinY=${shot.spinY.toFixed(2)} power=${shot.power.toFixed(2)}${llmReason}`,
      };
    }

    const escape = findAnyLegalContactShot(state, 0.55);
    if (escape) {
      return {
        targetBallId: escape.targetBallId,
        aimAngle: escape.angle,
        power: escape.power,
        spinX: 0,
        spinY: 0,
        strategy: 'safety',
        reasoning: `[Master] 无可控候选，执行最低风险合法解球 #${escape.targetBallId}`,
      };
    }

    const fallbackTarget = getLegalTargetBalls(state)[0];
    return {
      targetBallId: fallbackTarget?.id ?? 0,
      aimAngle: 0,
      power: 0.35,
      spinX: 0,
      spinY: 0,
      strategy: 'safety',
      reasoning: '[Master] 无合法目标，保守兜底',
    };
  }

  getParameters(): Record<string, number> {
    return { ...this.params };
  }

  setParameters(params: Record<string, number>): void {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const max = key === 'highDifficultyPenalty' ? 500 :
        key === 'searchDepth' ? 6 :
          key === 'beamWidth' || key === 'branchWidth' ? 8 : 2;
      this.params[key as keyof MasterAgentParams] = Math.max(0, Math.min(max, value));
    }
  }
}

registerAgent('master', () => new MasterSnookerAgent());

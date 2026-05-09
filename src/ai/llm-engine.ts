// ============================================================
// LLM Decision Engine
// Uses Xiaomi MiMo API (OpenAI-compatible) to make snooker decisions
// ============================================================

import type { GameState, LLMDecision, Ball, BallColor, Vec2, ShotRecord } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import { TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS } from '../engine/constants';
import { describeBallPositions, distanceBetween, angleBetween } from '../engine/physics';

// API config from environment
const API_KEY = import.meta.env.VITE_AI_API_KEY || '';
const BASE_URL = import.meta.env.VITE_AI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
const MODEL = import.meta.env.VITE_AI_MODEL || 'mimo-v2.5-pro';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function formatShotHistory(history: ShotRecord[], players: [string, string]): string {
  if (history.length === 0) return '暂无历史出杆记录';

  const recent = history.slice(-5);
  return recent.map((s, i) => {
    const player = players[s.playerIndex];
    const result = s.result.pointsScored > 0
      ? `进球得${s.result.pointsScored}分`
      : s.result.fouls.length > 0
        ? `犯规: ${s.result.fouls.map(f => f.description).join(', ')}`
        : '未进球';
    return `${i + 1}. ${player}: 目标球#${s.shotParams.targetBallId}, ${result}`;
  }).join('\n');
}

function formatBallState(balls: Ball[]): string {
  const active = balls.filter(b => !b.pocketed);
  const reds = active.filter(b => b.color === 'red');
  const colors = active.filter(b => b.color !== 'red' && b.color !== 'white');
  const cue = active.find(b => b.color === 'white');

  let desc = '';
  desc += `主球(白球): ${cue ? `(${Math.round(cue.pos.x)}, ${Math.round(cue.pos.y)})` : '已落袋'}`;
  desc += `\n红球(${reds.length}个): ${reds.map(b => `#${b.id}(${Math.round(b.pos.x)},${Math.round(b.pos.y)})`).join(', ')}`;
  desc += `\n彩球: ${colors.map(b => `${b.color}#${b.id}(${Math.round(b.pos.x)},${Math.round(b.pos.y)})`).join(', ')}`;

  return desc;
}

function getPhaseDescription(state: GameState): string {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;

  switch (state.phase) {
    case 'break_off':
      return '开球阶段';
    case 'reds_phase':
      if (redsOnTable > 0) {
        return `红球阶段（剩余${redsOnTable}个红球）`;
      }
      return '红球阶段即将结束';
    case 'colors_phase':
      return `彩球阶段（需按顺序: 黄→绿→棕→蓝→粉→黑）当前需进球: ${state.nextColorToPot}`;
    case 'game_over':
      return '本局已结束';
    default:
      return '比赛进行中';
  }
}

function getStrategyHint(state: GameState, opponentScore: number): string {
  const current = state.players[state.currentPlayerIndex];
  const scoreDiff = current.score - opponentScore;
  const maxRemaining = state.balls
    .filter(b => !b.pocketed && b.color !== 'white')
    .reduce((sum, b) => sum + BALL_VALUES[b.color as BallColor], 0);

  if (scoreDiff > maxRemaining) {
    return '你领先对手超过台面剩余分数，对手snooker才能追回。可以稳健出杆。';
  }
  if (scoreDiff < -maxRemaining) {
    return '你落后很多，需要积极进攻争取连续得分。';
  }
  if (scoreDiff < 0) {
    return '你略微落后，需要进攻但也要注意防守质量。';
  }
  if (current.currentBreak > 20) {
    return `当前单杆已得${current.currentBreak}分，保持节奏。`;
  }
  return '比分接近，根据球形选择最佳策略。';
}

function buildSystemPrompt(): string {
  return `你是一个专业斯诺克AI教练。你必须严格遵守WPBSA官方斯诺克规则。

## 核心规则（你必须严格遵守）

### 基本规则
- 台面: 11ft 8½in × 5ft 10in (3569mm × 1778mm)
- 22颗球: 1颗白球(主球), 15颗红球, 6颗彩球(黄/绿/棕/蓝/粉/黑)
- **只有白球(主球)可以被球杆击打**。你永远只能击打白球，不能直接击打任何其他球。
- 你的决策是：控制白球击打的方向、力量和旋转，让白球去撞击目标球。

### 进攻规则
- 红球阶段：必须先用白球碰红球。进球红球后，可以选择任意彩球进攻。
- 彩球阶段：必须按顺序进球（黄→绿→棕→蓝→粉→黑），用白球先碰指定彩球。
- 彩球进球后会被放回原位（红球阶段），直到所有红球打完。

### 计分
- 红球=1分, 黄=2, 绿=3, 棕=4, 蓝=5, 粉=6, 黑=7
- 犯规罚分: 最少4分，最多7分（给对手加分）

### 台面坐标
- x轴=长轴: x=0是黑球端（顶袋端），x=3569是开球端（底袋端/baulk端）
- y轴=短轴: y=0是左库边，y=1778是右库边
- 白球只能从D区（baulk线附近）出发

### 球位参考
- 黑球点: (324, 889)
- 粉球点: (892, 889)
- 蓝球点: (1785, 889)
- Baulk线: x=2832
- 棕球点: (2832, 889) [baulk线中心]
- 黄球点: (2832, 1181) [baulk线右侧]
- 绿球点: (2832, 597) [baulk线左侧]

## 输出格式（严格JSON，不要有任何多余文字）

{
  "targetBallId": 目标球的id编号,
  "aimAngle": 瞄准角度(弧度),
  "power": 力度(0.1到1.0),
  "spinX": 横向旋转(-1到1),
  "spinY": 纵向旋转(-1到1),
  "strategy": "attack"或"safety"或"snooker",
  "reasoning": "简要理由(20字以内)"
}

角度说明:
- 弧度制, 0=向右(+x方向), π/2=向下(+y方向), π=向左(-x方向), -π/2=向上(-y方向)
- 白球向目标球的中心方向瞄准

力度说明:
- 0.2-0.4: 轻力（短距离进球、精准走位）
- 0.4-0.6: 中力（标准进球）
- 0.6-0.8: 中大力（长距离进球、开球）
- 0.8-1.0: 大力（大力开球、强力防守）

## 重要提醒
1. targetBallId 必须是白球要撞击的目标球的ID编号（红球或彩球）
2. aimAngle 是从白球位置指向目标球方向的角度
3. 你永远只控制白球的运动方向和力量
4. 选择目标球时要确保白球首先碰到的是规则允许的球
`;
}

function buildUserPrompt(state: GameState): string {
  const currentPlayer = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];

  const ballState = formatBallState(state.balls);
  const shotHistory = formatShotHistory(state.shotHistory, [state.players[0].name, state.players[1].name]);
  const phaseDesc = getPhaseDescription(state);
  const strategyHint = getStrategyHint(state, opponent.score);

  const availableTargets = getAvailableTargets(state);

  // Calculate angle from cue ball to a sample target for LLM reference
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  let angleHint = '';
  if (cueBall && availableTargets.ballIds.length > 0) {
    const firstTarget = state.balls.find(b => b.id === availableTargets.ballIds[0]);
    if (firstTarget) {
      const ang = angleBetween(cueBall.pos, firstTarget.pos);
      angleHint = `\n参考: 白球到${firstTarget.color}球(#${firstTarget.id})的瞄准角度约为 ${ang.toFixed(2)} 弧度`;
    }
  }

  return `你是${currentPlayer.name}，当前轮到你出杆。

== 得分 ==
你: ${currentPlayer.score}分 (当前单杆: ${currentPlayer.currentBreak})
对手${opponent.name}: ${opponent.score}分

== 比赛阶段 ==
${phaseDesc}

== 台面球位 (坐标: x=长轴, y=短轴) ==
${ballState}

== 合法目标 ==
${availableTargets.description}
可用目标球ID: [${availableTargets.ballIds.join(', ')}]

== 策略建议 ==
${strategyHint}

== 历史出杆 ==
${shotHistory}
${angleHint}

请给出你的出杆决策（严格JSON，不要有任何其他文字）：`;
}

function getAvailableTargets(state: GameState): { description: string; ballIds: number[] } {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed);

  if (state.phase === 'break_off' || state.phase === 'reds_phase') {
    if (redsOnTable.length > 0) {
      const lastShot = state.shotHistory[state.shotHistory.length - 1];
      if (lastShot && lastShot.result.pottedBalls.some(b => b.color === 'red')) {
        const colors = state.balls.filter(b => COLORS_ORDER.includes(b.color as BallColor) && !b.pocketed);
        return {
          description: '你刚进球红球，现在必须用白球先碰彩球（黄/绿/棕/蓝/粉/黑任选）',
          ballIds: colors.map(b => b.id),
        };
      }
      return {
        description: '红球阶段：用白球先碰红球（也可碰彩球但红球优先）',
        ballIds: redsOnTable.map(b => b.id),
      };
    }
  }

  if (state.phase === 'colors_phase' && state.nextColorToPot) {
    const target = state.balls.find(b => b.color === state.nextColorToPot && !b.pocketed);
    if (target) {
      return {
        description: `彩球阶段：必须用白球先碰${state.nextColorToPot}球`,
        ballIds: [target.id],
      };
    }
  }

  // Fallback: all reds
  return {
    description: '用白球碰红球',
    ballIds: redsOnTable.map(b => b.id),
  };
}

/** Call Xiaomi MiMo API for shot decision */
export async function getAIMoveDecision(state: GameState): Promise<LLMDecision> {
  if (!API_KEY) {
    console.warn('No AI API key configured, using fallback decision');
    return getFallbackDecision(state);
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(state);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.error('LLM API error:', response.status, response.statusText);
      return getFallbackDecision(state);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse LLM response as JSON:', content);
      return getFallbackDecision(state);
    }

    const decision = JSON.parse(jsonMatch[0]) as LLMDecision;

    // Validate required fields
    if (typeof decision.targetBallId !== 'number' ||
        typeof decision.aimAngle !== 'number' ||
        typeof decision.power !== 'number') {
      console.error('Invalid LLM decision structure:', decision);
      return getFallbackDecision(state);
    }

    // Clamp values to valid ranges
    decision.power = Math.max(0.1, Math.min(1.0, decision.power));
    decision.spinX = Math.max(-1, Math.min(1, decision.spinX || 0));
    decision.spinY = Math.max(-1, Math.min(1, decision.spinY || 0));
    decision.targetBallId = Math.max(0, Math.round(decision.targetBallId));

    // Validate target ball exists and is on the table
    const targetBall = state.balls.find(b => b.id === decision.targetBallId && !b.pocketed);
    if (!targetBall) {
      console.warn(`LLM chose non-existent/pocketed ball #${decision.targetBallId}, falling back`);
      return getFallbackDecision(state);
    }

    // Ensure LLM didn't choose the cue ball as a target
    if (targetBall.color === 'white') {
      console.warn('LLM chose cue ball as target, falling back');
      return getFallbackDecision(state);
    }

    return decision;
  } catch (err) {
    console.error('LLM API call failed:', err);
    return getFallbackDecision(state);
  }
}

/** Fallback: rule-based decision when LLM is unavailable */
export function getFallbackDecision(state: GameState): LLMDecision {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) {
    return {
      targetBallId: 0, aimAngle: 0, power: 0.5, spinX: 0, spinY: 0,
      strategy: 'attack', reasoning: '无主球',
    };
  }

  const available = getAvailableTargets(state);
  const targets = state.balls.filter(b =>
    available.ballIds.includes(b.id) && !b.pocketed
  );

  if (targets.length === 0) {
    // No legal target — safety shot toward top cushion
    return {
      targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '无合法目标，防守',
    };
  }

  // Find closest target to cue ball
  let bestTarget = targets[0];
  let bestDist = Infinity;
  for (const target of targets) {
    const dist = distanceBetween(cueBall.pos, target.pos);
    if (dist < bestDist) {
      bestDist = dist;
      bestTarget = target;
    }
  }

  const angle = angleBetween(cueBall.pos, bestTarget.pos);
  const nearPocket = isNearPocket(bestTarget);
  const power = nearPocket ? 0.35 : 0.5;

  return {
    targetBallId: bestTarget.id,
    aimAngle: angle,
    power,
    spinX: 0,
    spinY: -0.1,
    strategy: nearPocket ? 'attack' : 'safety',
    reasoning: nearPocket
      ? `${bestTarget.color}在袋口，进攻`
      : `${bestTarget.color}最近，出杆`,
  };
}

function isNearPocket(ball: Ball): boolean {
  const pockets: [number, number][] = [
    [54, 54], [TABLE_LENGTH / 2, 0], [54, TABLE_WIDTH - 54],
    [TABLE_LENGTH - 54, 54], [TABLE_LENGTH / 2, TABLE_WIDTH], [TABLE_LENGTH - 54, TABLE_WIDTH - 54],
  ];

  for (const [px, py] of pockets) {
    const dx = ball.pos.x - px;
    const dy = ball.pos.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 200) return true;
  }
  return false;
}

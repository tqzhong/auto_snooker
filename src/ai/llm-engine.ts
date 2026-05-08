// ============================================================
// LLM Decision Engine
// Uses Xiaomi MiMo API (OpenAI-compatible) to make snooker decisions
// ============================================================

import type { GameState, LLMDecision, Ball, BallColor, Vec2, ShotRecord } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import { TABLE_WIDTH, TABLE_HEIGHT, BALL_RADIUS } from '../engine/constants';
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

  const recent = history.slice(-5); // Last 5 shots for context
  return recent.map((s, i) => {
    const player = players[s.playerIndex];
    const target = s.shotParams.targetBallId;
    const result = s.result.pointsScored > 0
      ? `进球得${s.result.pointsScored}分`
      : s.result.fouls.length > 0
        ? `犯规: ${s.result.fouls.map(f => f.description).join(', ')}`
        : '未进球';
    return `${i + 1}. ${player}: 目标球${target}, ${result}`;
  }).join('\n');
}

function formatBallState(balls: Ball[]): string {
  const active = balls.filter(b => !b.pocketed);
  const reds = active.filter(b => b.color === 'red');
  const colors = active.filter(b => b.color !== 'red' && b.color !== 'white');
  const cue = active.find(b => b.color === 'white');

  let desc = '';
  desc += `红球(${reds.length}个): ${reds.map(b => `#${b.id}(${Math.round(b.pos.x)},${Math.round(b.pos.y)})`).join(', ')}`;
  desc += `\n彩球: ${colors.map(b => `${b.color}#${b.id}(${Math.round(b.pos.x)},${Math.round(b.pos.y)})`).join(', ')}`;
  desc += `\n主球: ${cue ? `(${Math.round(cue.pos.x)},${Math.round(cue.pos.y)})` : '已落袋'}`;

  return desc;
}

function getPhaseDescription(state: GameState): string {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;

  switch (state.phase) {
    case 'break_off':
      return '开球阶段: 必须先碰红球，尽量让主球安全回到底库';
    case 'reds_phase':
      if (redsOnTable > 0) {
        return `红球阶段: 还有${redsOnTable}个红球。可以进攻红球或彩球。进球红球后必须选择彩球。`;
      }
      return '红球阶段: 红球即将打完，准备进入彩球阶段';
    case 'colors_phase':
      return `彩球阶段: 必须按顺序进球(${COLORS_ORDER.join('→')})。当前需要进球: ${state.nextColorToPot}`;
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
    return '你领先对手超过台面剩余分数，对手需要犯规才能追平。可以稳健出杆。';
  }
  if (scoreDiff < -maxRemaining) {
    return '你落后较多，需要积极进攻争取连续得分。';
  }
  if (scoreDiff < 0) {
    return '你略微落后，需要进攻但也要注意防守质量。';
  }
  if (current.currentBreak > 20) {
    return `当前单杆已得${current.currentBreak}分，保持节奏继续得分。`;
  }
  return '比分接近，根据台面球形选择最佳进攻或防守策略。';
}

function findSafestRed(ballPositions: string): { targetId: number; reason: string } {
  // Parse ball positions to find a potable red
  const reds = ballPositions.match(/red\((\d+),(\d+)\)/g) || [];
  // Return first red as default
  return { targetId: 0, reason: '无合适红球目标' };
}

function buildSystemPrompt(): string {
  return `你是一个专业的斯诺克AI教练，负责为球员制定出杆策略。

你需要根据当前台面形势，决定出杆选择：
- **进攻(attac)**: 直接尝试进球得分
- **防守(safety)**: 将主球藏到安全位置，给对手制造困难
- **斯诺克(snooker)**: 故意将主球藏在非目标球后面

输出格式要求（严格JSON）：
{
  "targetBallId": 1,          // 目标球的ID
  "aimAngle": 0.5,            // 瞄准角度(弧度，0=向右，π/2=向下)
  "power": 0.6,               // 力度(0-1)
  "spinX": 0.0,               // 横向旋转(-1到1，左旋到右旋)
  "spinY": 0.0,               // 纵向旋转(-1到1，下旋到上旋)
  "strategy": "attack",        // attack/safety/snooker
  "reasoning": "简要说明理由"
}

注意：
- 角度以弧度为单位，0表示向右，正数表示顺时针（向下）
- 力度0.3-0.7适合普通进球，0.8+适合大力开球
- 防守时可以力度较大但角度要精确
- spin影响主球走位，left/right english让主球偏转
`;
}

function buildUserPrompt(state: GameState): string {
  const currentPlayer = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];

  const ballState = formatBallState(state.balls);
  const shotHistory = formatShotHistory(state.shotHistory, [state.players[0].name, state.players[1].name]);
  const phaseDesc = getPhaseDescription(state);
  const strategyHint = getStrategyHint(state, opponent.score);

  // Find available targets based on rules
  const availableTargets = getAvailableTargets(state);

  return `当前局面分析：
==================================
你的名字: ${currentPlayer.name}
你的得分: ${currentPlayer.score}
对手(${opponent.name})得分: ${opponent.score}
当前单杆: ${currentPlayer.currentBreak}
==================================

台面状态：
${ballState}

比赛阶段: ${phaseDesc}
当前应该进攻: ${availableTargets.description}

历史出杆（最近5次）:
${shotHistory}

策略建议: ${strategyHint}

桌面尺寸: ${TABLE_WIDTH}mm x ${TABLE_HEIGHT}mm
球半径: ${BALL_RADIUS}mm

请根据以上信息，给出你的出杆决策（严格JSON格式，不要有多余文字）：`;
}

function getAvailableTargets(state: GameState): { description: string; colors: BallColor[] } {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed).length;

  if (state.phase === 'break_off' || state.phase === 'reds_phase') {
    if (redsOnTable > 0) {
      // Check if last shot potted a red
      const lastShot = state.shotHistory[state.shotHistory.length - 1];
      if (lastShot && lastShot.result.pottedBalls.some(b => b.color === 'red')) {
        return {
          description: '进球红球后选择彩球（黄/绿/棕/蓝/粉/黑）',
          colors: COLORS_ORDER,
        };
      }
      return {
        description: '进攻红球（也可以直接进攻彩球，但红球分值低且占据好位置）',
        colors: ['red', ...COLORS_ORDER],
      };
    }
  }

  if (state.phase === 'colors_phase') {
    if (state.nextColorToPot) {
      return {
        description: `必须进攻${state.nextColorToPot}球`,
        colors: [state.nextColorToPot],
      };
    }
  }

  return { description: '红球', colors: ['red'] };
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

    // Parse JSON from response (handle potential markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse LLM response as JSON:', content);
      return getFallbackDecision(state);
    }

    const decision = JSON.parse(jsonMatch[0]) as LLMDecision;

    // Validate
    if (typeof decision.targetBallId !== 'number' ||
        typeof decision.aimAngle !== 'number' ||
        typeof decision.power !== 'number') {
      console.error('Invalid LLM decision structure:', decision);
      return getFallbackDecision(state);
    }

    // Clamp values
    decision.power = Math.max(0.1, Math.min(1.0, decision.power));
    decision.spinX = Math.max(-1, Math.min(1, decision.spinX || 0));
    decision.spinY = Math.max(-1, Math.min(1, decision.spinY || 0));
    decision.targetBallId = Math.max(0, decision.targetBallId);

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
      strategy: 'attack', reasoning: '无主球，无法出杆',
    };
  }

  const available = getAvailableTargets(state);
  const targets = state.balls.filter(b =>
    available.colors.includes(b.color as BallColor) && !b.pocketed
  );

  if (targets.length === 0) {
    // No legal target, just hit forward
    return {
      targetBallId: 0, aimAngle: -Math.PI / 2, power: 0.3, spinX: 0, spinY: 0,
      strategy: 'safety', reasoning: '没有合法目标，安全出杆',
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

  // Check if near pocket for pot chance
  const nearPocket = isNearPocket(bestTarget);
  const power = nearPocket ? 0.4 : 0.55;

  return {
    targetBallId: bestTarget.id,
    aimAngle: angle,
    power,
    spinX: 0,
    spinY: -0.1, // Slight backspin for position
    strategy: nearPocket ? 'attack' : 'safety',
    reasoning: nearPocket
      ? `${bestTarget.color}球在袋口附近，选择进攻`
      : `${bestTarget.color}球是最佳目标，稳健出杆`,
  };
}

function isNearPocket(ball: Ball): boolean {
  const pockets: [number, number][] = [
    [54, 54], [TABLE_WIDTH / 2, 0], [TABLE_WIDTH - 54, 54],
    [54, TABLE_HEIGHT - 54], [TABLE_WIDTH / 2, TABLE_HEIGHT], [TABLE_WIDTH - 54, TABLE_HEIGHT - 54],
  ];

  for (const [px, py] of pockets) {
    const dx = ball.pos.x - px;
    const dy = ball.pos.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 200) return true; // Within 200mm of pocket
  }
  return false;
}

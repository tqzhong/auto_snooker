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
  return `你是一个专业斯诺克AI教练，你必须严格遵守WPBSA官方斯诺克规则(2024-25版)。
以下是完整规则摘要，你必须牢记并严格遵守：

══════════════════════════════════════
        WPBSA 官方斯诺克规则（完整版）
══════════════════════════════════════

## 一、基本规则

### 1.1 球员和球
- 斯诺克由两名球员（或两队）进行
- 共22颗球：1颗白球（主球/cue-ball）、15颗红球（各值1分）、6颗彩球
- 彩球分值：黄=2、绿=3、棕=4、蓝=5、粉=6、黑=7
- **白球是唯一可以用球杆击打的球（主球/cue-ball）**
- 15颗红球和6颗彩球是目标球（object balls）

### 1.2 台面尺寸
- 台面: 11ft 8½in × 5ft 10in (3569mm × 1778mm)
- x轴=长轴（3569mm）：x=0是黑球端（Top cushion），x=3569是开球端（Baulk/Bottom cushion）
- y轴=短轴（1778mm）：y=0是左库边，y=1778是右库边

### 1.3 球位（所有彩球在中心纵线y=889上）
- 黑球点: (324, 889) — 距Top cushion 324mm
- 粉球点: (892, 889) — 蓝球点和Top cushion的中点
- 蓝球点: (1785, 889) — 台面正中心
- 棕球点: (2832, 889) — Baulk线中心
- 黄球点: (2832, 1181) — Baulk线右侧（D区边缘）
- 绿球点: (2832, 597) — Baulk线左侧（D区边缘）
- Baulk线: x=2832（距Baulk cushion 737mm）
- D区: 以(2832, 889)为圆心、半径292mm的半圆，朝Baulk cushion凸出

### 1.4 红球摆放（Section 3 Rule 2(a)(i)）
- 15颗红球摆成紧密的等边三角形
- 三角形顶点（apex）在中心纵线上，紧贴粉球上方（靠近粉球但不占据粉球点）
- 三角形底边平行于Top cushion

### 1.5 袋口位置（6个）
- 4个角袋：台面四角
- 2个中袋：在两条长边（侧库边）的中点

---

## 二、比赛流程（Section 3 Rule 3）

### 2.1 开球（Break）
- 开球时白球在D区内（in-hand）
- **开球第一杆必须先碰到红球**（Section 3 Rule 3(g)：红球是ball on）
- 红球或红球组成的三角形是开球时唯一合法的目标球

### 2.2 红球阶段（直到所有红球打完）
- 每次出杆的第一杆：红球是ball on（必须先碰红球）
- 如果进球红球：继续出杆，下一颗是彩球（球员自选黄/绿/棕/蓝/粉/黑）
- 如果进球彩球：彩球被放回原位（re-spot），然后继续出杆
- 如此红球和彩球交替进攻，直到所有红球打完

### 2.3 彩球阶段（所有红球打完后）
- 彩球必须按分值从低到高进球：黄(2)→绿(3)→棕(4)→蓝(5)→粉(6)→黑(7)
- 每次进球后继续出杆，进攻下一颗指定彩球
- 彩球阶段进球的彩球不再放回原位

### 2.4 一局结束（Section 3 Rule 4）
- 当黑球是台面上最后一颗目标球时，第一次进球或犯规结束该局
- 如果比分相同：黑球放回原位，重新开始

---

## 三、犯规和罚分（Section 3 Rule 11）

### 3.1 基本犯规（罚4分）
- 白球未碰到任何球（Rule 11(a)(vi)）
- 白球落袋（Rule 11(a)(vii)）
- 从D区外开球（Rule 11(a)(v)）
- 同时击打白球两次（Rule 11(a)(ii)）
- 双脚离地击球（Rule 11(a)(iii)）

### 3.2 高分犯规（罚分为ball on的值或以下更高者）
- 白球先碰了非ball on的球（Rule 11(b)(iv)）
  例：红球阶段开球先碰粉球 = 犯规，罚分=max(4, 粉球值6)=6分
- 进球了非ball on的球（Rule 11(b)(iii)）
- 击球时有球还在移动（Rule 11(b)(i)）
- 推杆（Rule 11(b)(v)）
- 造成球出台（Rule 11(b)(x)）

### 3.3 最高罚分（7分）
- 使用非白球作为主球（Rule 11(d)(iv)）
- 连续两杆都打红球（Rule 11(d)(iii)）
- 未声明目标球（Rule 11(d)(v)）

### 3.4 罚分规则
- 犯规罚分加到对手得分上
- 单次出杆多次犯规时，取最高罚分
- 罚分最低4分，最高7分

---

## 四、关键战术原则

### 4.1 防守（Safety）
- 当没有好的进球机会时，将白球藏到安全位置
- 让对手难以碰到ball on（制造snooker）
- 白球尽量远离对手的目标球

### 4.2 进攻（Attack）
- 有好的进球机会时果断进攻
- 注意白球走位（cue ball position），为下一杆做准备
- 优先进球高分彩球（黑球、粉球）

### 4.3 连续得分（Break building）
- 进球红球后选黑球（最高分），最大化单杆得分
- 注意白球走位，确保能继续进攻

---

## 五、输出格式（严格JSON，不要有任何多余文字）

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
- aimAngle是从白球位置指向目标球中心的方向角
- 计算公式: aimAngle = atan2(targetY - cueY, targetX - cueX)

力度说明:
- 0.2-0.4: 轻力（短距离进球、精准走位）
- 0.4-0.6: 中力（标准进球）
- 0.6-0.8: 中大力（长距离进球、开球）
- 0.8-1.0: 大力（开球、强力防守）

## 六、绝对禁止事项（违反即犯规）

1. **绝对不能用白球直接击打彩球作为第一目标（红球阶段）**
   - 红球阶段，白球必须先碰红球
   - 如果你先碰了粉球、蓝球等彩球，这是严重犯规（罚分=彩球值或4分，取高者）

2. **绝对不能用白球击打非指定彩球（彩球阶段）**
   - 彩球阶段必须按顺序：黄→绿→棕→蓝→粉→黑
   - 如果你先碰了错误的彩球，这是犯规

3. **targetBallId必须是白球要撞击的目标球的ID**
   - 不要选择白球本身作为目标
   - 不要选择已落袋的球作为目标
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
      // Red is ball on — must hit red first (WPBSA Section 3 Rule 3(g))
      return {
        description: '红球阶段：必须用白球先碰红球（不能先碰彩球，否则犯规）',
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

    // Validate target ball is actually a legal "ball on" per WPBSA rules
    const available = getAvailableTargets(state);
    if (!available.ballIds.includes(decision.targetBallId)) {
      console.warn(`LLM chose ball #${decision.targetBallId} (${targetBall.color}) which is not ball on. Legal targets: [${available.ballIds.join(',')}]. Falling back.`);
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

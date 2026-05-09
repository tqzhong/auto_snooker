// ============================================================
// LLM Decision Engine
// LLM decides strategy → physics engine calculates angle & power
// ============================================================

import type { GameState, LLMDecision, Ball, BallColor, Vec2, ShotRecord } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import {
  TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS,
  POCKET_POSITIONS, POCKET_RADII,
} from '../engine/constants';
import {
  distanceBetween, angleBetween, simulateShot, applyShot,
  createInitialBalls,
} from '../engine/physics';
import type { SimulationResult } from '../engine/physics';

// API config from environment
const API_KEY = import.meta.env.VITE_AI_API_KEY || '';
const BASE_URL = import.meta.env.VITE_AI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
const MODEL = import.meta.env.VITE_AI_MODEL || 'mimo-v2.5-pro';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================================
// LLM output: only strategy, not precise angles
// ============================================================

interface LLMStrategyChoice {
  targetBallId: number;
  power: number;
  strategy: 'attack' | 'safety' | 'snooker';
  reasoning: string;
}

// ============================================================
// Physics: calculate exact aim angle and power
// ============================================================

/** Find the pocket nearest to a ball */
function nearestPocket(ball: Ball): { pos: Vec2; radius: number; dist: number } {
  let best = { pos: { x: 0, y: 0 }, radius: 54, dist: Infinity };
  for (let i = 0; i < POCKET_POSITIONS.length; i++) {
    const px = POCKET_POSITIONS[i][0];
    const py = POCKET_POSITIONS[i][1];
    const dx = ball.pos.x - px;
    const dy = ball.pos.y - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < best.dist) {
      best = { pos: { x: px, y: py }, radius: POCKET_RADII[i], dist };
    }
  }
  return best;
}

/**
 * Calculate the aim angle to pot a target ball into a specific pocket.
 * Uses the "ghost ball" method:
 *   - Find where the cue ball must contact the target ball
 *     so that the target ball travels toward the pocket center.
 *   - The contact point is along the line from pocket to target,
 *     offset by one ball radius.
 *   - The cue ball aims at this contact point.
 */
function calculatePotAngle(
  cueBall: Ball,
  targetBall: Ball,
  pocketPos: Vec2,
): number {
  // Direction from target ball to pocket
  const tpx = pocketPos.x - targetBall.pos.x;
  const tpy = pocketPos.y - targetBall.pos.y;
  const tpLen = Math.sqrt(tpx * tpx + tpy * tpy);
  if (tpLen === 0) return angleBetween(cueBall.pos, targetBall.pos);

  // Unit vector from target to pocket
  const tnx = tpx / tpLen;
  const tny = tpy / tpLen;

  // Ghost ball position: one ball radius behind target ball (opposite pocket direction)
  const ghostX = targetBall.pos.x - tnx * BALL_RADIUS * 2;
  const ghostY = targetBall.pos.y - tny * BALL_RADIUS * 2;

  // Aim from cue ball to ghost ball
  return angleBetween(cueBall.pos, { x: ghostX, y: ghostY });
}

/**
 * Calculate required power to send the cue ball a given distance.
 * Based on: speed = sqrt(2 * friction * distance)
 * Returns power as a fraction of MAX_CUE_SPEED.
 */
function distanceToPower(dist: number): number {
  // From friction: v^2 = 2 * a * d, where a = FRICTION_DECELERATION = 450 mm/s^2
  // We want the cue ball to arrive with some remaining speed for ball transfer
  const FRICTION = 450;
  const MAX_SPEED = 5000;
  const requiredSpeed = Math.sqrt(2 * FRICTION * dist) * 1.3; // 1.3x margin
  return Math.max(0.15, Math.min(1.0, requiredSpeed / MAX_SPEED));
}

/**
 * Simulate a shot and check if the target ball ends up in a pocket.
 * Returns true if pot is successful.
 */
function simulateAndCheckPot(
  balls: Ball[],
  angle: number,
  power: number,
  targetBallId: number,
): { potted: boolean; simResult: SimulationResult } {
  // Deep copy
  const copy = balls.map(b => ({
    ...b,
    pos: { ...b.pos },
    vel: { ...b.vel },
  }));

  applyShot(copy, angle, power, 0, 0);
  const simResult = simulateShot(copy);

  const potted = simResult.pottedBalls.some(b => b.id === targetBallId);
  return { potted, simResult };
}

/**
 * For a given target ball, find the best pocket to aim for.
 * Uses LLM's preferred power, verifies via simulation.
 * Falls back to nearby power levels if LLM's power doesn't pot.
 */
function calculateBestShot(
  state: GameState,
  targetBall: Ball,
  preferredPower: number,
): { angle: number; power: number; pocketIndex: number } | null {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return null;

  // Get all 6 pockets, sorted by distance to target ball
  const pockets = POCKET_POSITIONS.map((pos, i) => ({
    pos: { x: pos[0], y: pos[1] },
    radius: POCKET_RADII[i],
    dist: distanceBetween(targetBall.pos, { x: pos[0], y: pos[1] }),
    index: i,
  })).sort((a, b) => a.dist - b.dist);

  // Try each pocket (nearest first), find one that works
  for (const pocket of pockets) {
    if (pocket.dist > TABLE_LENGTH * 0.8) continue;

    // Calculate ghost-ball aim angle
    const angle = calculatePotAngle(cueBall, targetBall, pocket.pos);

    // Try LLM's preferred power first, then fallback levels
    const powerLevels = [
      preferredPower,
      preferredPower * 0.8,
      preferredPower * 1.2,
      distanceToPower(distanceBetween(cueBall.pos, targetBall.pos)), // physics-calculated fallback
    ];

    for (const power of powerLevels) {
      const clamped = Math.max(0.15, Math.min(1.0, power));
      const { potted } = simulateAndCheckPot(state.balls, angle, clamped, targetBall.id);
      if (potted) {
        return { angle, power: clamped, pocketIndex: pocket.index };
      }
    }
  }

  return null; // No pot possible
}

/**
 * For safety shots: aim the cue ball to hit the target ball,
 * then send the cue ball to a safe position (far from the target).
 */
function calculateSafetyShot(
  state: GameState,
  targetBall: Ball,
): { angle: number; power: number } {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) return { angle: 0, power: 0.4 };

  // Aim at the target ball directly
  const angle = angleBetween(cueBall.pos, targetBall.pos);
  const dist = distanceBetween(cueBall.pos, targetBall.pos);

  // Medium power to make contact but leave cue ball safe
  const power = distanceToPower(dist) * 0.7;

  return { angle, power: Math.max(0.2, Math.min(0.7, power)) };
}

// ============================================================
// LLM: only decides strategy (which ball, attack/safety)
// ============================================================

function formatShotHistory(history: ShotRecord[], players: [string, string]): string {
  if (history.length === 0) return '暂无';
  const recent = history.slice(-5);
  return recent.map((s, i) => {
    const player = players[s.playerIndex];
    const result = s.result.pointsScored > 0
      ? `+${s.result.pointsScored}分`
      : s.result.fouls.length > 0
        ? `犯规(${s.result.fouls[0]?.description})`
        : '未进球';
    return `${i + 1}. ${player}: ${result}`;
  }).join(' | ');
}

function formatBallState(balls: Ball[]): string {
  const active = balls.filter(b => !b.pocketed);
  const reds = active.filter(b => b.color === 'red');
  const colors = active.filter(b => b.color !== 'red' && b.color !== 'white');
  const cue = active.find(b => b.color === 'white');

  let desc = '';
  desc += `白球(${cue ? `${Math.round(cue.pos.x)},${Math.round(cue.pos.y)}` : '袋中'})`;
  desc += `\n红球(${reds.length}): ${reds.map(b => `#${b.id}`).join(' ')}`;
  desc += `\n彩球: ${colors.map(b => `${b.color}#${b.id}`).join(' ')}`;
  return desc;
}

function buildSystemPrompt(): string {
  return `你是斯诺克AI教练。严格遵守WPBSA规则。

核心规则：
- 白球是唯一可击打的球
- 红球阶段：必须先碰红球。进球红球后选彩球进攻，彩球会放回原位
- 彩球阶段：按顺序黄→绿→棕→蓝→粉→黑进球
- 开球必须先碰红球
- 犯规罚分给对手（最低4分，最高7分）

你的职责是选择目标球、策略和力度。角度由物理引擎精确计算。
只输出JSON，不要有任何其他文字。

输出格式：
{
  "targetBallId": 目标球id,
  "power": 力度(0.1到1.0),
  "strategy": "attack"或"safety"或"snooker",
  "reasoning": "理由(15字内)"
}

力度指南：
- 0.2-0.3: 轻推（短距离精准走位）
- 0.4-0.5: 中力（标准进攻）
- 0.6-0.7: 中大力（长距离进攻、开球散堆）
- 0.8-1.0: 大力（强力开球、大力防守）
- 进攻时根据白球到目标球的距离选力度
- 防守时可以用较大力度让白球走到安全区域
- 开球时用0.7-0.9的力度散开红球堆

策略选择指南：
- attack: 有进球机会（目标球靠近袋口），进攻得分
- safety: 没有好机会，打到目标球后白球留在安全位置
- snooker: 故意让白球藏在非目标球后面，给对手制造困难

选球原则：
- 进攻时优先选靠近袋口的球
- 进球红球后优先选黑球（7分）或粉球（6分）
- 防守时选最远的球或能让白球回到安全区域的球
`;
}

function buildUserPrompt(state: GameState): string {
  const current = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];
  const available = getAvailableTargets(state);
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);

  // Build target info with pocket proximity
  let targetInfo = '';
  if (cueBall) {
    const targets = state.balls.filter(b =>
      available.ballIds.includes(b.id) && !b.pocketed
    );
    const targetDetails = targets.map(t => {
      const np = nearestPocket(t);
      const distToPocket = Math.round(np.dist);
      const distToCue = Math.round(distanceBetween(cueBall.pos, t.pos));
      return `#${t.id}(${t.color}) 距袋口${distToPocket}mm 距白球${distToCue}mm`;
    });
    targetInfo = targetDetails.join('\n');
  }

  // Calculate distances for power reference
  let distInfo = '';
  if (cueBall) {
    const targets = state.balls.filter(b => available.ballIds.includes(b.id) && !b.pocketed);
    distInfo = targets.map(t => {
      const dist = Math.round(distanceBetween(cueBall.pos, t.pos));
      return `#${t.id}(${t.color}) 距白球${dist}mm`;
    }).join(' | ');
  }

  return `你是${current.name}，得分${current.score}，对手${opponent.score}。
阶段: ${state.phase === 'break_off' ? '开球' : state.phase === 'reds_phase' ? '红球' : '彩球'}
台面: ${formatBallState(state.balls)}
合法目标: ${available.description}
各目标详情:
${targetInfo}
距离参考: ${distInfo}
历史: ${formatShotHistory(state.shotHistory, [state.players[0].name, state.players[1].name])}

请选目标球、力度和策略（严格JSON）：`;
}

function getAvailableTargets(state: GameState): { description: string; ballIds: number[] } {
  const redsOnTable = state.balls.filter(b => b.color === 'red' && !b.pocketed);

  if (state.phase === 'break_off' || state.phase === 'reds_phase') {
    if (redsOnTable.length > 0) {
      const lastShot = state.shotHistory[state.shotHistory.length - 1];
      if (lastShot && lastShot.result.pottedBalls.some(b => b.color === 'red')) {
        const colors = state.balls.filter(b => COLORS_ORDER.includes(b.color as BallColor) && !b.pocketed);
        return {
          description: '必须先碰彩球',
          ballIds: colors.map(b => b.id),
        };
      }
      return {
        description: '必须先碰红球',
        ballIds: redsOnTable.map(b => b.id),
      };
    }
  }

  if (state.phase === 'colors_phase' && state.nextColorToPot) {
    const target = state.balls.find(b => b.color === state.nextColorToPot && !b.pocketed);
    if (target) {
      return {
        description: `必须先碰${state.nextColorToPot}`,
        ballIds: [target.id],
      };
    }
  }

  return { description: '红球', ballIds: redsOnTable.map(b => b.id) };
}

// ============================================================
// Main decision function: LLM picks target → physics calculates shot
// ============================================================

export async function getAIMoveDecision(state: GameState): Promise<LLMDecision> {
  // Step 1: Get strategy from LLM (or fallback)
  const strategy = await getLLMStrategy(state);

  // Step 2: Find the target ball
  const targetBall = state.balls.find(b => b.id === strategy.targetBallId && !b.pocketed);
  if (!targetBall) {
    return getFallbackDecision(state);
  }

  // Step 3: Calculate precise angle via physics, use LLM's power
  if (strategy.strategy === 'attack') {
    const shot = calculateBestShot(state, targetBall, strategy.power);
    if (shot) {
      return {
        targetBallId: strategy.targetBallId,
        aimAngle: shot.angle,
        power: shot.power,
        spinX: 0,
        spinY: -0.05,
        strategy: 'attack',
        reasoning: strategy.reasoning + ` → 袋口${shot.pocketIndex}`,
      };
    }
    // No pot possible → use LLM's power with direct aim for safety
    const angle = angleBetween(
      state.balls.find(b => b.color === 'white')!.pos,
      targetBall.pos,
    );
    return {
      targetBallId: strategy.targetBallId,
      aimAngle: angle,
      power: Math.max(0.3, strategy.power * 0.8),
      spinX: 0,
      spinY: 0,
      strategy: 'safety',
      reasoning: '无法进球，转防守',
    };
  }

  // Safety or snooker: aim directly at target with LLM's power
  const cueBall = state.balls.find(b => b.color === 'white')!;
  const angle = angleBetween(cueBall.pos, targetBall.pos);
  return {
    targetBallId: strategy.targetBallId,
    aimAngle: angle,
    power: strategy.power,
    spinX: 0,
    spinY: 0,
    strategy: strategy.strategy,
    reasoning: strategy.reasoning,
  };
}

/** Get LLM strategy choice only (no angle/power) */
async function getLLMStrategy(state: GameState): Promise<LLMStrategyChoice> {
  if (!API_KEY) {
    return getFallbackStrategy(state);
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
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      console.error('LLM API error:', response.status);
      return getFallbackStrategy(state);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse LLM JSON:', content);
      return getFallbackStrategy(state);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (typeof parsed.targetBallId !== 'number') {
      return getFallbackStrategy(state);
    }

    // Validate target is legal
    const available = getAvailableTargets(state);
    if (!available.ballIds.includes(parsed.targetBallId)) {
      console.warn(`LLM chose illegal target #${parsed.targetBallId}, using fallback`);
      return getFallbackStrategy(state);
    }

    return {
      targetBallId: Math.round(parsed.targetBallId),
      power: typeof parsed.power === 'number' ? Math.max(0.15, Math.min(1.0, parsed.power)) : 0.5,
      strategy: parsed.strategy === 'safety' || parsed.strategy === 'snooker'
        ? parsed.strategy : 'attack',
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    console.error('LLM call failed:', err);
    return getFallbackStrategy(state);
  }
}

function getFallbackStrategy(state: GameState): LLMStrategyChoice {
  const available = getAvailableTargets(state);
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  if (!cueBall) {
    return { targetBallId: available.ballIds[0] || 0, power: 0.5, strategy: 'attack', reasoning: '' };
  }

  const targets = state.balls.filter(b =>
    available.ballIds.includes(b.id) && !b.pocketed
  );

  if (targets.length === 0) {
    return { targetBallId: available.ballIds[0] || 0, power: 0.4, strategy: 'safety', reasoning: '无目标' };
  }

  // Pick the target closest to any pocket (best pot chance)
  let bestTarget = targets[0];
  let bestPocketDist = Infinity;
  for (const t of targets) {
    const np = nearestPocket(t);
    if (np.dist < bestPocketDist) {
      bestPocketDist = np.dist;
      bestTarget = t;
    }
  }

  // If close to pocket, attack; otherwise safety
  const nearPocket = bestPocketDist < 300;
  const dist = distanceBetween(cueBall.pos, bestTarget.pos);
  return {
    targetBallId: bestTarget.id,
    power: nearPocket ? 0.45 : 0.55,
    strategy: nearPocket ? 'attack' : 'safety',
    reasoning: nearPocket ? `${bestTarget.color}近袋` : '防守',
  };
}

/** Fallback full decision (used when physics calc fails) */
export function getFallbackDecision(state: GameState): LLMDecision {
  const strategy = getFallbackStrategy(state);
  const targetBall = state.balls.find(b => b.id === strategy.targetBallId && !b.pocketed);

  if (targetBall && strategy.strategy === 'attack') {
    const shot = calculateBestShot(state, targetBall, strategy.power);
    if (shot) {
      return {
        targetBallId: strategy.targetBallId,
        aimAngle: shot.angle,
        power: shot.power,
        spinX: 0,
        spinY: 0,
        strategy: 'attack',
        reasoning: strategy.reasoning,
      };
    }
  }

  if (targetBall) {
    const safety = calculateSafetyShot(state, targetBall);
    return {
      targetBallId: strategy.targetBallId,
      aimAngle: safety.angle,
      power: strategy.power,
      spinX: 0,
      spinY: 0,
      strategy: 'safety',
      reasoning: strategy.reasoning,
    };
  }

  return {
    targetBallId: 0, aimAngle: 0, power: 0.4, spinX: 0, spinY: 0,
    strategy: 'safety', reasoning: '无目标',
  };
}

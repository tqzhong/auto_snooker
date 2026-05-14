// ============================================================
// LLM Macro Strategist
// LLM gives high-level intent only; physics still owns shot execution.
// ============================================================

import type { Ball, BallColor, GameState } from '../types';
import { BALL_VALUES, COLORS_ORDER } from '../types';
import { getAvailableTargets, getLegalTargetBalls, getPotLineCount } from './strategy';
import type { MacroStrategyAdvice } from './positional';
import { maxPointsRemaining } from '../engine/rules';
import { distanceBetween } from '../engine/physics';

const ENV = import.meta.env || {};
const API_KEY = ENV.VITE_AI_API_KEY || '';
const BASE_URL = ENV.VITE_AI_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
const MODEL = ENV.VITE_AI_MODEL || 'mimo-v2.5-pro';

type ChatContent =
  | string
  | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

function parseJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeIntent(value: unknown): MacroStrategyAdvice['intent'] {
  if (typeof value !== 'string') return 'attack_safe';
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('snooker') || normalized.includes('斯诺克')) return 'snooker';
  if (normalized.includes('safe') || normalized.includes('防守')) return 'safety';
  if (normalized.includes('contain') || normalized.includes('控制')) return 'contain';
  if (normalized.includes('escape') || normalized.includes('解')) return 'escape';
  if (normalized.includes('continue') || normalized.includes('break') || normalized.includes('连续')) return 'attack_continue';
  return 'attack_safe';
}

function normalizeColor(value: unknown): BallColor | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim().toLowerCase();
  return COLORS_ORDER.includes(color as BallColor) || color === 'red'
    ? color as BallColor
    : undefined;
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function formatBall(ball: Ball): string {
  return `${ball.color}#${ball.id}@(${Math.round(ball.pos.x)},${Math.round(ball.pos.y)})`;
}

function buildCandidateContext(state: GameState): string {
  const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
  const legalTargets = getLegalTargetBalls(state);
  if (!cueBall) return 'No cue ball found.';

  return legalTargets
    .map(target => {
      const potLines = getPotLineCount(state, target);
      const dist = Math.round(distanceBetween(cueBall.pos, target.pos));
      const value = BALL_VALUES[target.color as BallColor] ?? 0;
      return `${formatBall(target)} value=${value} cueDistance=${dist}mm potLines=${potLines}`;
    })
    .join('\n');
}

function buildSystemPrompt(): string {
  return `You are a professional snooker coach making high-level tactical decisions.
Return exactly one JSON object and no markdown.

You DO NOT choose exact angle, power, or spin. The local physics engine will do that.

JSON schema:
{
  "intent": "attack_continue | attack_safe | safety | snooker | escape | contain",
  "riskTolerance": 0.0,
  "positionPriority": 0.0,
  "preferredColor": "black",
  "avoidHighDifficulty": true,
  "reasoning": "short Chinese explanation"
}

Rules and tactical principles:
- In red phase, pot red then select a color; high breaks normally require position on black/pink/blue.
- In color-after-red phase, prefer black/pink when naturally available, but do not force a very hard pot.
- Avoid speculative long pots, thin cuts, cushion-bound shots, and heavy side unless score context requires risk.
- Top players choose the shot that leaves a simple next shot, not merely the shot with the highest immediate value.
- If no reliable pot exists, choose safety or snooker: leave distance, block direct lines, or return cue ball to baulk.
- If leading, lower risk. If trailing with few points left, raise risk.
- High-level intent only: exact shot execution is handled by verified physics simulation.`;
}

function buildUserText(state: GameState): string {
  const current = state.players[state.currentPlayerIndex];
  const opponent = state.players[1 - state.currentPlayerIndex];
  const available = getAvailableTargets(state);
  const scoreDiff = current.score - opponent.score;
  const remaining = maxPointsRemaining(state.balls, state.phase);
  const active = state.balls.filter(b => !b.pocketed);
  const reds = active.filter(b => b.color === 'red').length;
  const colors = active.filter(b => COLORS_ORDER.includes(b.color as BallColor)).map(formatBall).join(', ');

  return `Current player: ${current.name}
Score: ${current.score}-${opponent.score} (diff ${scoreDiff}), points remaining ${remaining}
Phase: ${state.phase}, reds remaining ${reds}, nextColorToPot ${state.nextColorToPot ?? 'none'}
Legal target rule: ${available.description}
Colors: ${colors}
Legal target summary:
${buildCandidateContext(state)}

Return JSON only. Use the image, if provided, as a table-layout reference.`;
}

export async function getLLMMacroAdvice(
  state: GameState,
  tableImageDataUrl?: string | null,
): Promise<MacroStrategyAdvice | null> {
  if (!API_KEY) return null;

  const userText = buildUserText(state);
  const content: ChatContent = tableImageDataUrl
    ? [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: tableImageDataUrl } },
    ]
    : userText;

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content },
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
        temperature: 0.25,
        max_tokens: 500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.warn('LLM macro strategy API error:', response.status);
      return null;
    }

    const data = await response.json();
    const contentText = data.choices?.[0]?.message?.content || '';
    const parsed = parseJson(contentText);
    if (!parsed) return null;

    return {
      intent: normalizeIntent(parsed.intent),
      riskTolerance: clamp01(parsed.riskTolerance, 0.45),
      positionPriority: clamp01(parsed.positionPriority, 0.65),
      preferredColor: normalizeColor(parsed.preferredColor),
      avoidHighDifficulty: typeof parsed.avoidHighDifficulty === 'boolean'
        ? parsed.avoidHighDifficulty
        : true,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 160) : '',
    };
  } catch (err) {
    console.warn('LLM macro strategy failed:', err);
    return null;
  }
}

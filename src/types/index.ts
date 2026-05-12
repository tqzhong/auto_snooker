// ============================================================
// Snooker Game Types
// ============================================================

export interface Vec2 {
  x: number;
  y: number;
}

export type BallColor = 'red' | 'yellow' | 'green' | 'brown' | 'blue' | 'pink' | 'black' | 'white';

export interface Ball {
  id: number;
  color: BallColor;
  pos: Vec2;
  vel: Vec2;
  /** Horizontal cue spin / side in [-1, 1]. Positive means right side from shot direction. */
  spinX?: number;
  /** Vertical cue spin in [-1, 1]. Positive means top/follow, negative means back/draw. */
  spinY?: number;
  radius: number;
  pocketed: boolean;
  /** True for reds that have already been potted and re-spotted (none in standard rules) */
  active: boolean;
}

export interface Table {
  /** Play area width in mm (inner cushion to cushion) */
  width: number;
  /** Play area height in mm */
  height: number;
  /** Pocket radius in mm */
  pocketRadius: number;
  /** Pocket positions (center of each pocket opening) */
  pockets: Vec2[];
  /** Cushion thickness for rendering */
  cushionWidth: number;
}

export interface ShotParams {
  /** Aim direction in radians (0 = right, PI/2 = down) */
  angle: number;
  /** Power 0-1 (fraction of max cue speed) */
  power: number;
  /** Spin: -1 to 1 horizontal (left/right side), -1 to 1 vertical (back/top spin) */
  spinX: number;
  spinY: number;
  /** Target ball id the LLM is aiming at */
  targetBallId: number;
}

export interface ShotResult {
  /** Balls potted in this shot */
  pottedBalls: Ball[];
  /** Fouls committed */
  fouls: Foul[];
  /** Points scored (excluding fouls) */
  pointsScored: number;
  /** Was the cue ball potted? */
  cueBallPotted: boolean;
  /** First ball contacted by the cue ball */
  firstContactBallId: number | null;
}

export type FoulType =
  | 'cue_ball_potted'
  | 'wrong_ball_first_contact'
  | 'no_ball_contact'
  | 'no_cushion_after_contact'
  | 'hit_off_table'
  | 'miss'
  | 'touching_ball_violation'
  | 'break_requirements';

export interface Foul {
  type: FoulType;
  points: number;
  description: string;
}

export type GamePhase =
  | 'break_off'       // Opening shot
  | 'reds_phase'      // Must pot reds
  | 'color_after_red' // Must nominate a color after potting a red
  | 'colors_phase'    // All reds gone, must pot colors in order
  | 'game_over';

export interface Player {
  name: string;
  score: number;
  currentBreak: number;
  highestBreak: number;
}

export interface ShotRecord {
  playerIndex: number;
  shotParams: ShotParams;
  result: ShotResult;
  ballPositionsBefore: { id: number; pos: Vec2 }[];
  timestamp: number;
  llmReasoning: string;
}

export interface GameState {
  players: [Player, Player];
  currentPlayerIndex: number;
  balls: Ball[];
  phase: GamePhase;
  redsRemaining: number;
  nextColorToPot: BallColor | null;
  consecutiveFouls: number;
  freeBall: boolean;
  /** When free ball is active, which color the player nominated as the ball-on */
  freeBallNominee: BallColor | null;
  /** Consecutive miss count for the miss rule (max 4 before frame loss) */
  missCount: number;
  /** Cue ball position before the last foul (for miss rule replay) */
  lastFoulPosition: Vec2 | null;
  /** Ball IDs currently touching the cue ball at rest */
  touchingBalls: number[];
  /** Consecutive safety exchanges (no pot, no foul) for stalemate detection */
  stalemateCount: number;
  /** Number of balls that hit the cushion after first contact in break-off */
  breakCushionHits: number;
  shotHistory: ShotRecord[];
  frameNumber: number;
  frameScores: [number, number][];
  /** Is a shot currently being simulated? */
  simulating: boolean;
  /** Current status message */
  statusMessage: string;
}

/** Color ball values per international snooker rules */
export const BALL_VALUES: Record<BallColor, number> = {
  red: 1,
  yellow: 2,
  green: 3,
  brown: 4,
  blue: 5,
  pink: 6,
  black: 7,
  white: 0, // cue ball
};

/** Order for re-spotting and final colors phase */
export const COLORS_ORDER: BallColor[] = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];

/** Minimum foul points */
export const MIN_FOUL_POINTS = 4;
export const MAX_FOUL_POINTS = 7;

export interface LLMDecision {
  targetBallId: number;
  aimAngle: number;
  power: number;
  /** Horizontal cue strike: -1 left side, 0 centre, 1 right side. */
  spinX: number;
  /** Vertical cue strike: -1 back/draw, 0 stun, 1 top/follow. */
  spinY: number;
  strategy: 'attack' | 'safety' | 'snooker';
  reasoning: string;
}

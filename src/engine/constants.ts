// ============================================================
// Snooker Table Constants (all values in mm)
// Based on World Snooker / IBSF regulations
// ============================================================

/** Full-size table: 12ft x 6ft (play area) */
export const TABLE_WIDTH = 3569;
export const TABLE_HEIGHT = 1778;

/** Ball radius: 26.25mm (52.5mm diameter) */
export const BALL_RADIUS = 26.25;

/** Pocket opening radius: ~54mm (corner), ~60mm (middle of top/bottom) */
export const CORNER_POCKET_RADIUS = 54;
export const MIDDLE_POCKET_RADIUS = 60;

/** Cushion width for rendering (visual only) */
export const CUSHION_WIDTH = 40;

/** Rail baulk line distance from bottom cushion: 737mm (29 inches) */
export const BAULK_LINE_Y = TABLE_HEIGHT - 737;

/** D-zone radius: 292mm (11.5 inches) from baulk line center */
export const D_ZONE_RADIUS = 292;

/** Center of baulk line (D-zone center) */
export const BAULK_CENTER_X = TABLE_WIDTH / 2;

/** Blue spot: center of table */
export const BLUE_SPOT: [number, number] = [TABLE_WIDTH / 2, TABLE_HEIGHT / 2];

/** Pink spot: 1270mm from top cushion */
export const PINK_SPOT: [number, number] = [TABLE_WIDTH / 2, 1270];

/** Black spot: 324mm from top cushion */
export const BLACK_SPOT: [number, number] = [TABLE_WIDTH / 2, 324];

/** Brown spot: on baulk line, center */
export const BROWN_SPOT: [number, number] = [BAULK_CENTER_X, BAULK_LINE_Y];

/** Yellow spot: on baulk line, right quarter */
export const YELLOW_SPOT: [number, number] = [BAULK_CENTER_X + D_ZONE_RADIUS, BAULK_LINE_Y];

/** Green spot: on baulk line, left quarter */
export const GREEN_SPOT: [number, number] = [BAULK_CENTER_X - D_ZONE_RADIUS, BAULK_LINE_Y];

/** Resting position for cue ball on break-off: on baulk line in D-zone */
export const CUE_BALL_BREAK_POS: [number, number] = [BAULK_CENTER_X + D_ZONE_RADIUS * 0.4, BAULK_LINE_Y];

/** Pocket positions (6 pockets) */
export const POCKET_POSITIONS: [number, number][] = [
  // Top-left corner
  [CORNER_POCKET_RADIUS * 0.4, CORNER_POCKET_RADIUS * 0.4],
  // Top-middle
  [TABLE_WIDTH / 2, 0],
  // Top-right corner
  [TABLE_WIDTH - CORNER_POCKET_RADIUS * 0.4, CORNER_POCKET_RADIUS * 0.4],
  // Bottom-left corner
  [CORNER_POCKET_RADIUS * 0.4, TABLE_HEIGHT - CORNER_POCKET_RADIUS * 0.4],
  // Bottom-middle
  [TABLE_WIDTH / 2, TABLE_HEIGHT],
  // Bottom-right corner
  [TABLE_WIDTH - CORNER_POCKET_RADIUS * 0.4, TABLE_HEIGHT - CORNER_POCKET_RADIUS * 0.4],
];

/** Pocket radii (corners are slightly smaller than middles) */
export const POCKET_RADII: number[] = [
  CORNER_POCKET_RADIUS,
  MIDDLE_POCKET_RADIUS,
  CORNER_POCKET_RADIUS,
  CORNER_POCKET_RADIUS,
  MIDDLE_POCKET_RADIUS,
  CORNER_POCKET_RADIUS,
];

/** Physics constants */
export const FRICTION_DECELERATION = 450; // mm/s^2 - rolling friction on baize
export const CUSHION_RESTITUTION = 0.75; // Coefficient of restitution for cushion bounce
export const BALL_RESTITUTION = 0.95; // Coefficient of restitution for ball-ball collision
export const SPIN_FRICTION_FACTOR = 0.3; // How much spin affects trajectory after contact
export const MAX_CUE_SPEED = 5000; // mm/s at maximum power
export const POCKET_PULL_RADIUS_FACTOR = 1.6; // Pocket "sucks in" ball if within this factor of pocket radius

/** Simulation */
export const PHYSICS_TIMESTEP = 1 / 240; // seconds per physics step
export const MAX_SIMULATION_TIME = 30; // seconds - stop if balls haven't settled

/** Scoring */
export const MIN_FOUL = 4;
export const MAX_FOUL = 7;

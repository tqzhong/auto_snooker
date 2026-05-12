// ============================================================
// Snooker Table Constants (all values in mm)
// Based on WPBSA Official Rules 2024-25
//
// COORDINATE SYSTEM (rotated 90° CW from standard portrait):
//   x-axis = LONG axis (12ft 8½in = 3569mm), left to right
//   y-axis = SHORT axis (5ft 10in = 1778mm), top to bottom
//
//   x=0 = Top cushion (black ball end)
//   x=3569 = Bottom / Baulk cushion
//   y=0 = Left side cushion
//   y=1778 = Right side cushion
//
// Canvas renders landscape: width maps to x, height maps to y
// ============================================================

/** Full-size table: 11ft 8½in x 5ft 10in (play area) */
export const TABLE_LENGTH = 3569; // long axis (x)
export const TABLE_WIDTH = 1778;  // short axis (y)

// Backward-compat alias for renderer
export const TABLE_HEIGHT = TABLE_WIDTH;

/** Ball radius: 26.25mm (52.5mm diameter) */
export const BALL_RADIUS = 26.25;

/** Pocket opening radius: ~54mm (corner), ~60mm (middle of long cushions) */
export const CORNER_POCKET_RADIUS = 54;
export const MIDDLE_POCKET_RADIUS = 60;

/** Cushion width for rendering (visual only) */
export const CUSHION_WIDTH = 40;

// ============================================================
// SPOT POSITIONS — per WPBSA rules Section 1(f)
//
// All spots lie on the centre longitudinal line (y = CENTER_Y).
// Distances measured from the face of the Top Cushion (x=0).
//
// Black Spot:  12¾ in (324 mm) from Top Cushion
// Pink Spot:   midway between Blue Spot and Top Cushion face
//              = (1784.5 + 0) / 2 = 892.25 mm
// Blue Spot:   midway between Top and Bottom Cushions
//              = 3569 / 2 = 1784.5 mm
// Brown Spot:  middle of the Baulk-line
//              = 3569 - 737 = 2832 mm
// Yellow Spot: right corner of D (viewed from Baulk end)
//              = on Baulk-line, y = CENTER_Y - 292
// Green Spot:  left corner of D (viewed from Baulk end)
//              = on Baulk-line, y = CENTER_Y + 292
// ============================================================

export const BLACK_SPOT_X = 324;
export const PINK_SPOT_X = 892.25; // midway between blue (1784.5) and top (0)
export const BLUE_SPOT_X = TABLE_LENGTH / 2; // 1784.5

/** Baulk line: 737mm (29 in) from the Baulk Cushion */
export const BAULK_LINE_X = TABLE_LENGTH - 737; // 2832

/** Centre of the short axis */
export const CENTER_Y = TABLE_WIDTH / 2; // 889

/** D-zone radius: 292mm (11½ in) */
export const D_ZONE_RADIUS = 292;

/** Named spot positions as [x, y] */
export const BLACK_SPOT: [number, number] = [BLACK_SPOT_X, CENTER_Y];
export const PINK_SPOT: [number, number] = [PINK_SPOT_X, CENTER_Y];
export const BLUE_SPOT: [number, number] = [BLUE_SPOT_X, CENTER_Y];
export const BROWN_SPOT: [number, number] = [BAULK_LINE_X, CENTER_Y];
export const YELLOW_SPOT: [number, number] = [BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS];
export const GREEN_SPOT: [number, number] = [BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS];

/** Cue ball break-off: inside D-zone, slightly right of center (viewed from baulk) */
export const CUE_BALL_BREAK_POS: [number, number] = [BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS * 0.4];

// ============================================================
// POCKETS — 6 pockets
//   4 corners at the four corners of the table
//   2 middles at the centre of each LONG cushion (side cushions)
// ============================================================

export const POCKET_POSITIONS: [number, number][] = [
  // Top-left corner (Top cushion + Left side cushion)
  [CORNER_POCKET_RADIUS * 0.4, CORNER_POCKET_RADIUS * 0.4],
  // Left-middle (centre of Left side cushion, long edge)
  [TABLE_LENGTH / 2, 0],
  // Top-right corner (Top cushion + Right side cushion)
  [CORNER_POCKET_RADIUS * 0.4, TABLE_WIDTH - CORNER_POCKET_RADIUS * 0.4],
  // Bottom-left corner (Baulk cushion + Left side cushion)
  [TABLE_LENGTH - CORNER_POCKET_RADIUS * 0.4, CORNER_POCKET_RADIUS * 0.4],
  // Right-middle (centre of Right side cushion, long edge)
  [TABLE_LENGTH / 2, TABLE_WIDTH],
  // Bottom-right corner (Baulk cushion + Right side cushion)
  [TABLE_LENGTH - CORNER_POCKET_RADIUS * 0.4, TABLE_WIDTH - CORNER_POCKET_RADIUS * 0.4],
];

export const POCKET_RADII: number[] = [
  CORNER_POCKET_RADIUS,
  MIDDLE_POCKET_RADIUS,
  CORNER_POCKET_RADIUS,
  CORNER_POCKET_RADIUS,
  MIDDLE_POCKET_RADIUS,
  CORNER_POCKET_RADIUS,
];

/** Physics constants */
export const FRICTION_DECELERATION = 450; // mm/s^2
export const CUSHION_RESTITUTION = 0.75;
export const BALL_RESTITUTION = 0.95;
export const SPIN_FRICTION_FACTOR = 0.3;
export const MAX_CUE_SPEED = 5000; // mm/s
export const POCKET_PULL_RADIUS_FACTOR = 1.6;

/** Simulation */
export const PHYSICS_TIMESTEP = 1 / 240; // seconds
export const MAX_SIMULATION_TIME = 30; // seconds

/** Scoring */
export const MIN_FOUL = 4;
export const MAX_FOUL = 7;

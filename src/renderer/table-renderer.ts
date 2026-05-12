// ============================================================
// 2D Snooker Table Renderer (Canvas)
// Top-down view, landscape orientation
// x-axis = long axis (left to right), y-axis = short axis (top to bottom)
// x=0 is Top cushion (black ball end), x=3569 is Baulk cushion
// ============================================================

import type { Ball, BallColor, Vec2 } from '../types';
import {
  TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS,
  BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS,
} from '../engine/constants';

// Scale: pixels per mm. Target ~950px canvas width for the 3569mm table
const SCALE = 0.26;

// Geometry copied from Snooker_table_drawing_2.svg. The SVG is drawn in
// ball-radius units, so multiplying by BALL_RADIUS maps it 1:1 to millimetres.
const SVG_UNIT_MM = BALL_RADIUS;
const SVG_OUTER_X = -37.867;
const SVG_OUTER_Y = -4;
const SVG_OUTER_WIDTH = 75.733;
const SVG_OUTER_HEIGHT = 143.962;
const TABLE_OFFSET_MM = 4 * SVG_UNIT_MM;

type SvgPoint = [number, number];
type SvgTransform = (point: SvgPoint) => SvgPoint;

const BALL_COLORS: Record<BallColor, string> = {
  white: '#FFFFFF',
  red: '#CC0000',
  yellow: '#FFD700',
  green: '#228B22',
  brown: '#8B4513',
  blue: '#1E90FF',
  pink: '#FF69B4',
  black: '#1A1A1A',
};

const BALL_STROKE_COLORS: Record<BallColor, string> = {
  white: '#CCCCCC',
  red: '#880000',
  yellow: '#B89600',
  green: '#155015',
  brown: '#5C2E0A',
  blue: '#0A5090',
  pink: '#CC3388',
  black: '#000000',
};

function toPixel(mm: number): number {
  return mm * SCALE;
}

export interface RenderState {
  balls: Ball[];
  currentPlayerName: string;
  aimLine?: { from: Vec2; to: Vec2 };
  powerIndicator?: number;
}

export class TableRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot get 2D context');
    this.ctx = ctx;

    this.width = toPixel(SVG_OUTER_HEIGHT * SVG_UNIT_MM);
    this.height = toPixel(SVG_OUTER_WIDTH * SVG_UNIT_MM);

    canvas.width = this.width;
    canvas.height = this.height;
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const pad = toPixel(TABLE_OFFSET_MM);

    ctx.clearRect(0, 0, this.width, this.height);

    this.drawTableBody();

    // Draw markings
    this.drawMarkings();

    // Draw pockets
    this.drawPockets();

    // Aim line
    if (state.aimLine) {
      this.drawAimLine(state.aimLine, pad);
    }

    // Balls
    this.drawBalls(state.balls, pad);
  }

  private drawTableBody(): void {
    const ctx = this.ctx;

    ctx.fillStyle = '#4A2106';
    this.drawSvgRoundedRect(-37.867, -4, 75.733, 143.962, 4);

    ctx.fillStyle = 'darkgreen';
    this.drawSvgRect(-35.667, -1.8, 71.333, 139.562);

    ctx.fillStyle = 'forestgreen';
    this.drawSvgRect(-33.867, 0, 67.733, 135.962);
  }

  private drawMarkings(): void {
    const ctx = this.ctx;
    const pad = toPixel(TABLE_OFFSET_MM);

    // Baulk line (vertical line parallel to top cushion, 737mm from baulk end)
    const baulkPx = pad + toPixel(BAULK_LINE_X);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(baulkPx, pad);
    ctx.lineTo(baulkPx, pad + toPixel(TABLE_WIDTH));
    ctx.stroke();

    // D-zone (semi-circle on baulk line)
    // Curved part extends INTO baulk (to the right, toward baulk cushion)
    // Straight edge is on the baulk line itself
    const centerPx = pad + toPixel(CENTER_Y);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(baulkPx, centerPx, toPixel(D_ZONE_RADIUS), -Math.PI / 2, Math.PI / 2, false);
    ctx.stroke();

    // Spot markers
    const spots: [number, number][] = [
      [324, CENTER_Y],             // Black
      [892.25, CENTER_Y],          // Pink
      [TABLE_LENGTH / 2, CENTER_Y], // Blue
      [BAULK_LINE_X, CENTER_Y],   // Brown
      [BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS], // Yellow (right from baulk)
      [BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS], // Green  (left from baulk)
    ];

    for (const [x, y] of spots) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(pad + toPixel(x), pad + toPixel(y), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPockets(): void {
    const ctx = this.ctx;

    const cornerTransforms: SvgTransform[] = [
      point => point,
      ([x, y]) => [-x, 135.962 - y],
      ([x, y]) => [y - 33.867, 102.095 - x],
      ([x, y]) => [33.867 - y, x + 33.867],
    ];

    for (const transform of cornerTransforms) {
      ctx.fillStyle = 'forestgreen';
      this.drawSvgPolygon([
        [-33.867, 3],
        [-30.867, 0],
        [-33.867, -2],
        [-35.867, 0],
      ], transform);

      ctx.fillStyle = 'gold';
      this.drawSvgPolygon([
        [-33.867, 0],
        [-33.867, -4],
        [-35.867, -4],
        [-35.867, -2],
        [-37.867, -2],
        [-37.867, -4],
        [-37.867, 0],
      ], transform);

      this.drawSvgPolygon([
        [-37.867, -4],
        [-33.867, -4],
        [-33.867, 0],
        [-37.867, 0],
      ], transform);

      ctx.fillStyle = '#050505';
      this.drawSvgCircle(-34.567, -0.7, 1.55, transform);
    }

    ctx.fillStyle = 'gold';
    this.drawSvgPolygon([
      [-37.867, 66.081],
      [-37.867, 69.881],
      [-34.067, 69.881],
      [-34.067, 66.081],
    ]);
    this.drawSvgPolygon([
      [37.867, 66.081],
      [37.867, 69.881],
      [34.067, 69.881],
      [34.067, 66.081],
    ]);

    ctx.fillStyle = 'forestgreen';
    this.drawSvgPolygon([
      [-32.867, 63.981],
      [-32.867, 71.981],
      [-35.667, 69.481],
      [-35.667, 66.481],
    ]);
    this.drawSvgPolygon([
      [32.867, 63.981],
      [32.867, 71.981],
      [35.667, 69.481],
      [35.667, 66.481],
    ]);

    ctx.fillStyle = '#050505';
    this.drawSvgCircle(-35.567, 67.981, 1.55);
    this.drawSvgCircle(35.567, 67.981, 1.55);
  }

  private drawBalls(balls: Ball[], pad: number): void {
    const ctx = this.ctx;

    const sorted = [...balls].filter(b => !b.pocketed).sort((a, b) => {
      if (a.color === 'white') return 1;
      if (b.color === 'white') return -1;
      return 0;
    });

    for (const ball of sorted) {
      const x = pad + toPixel(ball.pos.x);
      const y = pad + toPixel(ball.pos.y);
      const r = toPixel(ball.radius);

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.arc(x + 2, y + 2, r, 0, Math.PI * 2);
      ctx.fill();

      // Ball body gradient
      const gradient = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      const color = BALL_COLORS[ball.color];
      gradient.addColorStop(0, lightenColor(color, 40));
      gradient.addColorStop(0.7, color);
      gradient.addColorStop(1, darkenColor(color, 30));

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // Highlight
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.35, 0, Math.PI * 2);
      ctx.fill();

      // Edge stroke
      ctx.strokeStyle = BALL_STROKE_COLORS[ball.color];
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();

      // Red balls: clean, no number label

      // White dot on color balls
      if (ball.color !== 'red' && ball.color !== 'white') {
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private svgToCanvas([x, y]: SvgPoint): SvgPoint {
    return [
      toPixel((y - SVG_OUTER_Y) * SVG_UNIT_MM),
      toPixel((x - SVG_OUTER_X) * SVG_UNIT_MM),
    ];
  }

  private drawSvgRect(x: number, y: number, width: number, height: number): void {
    const ctx = this.ctx;
    const [canvasX, canvasY] = this.svgToCanvas([x, y]);
    ctx.fillRect(canvasX, canvasY, toPixel(height * SVG_UNIT_MM), toPixel(width * SVG_UNIT_MM));
  }

  private drawSvgRoundedRect(
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    const ctx = this.ctx;
    const [canvasX, canvasY] = this.svgToCanvas([x, y]);
    const canvasWidth = toPixel(height * SVG_UNIT_MM);
    const canvasHeight = toPixel(width * SVG_UNIT_MM);
    const canvasRadius = toPixel(radius * SVG_UNIT_MM);

    ctx.beginPath();
    ctx.moveTo(canvasX + canvasRadius, canvasY);
    ctx.lineTo(canvasX + canvasWidth - canvasRadius, canvasY);
    ctx.quadraticCurveTo(canvasX + canvasWidth, canvasY, canvasX + canvasWidth, canvasY + canvasRadius);
    ctx.lineTo(canvasX + canvasWidth, canvasY + canvasHeight - canvasRadius);
    ctx.quadraticCurveTo(
      canvasX + canvasWidth,
      canvasY + canvasHeight,
      canvasX + canvasWidth - canvasRadius,
      canvasY + canvasHeight,
    );
    ctx.lineTo(canvasX + canvasRadius, canvasY + canvasHeight);
    ctx.quadraticCurveTo(canvasX, canvasY + canvasHeight, canvasX, canvasY + canvasHeight - canvasRadius);
    ctx.lineTo(canvasX, canvasY + canvasRadius);
    ctx.quadraticCurveTo(canvasX, canvasY, canvasX + canvasRadius, canvasY);
    ctx.closePath();
    ctx.fill();
  }

  private drawSvgPolygon(points: SvgPoint[], transform: SvgTransform = point => point): void {
    const ctx = this.ctx;
    const [firstX, firstY] = this.svgToCanvas(transform(points[0]));

    ctx.beginPath();
    ctx.moveTo(firstX, firstY);

    for (const point of points.slice(1)) {
      const [x, y] = this.svgToCanvas(transform(point));
      ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fill();
  }

  private drawSvgCircle(
    cx: number,
    cy: number,
    radius: number,
    transform: SvgTransform = point => point,
  ): void {
    const ctx = this.ctx;
    const [x, y] = this.svgToCanvas(transform([cx, cy]));

    ctx.beginPath();
    ctx.arc(x, y, toPixel(radius * SVG_UNIT_MM), 0, Math.PI * 2);
    ctx.fill();
  }

  private drawAimLine(line: { from: Vec2; to: Vec2 }, pad: number): void {
    const ctx = this.ctx;

    const fromX = pad + toPixel(line.from.x);
    const fromY = pad + toPixel(line.from.y);
    const toX = pad + toPixel(line.to.x);
    const toY = pad + toPixel(line.to.y);

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255,255,0,0.8)';
    ctx.beginPath();
    ctx.arc(toX, toY, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function lightenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  return `rgb(${Math.min(255, rgb.r + amount)}, ${Math.min(255, rgb.g + amount)}, ${Math.min(255, rgb.b + amount)})`;
}

function darkenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  return `rgb(${Math.max(0, rgb.r - amount)}, ${Math.max(0, rgb.g - amount)}, ${Math.max(0, rgb.b - amount)})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

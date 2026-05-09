// ============================================================
// 2D Snooker Table Renderer (Canvas)
// Top-down view, landscape orientation
// x-axis = long axis (left to right), y-axis = short axis (top to bottom)
// x=0 is Top cushion (black ball end), x=3569 is Baulk cushion
// ============================================================

import type { Ball, BallColor, Vec2 } from '../types';
import {
  TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, CUSHION_WIDTH,
  POCKET_POSITIONS, POCKET_RADII,
  BAULK_LINE_X, CENTER_Y, D_ZONE_RADIUS,
} from '../engine/constants';

// Scale: pixels per mm. Target ~950px canvas width for the 3569mm table
const SCALE = 0.26;

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

    const padding = CUSHION_WIDTH * SCALE * 2;
    this.width = toPixel(TABLE_LENGTH) + padding * 2;
    this.height = toPixel(TABLE_WIDTH) + padding * 2;

    canvas.width = this.width;
    canvas.height = this.height;
  }

  render(state: RenderState): void {
    const ctx = this.ctx;
    const pad = CUSHION_WIDTH * SCALE;

    ctx.clearRect(0, 0, this.width, this.height);

    // Outer frame (dark wood)
    ctx.fillStyle = '#2A1506';
    ctx.fillRect(0, 0, this.width, this.height);

    // Cushion area
    this.drawCushions();

    // Playing surface (green baize)
    ctx.fillStyle = '#0A6E3A';
    ctx.fillRect(pad, pad, toPixel(TABLE_LENGTH), toPixel(TABLE_WIDTH));

    // Draw markings
    this.drawMarkings(pad);

    // Draw pockets
    this.drawPockets(pad);

    // Aim line
    if (state.aimLine) {
      this.drawAimLine(state.aimLine, pad);
    }

    // Balls
    this.drawBalls(state.balls, pad);
  }

  private drawCushions(): void {
    const ctx = this.ctx;
    const cw = CUSHION_WIDTH * SCALE;

    ctx.fillStyle = '#5C3317';
    // Top cushion (x=0 side)
    ctx.fillRect(0, 0, cw, this.height);
    // Bottom/baulk cushion (x=TABLE_LENGTH side)
    ctx.fillRect(this.width - cw, 0, cw, this.height);
    // Left cushion (y=0 side)
    ctx.fillRect(0, 0, this.width, cw);
    // Right cushion (y=TABLE_WIDTH side)
    ctx.fillRect(0, this.height - cw, this.width, cw);

    // Inner edge
    ctx.strokeStyle = '#8B5E3C';
    ctx.lineWidth = 1;
    ctx.strokeRect(cw, cw, toPixel(TABLE_LENGTH), toPixel(TABLE_WIDTH));
  }

  private drawMarkings(pad: number): void {
    const ctx = this.ctx;

    // Baulk line (vertical line parallel to top cushion, 737mm from baulk end)
    const baulkPx = pad + toPixel(BAULK_LINE_X);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(baulkPx, pad);
    ctx.lineTo(baulkPx, pad + toPixel(TABLE_WIDTH));
    ctx.stroke();

    // D-zone (semi-circle on baulk line, opening toward top cushion)
    // In canvas: baulk line is on the RIGHT, top cushion is LEFT
    // Semi-circle extends from bottom → left → top (angles π/2 → π → 3π/2)
    const centerPx = pad + toPixel(CENTER_Y);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(baulkPx, centerPx, toPixel(D_ZONE_RADIUS), Math.PI / 2, Math.PI * 1.5, false);
    ctx.stroke();

    // Centre line (horizontal through blue spot)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, centerPx);
    ctx.lineTo(pad + toPixel(TABLE_LENGTH), centerPx);
    ctx.stroke();

    // Spot markers
    const spots: [number, number][] = [
      [324, CENTER_Y],             // Black
      [892.25, CENTER_Y],          // Pink
      [TABLE_LENGTH / 2, CENTER_Y], // Blue
      [BAULK_LINE_X, CENTER_Y],   // Brown
      [BAULK_LINE_X, CENTER_Y + D_ZONE_RADIUS], // Yellow
      [BAULK_LINE_X, CENTER_Y - D_ZONE_RADIUS], // Green
    ];

    for (const [x, y] of spots) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(pad + toPixel(x), pad + toPixel(y), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPockets(pad: number): void {
    const ctx = this.ctx;

    for (let i = 0; i < POCKET_POSITIONS.length; i++) {
      const [px, py] = POCKET_POSITIONS[i];
      const radius = POCKET_RADII[i];

      ctx.fillStyle = '#0A0A0A';
      ctx.beginPath();
      ctx.arc(pad + toPixel(px), pad + toPixel(py), toPixel(radius), 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#2A1506';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
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

      // Number on reds
      if (ball.color === 'red') {
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${Math.max(8, r * 0.8)}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(ball.id), x, y);
      }

      // White dot on color balls
      if (ball.color !== 'red' && ball.color !== 'white') {
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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

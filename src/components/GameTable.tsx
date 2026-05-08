// ============================================================
// Game Table Component
// Canvas-based snooker table with physics simulation
// ============================================================

import { useRef, useEffect, useCallback } from 'react';
import type { Ball, Vec2 } from '../types';
import { TableRenderer } from '../renderer/table-renderer';

interface GameTableProps {
  balls: Ball[];
  aimLine?: { from: Vec2; to: Vec2 };
  playerName: string;
}

export function GameTable({ balls, aimLine, playerName }: GameTableProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TableRenderer | null>(null);

  useEffect(() => {
    if (canvasRef.current && !rendererRef.current) {
      rendererRef.current = new TableRenderer(canvasRef.current);
    }
  }, []);

  useEffect(() => {
    if (rendererRef.current) {
      rendererRef.current.render({
        balls,
        currentPlayerName: playerName,
        aimLine,
      });
    }
  }, [balls, aimLine, playerName]);

  return (
    <div style={styles.container}>
      <div style={styles.label}>
        <span style={styles.dot} />
        台面视图
      </div>
      <canvas
        ref={canvasRef}
        style={styles.canvas}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'inline-block',
    borderRadius: '12px',
    overflow: 'hidden',
    boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
    border: '2px solid rgba(255,255,255,0.08)',
  },
  label: {
    position: 'absolute',
    top: '8px',
    left: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    color: 'rgba(255,255,255,0.5)',
    zIndex: 10,
    fontFamily: "'Segoe UI', sans-serif",
    letterSpacing: '0.5px',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: '#64ffda',
  },
  canvas: {
    display: 'block',
  },
};

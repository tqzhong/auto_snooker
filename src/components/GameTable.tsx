// ============================================================
// Game Table Component
// Canvas-based snooker table with physics simulation
// ============================================================

import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import type { Ball, Vec2 } from '../types';
import { TableRenderer } from '../renderer/table-renderer';

interface GameTableProps {
  balls: Ball[];
  aimLine?: { from: Vec2; to: Vec2 };
  playerName: string;
}

export interface GameTableHandle {
  getSnapshotDataUrl: () => string | null;
}

export const GameTable = forwardRef<GameTableHandle, GameTableProps>(function GameTable(
  { balls, aimLine, playerName },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<TableRenderer | null>(null);

  useImperativeHandle(ref, () => ({
    getSnapshotDataUrl: () => {
      if (!canvasRef.current) return null;
      try {
        return canvasRef.current.toDataURL('image/png');
      } catch {
        return null;
      }
    },
  }), []);

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
      <canvas
        ref={canvasRef}
        style={styles.canvas}
      />
    </div>
  );
});

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    display: 'inline-block',
    borderRadius: '12px',
    overflow: 'hidden',
    boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
    border: '2px solid rgba(255,255,255,0.08)',
  },
  canvas: {
    display: 'block',
  },
};

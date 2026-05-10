// ============================================================
// Shot History Component
// Shows recent shot log with LLM reasoning
// ============================================================

import type { ShotRecord, Player } from '../types';
import { BALL_VALUES } from '../types';

interface ShotHistoryProps {
  history: ShotRecord[];
  players: [Player, Player];
}

export function ShotHistory({ history, players }: ShotHistoryProps) {
  const recent = history.slice(-8).reverse();

  if (recent.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>出杆记录</div>
        <div style={styles.empty}>等待第一次出杆...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.title}>出杆记录</div>
      <div style={styles.list}>
        {recent.map((record, i) => {
          const player = players[record.playerIndex];
          const isPotted = record.result.pointsScored > 0;
          const isFoul = record.result.fouls.length > 0;

          return (
            <div key={history.length - 1 - i} style={{
              ...styles.entry,
              ...(isPotted ? styles.entrySuccess : {}),
              ...(isFoul ? styles.entryFoul : {}),
            }}>
              <div style={styles.entryHeader}>
                <span style={styles.playerTag}>{player.name}</span>
                <span style={{
                  ...styles.points,
                  color: isFoul ? '#ff6b6b' : '#64ffda',
                }}>
                  {isFoul
                    ? `-${record.result.fouls[0]?.points || 4}`
                    : `+${record.result.pointsScored}`
                  }
                </span>
              </div>
              <div style={styles.entryBody}>
                {isPotted && (
                  <span style={styles.pottedBalls}>
                    进球: {record.result.pottedBalls.map(b => (
                      <span key={b.id} style={{
                        ...styles.ballTag,
                        background: getBallColor(b.color),
                      }}>
                        {b.color}
                      </span>
                    ))}
                  </span>
                )}
                {isFoul && (
                  <span style={styles.foulText}>
                    {record.result.fouls[0]?.description}
                  </span>
                )}
                {!isPotted && !isFoul && (
                  <span style={styles.missText}>未进球</span>
                )}
              </div>
              {record.llmReasoning && (
                <div style={styles.reasoning}>
                  {record.llmReasoning}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getBallColor(color: string): string {
  const colors: Record<string, string> = {
    red: '#CC0000', yellow: '#FFD700', green: '#228B22',
    brown: '#8B4513', blue: '#1E90FF', pink: '#FF69B4', black: '#1A1A1A',
  };
  return colors[color] || '#666';
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    borderRadius: '12px',
    padding: '14px 16px',
    color: '#fff',
    fontFamily: "'Segoe UI', sans-serif",
    minWidth: '280px',
    maxHeight: '400px',
    overflowY: 'auto',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.1)',
  },
  title: {
    fontSize: '13px',
    fontWeight: 700,
    color: '#64ffda',
    marginBottom: '10px',
    letterSpacing: '0.5px',
  },
  empty: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.4)',
    fontStyle: 'italic',
    textAlign: 'center' as const,
    padding: '20px 0',
  },
  list: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  entry: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '8px',
    padding: '8px 10px',
    borderLeft: '3px solid rgba(255,255,255,0.1)',
  },
  entrySuccess: {
    borderLeft: '3px solid #64ffda',
    background: 'rgba(100,255,218,0.05)',
  },
  entryFoul: {
    borderLeft: '3px solid #ff6b6b',
    background: 'rgba(255,107,107,0.05)',
  },
  entryHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '4px',
  },
  playerTag: {
    fontSize: '11px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.8)',
  },
  points: {
    fontSize: '14px',
    fontWeight: 800,
  },
  entryBody: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.7)',
    marginBottom: '4px',
  },
  pottedBalls: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexWrap: 'wrap' as const,
  },
  ballTag: {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: '10px',
    fontSize: '10px',
    color: '#fff',
    fontWeight: 600,
  },
  foulText: {
    color: '#ff6b6b',
    fontSize: '11px',
  },
  missText: {
    color: 'rgba(255,255,255,0.4)',
    fontStyle: 'italic',
    fontSize: '11px',
  },
  reasoning: {
    fontSize: '11px',
    lineHeight: 1.45,
    color: 'rgba(255,255,255,0.58)',
    marginTop: '6px',
    whiteSpace: 'normal' as const,
  },
};

// ============================================================
// Scoreboard Component
// Shows player names, scores, current break, and game status
// ============================================================

import type { GameState } from '../types';

interface ScoreboardProps {
  state: GameState;
}

export function Scoreboard({ state }: ScoreboardProps) {
  const [p1, p2] = state.players;
  const isActive1 = state.currentPlayerIndex === 0 && state.phase !== 'game_over';
  const isActive2 = state.currentPlayerIndex === 1 && state.phase !== 'game_over';

  const phaseLabel = {
    break_off: '开球',
    reds_phase: '红球阶段',
    color_after_red: '选择彩球',
    colors_phase: '彩球阶段',
    game_over: '比赛结束',
  }[state.phase];

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.phase}>{phaseLabel}</span>
        <span style={styles.frame}>第 {state.frameNumber} 局</span>
      </div>

      <div style={styles.playersRow}>
        {/* Player 1 */}
        <div style={{
          ...styles.playerCard,
          ...(isActive1 ? styles.activeCard : {}),
        }}>
          <div style={styles.playerName}>{p1.name}</div>
          <div style={styles.score}>{p1.score}</div>
          {isActive1 && p1.currentBreak > 0 && (
            <div style={styles.break}>当前杆: {p1.currentBreak}</div>
          )}
          <div style={styles.highestBreak}>最高杆: {p1.highestBreak}</div>
        </div>

        <div style={styles.vs}>VS</div>

        {/* Player 2 */}
        <div style={{
          ...styles.playerCard,
          ...(isActive2 ? styles.activeCard : {}),
        }}>
          <div style={styles.playerName}>{p2.name}</div>
          <div style={styles.score}>{p2.score}</div>
          {isActive2 && p2.currentBreak > 0 && (
            <div style={styles.break}>当前杆: {p2.currentBreak}</div>
          )}
          <div style={styles.highestBreak}>最高杆: {p2.highestBreak}</div>
        </div>
      </div>

      {/* Red balls remaining */}
      {state.phase !== 'game_over' && (
        <div style={styles.redsRow}>
          <span style={styles.redsLabel}>红球剩余:</span>
          <div style={styles.redsContainer}>
            {Array.from({ length: state.redsRemaining }, (_, i) => (
              <div key={i} style={styles.redDot} />
            ))}
          </div>
        </div>
      )}

      {/* Status message */}
      <div style={styles.status}>{state.statusMessage}</div>

      {/* Next color to pot */}
      {state.nextColorToPot && state.phase === 'colors_phase' && (
        <div style={styles.nextColor}>
          下一颗: <strong>{state.nextColorToPot}</strong>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    borderRadius: '12px',
    padding: '16px 20px',
    color: '#fff',
    fontFamily: "'Segoe UI', sans-serif",
    minWidth: '500px',
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    border: '1px solid rgba(255,255,255,0.1)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
    borderBottom: '1px solid rgba(255,255,255,0.15)',
    paddingBottom: '8px',
  },
  phase: {
    fontSize: '14px',
    color: '#64ffda',
    fontWeight: 600,
  },
  frame: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.5)',
  },
  playersRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  playerCard: {
    flex: 1,
    textAlign: 'center' as const,
    padding: '12px',
    borderRadius: '8px',
    background: 'rgba(255,255,255,0.05)',
    transition: 'all 0.3s ease',
    border: '2px solid transparent',
  },
  activeCard: {
    background: 'rgba(100,255,218,0.1)',
    border: '2px solid #64ffda',
    boxShadow: '0 0 15px rgba(100,255,218,0.2)',
  },
  playerName: {
    fontSize: '16px',
    fontWeight: 700,
    marginBottom: '6px',
    letterSpacing: '0.5px',
  },
  score: {
    fontSize: '42px',
    fontWeight: 800,
    lineHeight: 1,
    background: 'linear-gradient(180deg, #fff 0%, #64ffda 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    marginBottom: '4px',
  },
  break: {
    fontSize: '12px',
    color: '#ffd700',
    fontWeight: 600,
    marginTop: '4px',
  },
  highestBreak: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.4)',
    marginTop: '2px',
  },
  vs: {
    fontSize: '14px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.3)',
    padding: '0 4px',
  },
  redsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '12px',
    padding: '8px',
    background: 'rgba(0,0,0,0.2)',
    borderRadius: '6px',
  },
  redsLabel: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.6)',
    whiteSpace: 'nowrap' as const,
  },
  redsContainer: {
    display: 'flex',
    gap: '4px',
    flexWrap: 'wrap' as const,
  },
  redDot: {
    width: '14px',
    height: '14px',
    borderRadius: '50%',
    background: 'radial-gradient(circle at 30% 30%, #ff4444, #aa0000)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
  },
  status: {
    marginTop: '10px',
    fontSize: '13px',
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'center' as const,
    minHeight: '18px',
    fontStyle: 'italic',
  },
  nextColor: {
    marginTop: '6px',
    fontSize: '13px',
    color: '#64ffda',
    textAlign: 'center' as const,
  },
};

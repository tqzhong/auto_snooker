// ============================================================
// Training Panel — Browser-based training visualization
// ============================================================

import { useState, useCallback, useRef } from 'react';
import type { AgentStats, FrameRecord } from '../training/types';
import type { Agent } from '../ai/agents/agent';
import { MasterSnookerAgent } from '../ai/agents/master-agent';
import { createTrainer, formatTrainingResults } from '../training/trainer';
import { createRoundRobinPairs, createSelfPlayPairs, createChampionPairs } from '../training/matcher';
import { runHeadlessFrame } from '../engine/game-loop';

const AGENT_FACTORIES: Record<string, () => Agent> = {
  'master-a': () => new MasterSnookerAgent('Master-A'),
  'master-b': () => new MasterSnookerAgent('Master-B'),
};

interface TrainingState {
  running: boolean;
  progress: number;
  total: number;
  results: string;
  lastFrame: FrameRecord | null;
  agentStats: AgentStats[];
}

export function TrainingPanel() {
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['master-a', 'master-b']);
  const [frameCount, setFrameCount] = useState(10);
  const [mode, setMode] = useState<'round-robin' | 'self-play'>('round-robin');
  const [state, setState] = useState<TrainingState>({
    running: false, progress: 0, total: 0,
    results: '', lastFrame: null, agentStats: [],
  });

  const toggleAgent = (name: string) => {
    setSelectedAgents(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  };

  const handleTrain = useCallback(async () => {
    if (selectedAgents.length < 2) return;

    const agents = selectedAgents.map(n => AGENT_FACTORIES[n]());
    const pairs = mode === 'self-play'
      ? createSelfPlayPairs(agents)
      : createRoundRobinPairs(agents);
    const total = pairs.length * frameCount;

    setState(prev => ({ ...prev, running: true, progress: 0, total, results: '' }));

    const trainer = createTrainer({
      agentPairs: pairs,
      framesPerPair: frameCount,
      onProgress: (completed) => {
        setState(prev => ({ ...prev, progress: completed }));
      },
    });

    const results = await trainer.run();
    const formatted = formatTrainingResults(results);

    setState(prev => ({
      ...prev,
      running: false,
      results: formatted,
      agentStats: [...results.agentStats.values()],
    }));
  }, [selectedAgents, frameCount, mode]);

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>🎓 Agent 训练中心</h2>

      {/* Agent Selection */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>选择参赛 Agent</div>
        <div style={styles.agentGrid}>
          {Object.keys(AGENT_FACTORIES).map(name => (
            <button
              key={name}
              style={{
                ...styles.agentBtn,
                ...(selectedAgents.includes(name) ? styles.agentBtnActive : {}),
              }}
              onClick={() => toggleAgent(name)}
            >
              {name.startsWith('master') && '🎯'}
              {' '}{name}
            </button>
          ))}
        </div>
      </div>

      {/* Config */}
      <div style={styles.section}>
        <div style={styles.row}>
          <label style={styles.label}>
            每对对局数:
            <input
              type="number"
              value={frameCount}
              onChange={e => setFrameCount(Math.max(1, parseInt(e.target.value) || 1))}
              style={styles.input}
              min={1}
              max={500}
            />
          </label>
          <label style={styles.label}>
            模式:
            <select
              value={mode}
              onChange={e => setMode(e.target.value as 'round-robin' | 'self-play')}
              style={styles.select}
            >
              <option value="round-robin">循环赛</option>
              <option value="self-play">自我对战</option>
            </select>
          </label>
        </div>
      </div>

      {/* Control */}
      <div style={styles.section}>
        <button
          style={{
            ...styles.trainBtn,
            ...(state.running ? styles.trainBtnRunning : {}),
          }}
          onClick={handleTrain}
          disabled={state.running || selectedAgents.length < 2}
        >
          {state.running
            ? `⏳ 训练中... ${state.progress}/${state.total} (${Math.floor((state.progress / Math.max(state.total, 1)) * 100)}%)`
            : '▶ 开始训练'
          }
        </button>
      </div>

      {/* Progress Bar */}
      {state.running && (
        <div style={styles.progressContainer}>
          <div style={{
            ...styles.progressBar,
            width: `${(state.progress / Math.max(state.total, 1)) * 100}%`,
          }} />
        </div>
      )}

      {/* Stats Table */}
      {state.agentStats.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>成绩排行</div>
          <div style={styles.statsTable}>
            <div style={styles.statsHeader}>
              <span style={{ ...styles.statsCell, flex: 2 }}>Agent</span>
              <span style={styles.statsCell}>W/L/D</span>
              <span style={styles.statsCell}>胜率</span>
              <span style={styles.statsCell}>场均分</span>
              <span style={styles.statsCell}>最高连续</span>
              <span style={styles.statsCell}>进球率</span>
              <span style={styles.statsCell}>犯规率</span>
            </div>
            {[...state.agentStats]
              .sort((a, b) => b.winRate - a.winRate)
              .map((stats, i) => (
                <div key={stats.name} style={{
                  ...styles.statsRow,
                  background: i === 0 ? 'rgba(255, 215, 0, 0.08)' : 'transparent',
                }}>
                  <span style={{ ...styles.statsCell, flex: 2, fontWeight: i === 0 ? 700 : 400 }}>
                    {i === 0 && '🏆 '}{stats.name}
                  </span>
                  <span style={styles.statsCell}>{stats.wins}/{stats.losses}/{stats.draws}</span>
                  <span style={styles.statsCell}>{(stats.winRate * 100).toFixed(1)}%</span>
                  <span style={styles.statsCell}>{stats.avgPointsPerGame.toFixed(1)}</span>
                  <span style={styles.statsCell}>{stats.highestBreak}</span>
                  <span style={styles.statsCell}>{(stats.potSuccessRate * 100).toFixed(1)}%</span>
                  <span style={styles.statsCell}>{(stats.foulRate * 100).toFixed(1)}%</span>
                </div>
              ))
            }
          </div>
        </div>
      )}

      {/* Raw Results */}
      {state.results && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>详细结果</div>
          <pre style={styles.pre}>{state.results}</pre>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '20px',
    background: 'rgba(255,255,255,0.03)',
    borderRadius: '12px',
    border: '1px solid rgba(255,255,255,0.08)',
    maxHeight: '80vh',
    overflow: 'auto',
  },
  title: {
    margin: '0 0 20px',
    fontSize: '20px',
    fontWeight: 700,
    background: 'linear-gradient(90deg, #64ffda, #48b1ff)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  section: { marginBottom: '16px' },
  sectionTitle: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.5)',
    marginBottom: '8px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  agentGrid: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
  },
  agentBtn: {
    padding: '8px 16px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'transparent',
    color: 'rgba(255,255,255,0.6)',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  agentBtnActive: {
    background: 'rgba(100,255,218,0.15)',
    color: '#64ffda',
    borderColor: '#64ffda',
  },
  row: {
    display: 'flex',
    gap: '16px',
    alignItems: 'center',
  },
  label: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.6)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  input: {
    width: '60px',
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.05)',
    color: '#fff',
    fontSize: '13px',
  },
  select: {
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.05)',
    color: '#fff',
    fontSize: '13px',
  },
  trainBtn: {
    width: '100%',
    padding: '12px 24px',
    borderRadius: '8px',
    border: 'none',
    background: 'linear-gradient(135deg, #64ffda 0%, #48b1ff 100%)',
    color: '#0f0c29',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  trainBtnRunning: {
    opacity: 0.7,
    cursor: 'not-allowed',
  },
  progressContainer: {
    height: '4px',
    borderRadius: '2px',
    background: 'rgba(255,255,255,0.1)',
    marginBottom: '16px',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    borderRadius: '2px',
    background: 'linear-gradient(90deg, #64ffda, #48b1ff)',
    transition: 'width 0.3s ease',
  },
  statsTable: {
    fontSize: '12px',
  },
  statsHeader: {
    display: 'flex',
    padding: '8px 0',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.4)',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.3px',
    fontSize: '11px',
  },
  statsRow: {
    display: 'flex',
    padding: '6px 0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
  },
  statsCell: {
    flex: 1,
    textAlign: 'center' as const,
    color: 'rgba(255,255,255,0.7)',
  },
  pre: {
    padding: '12px',
    borderRadius: '8px',
    background: 'rgba(0,0,0,0.3)',
    color: 'rgba(255,255,255,0.6)',
    fontSize: '11px',
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    overflow: 'auto',
    maxHeight: '300px',
    whiteSpace: 'pre' as const,
  },
};

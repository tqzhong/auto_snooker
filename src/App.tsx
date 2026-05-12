// ============================================================
// Main App - Snooker Game Controller
// Orchestrates AI decisions, physics simulation, and rendering
// ============================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import type { GameState, ShotParams, Vec2, Ball } from './types';
import { createInitialBalls } from './engine/physics';
import { createInitialGameState, evaluateShot, applyShotResult } from './engine/rules';
import { simulateShot, applyShot, angleBetween } from './engine/physics';
import { getAIMoveDecision } from './ai/llm-engine';
import { GameTable } from './components/GameTable';
import { Scoreboard } from './components/Scoreboard';
import { ShotHistory } from './components/ShotHistory';
import { TrainingPanel } from './components/TrainingPanel';

// Simulation speed (ms between each simulation tick)
const DEFAULT_TICK_MS = 16; // ~60fps
const SHOT_SETTLE_DELAY = 800; // Wait after balls stop before next AI decision

export default function App() {
  const [gameState, setGameState] = useState<GameState>(() => {
    const balls = createInitialBalls();
    return createInitialGameState(['AI 玩家 1', 'AI 玩家 2'], balls);
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'game' | 'training'>('game');
  const [speed, setSpeed] = useState(1); // 1x, 2x, 4x
  const [shotInFlight, setShotInFlight] = useState(false);
  const [currentAim, setCurrentAim] = useState<{ from: Vec2; to: Vec2 } | undefined>();
  const [animatedBalls, setAnimatedBalls] = useState<Ball[] | null>(null);

  const tickRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationRef = useRef<number | null>(null);
  const gameStateRef = useRef(gameState);
  gameStateRef.current = gameState;

  // Animate through simulation frames using requestAnimationFrame
  const animateFrames = useCallback((frames: Ball[][], animSpeed: number): Promise<void> => {
    return new Promise((resolve) => {
      if (frames.length === 0) {
        resolve();
        return;
      }

      // Frame interval: at 1x speed, show each frame for ~50ms; faster at higher speeds
      const baseMsPerFrame = 50; // ms per animation frame at 1x
      const msPerFrame = baseMsPerFrame / animSpeed;

      let frameIndex = 0;
      let lastFrameTime = 0;

      const animate = (timestamp: number) => {
        if (frameIndex >= frames.length) {
          setAnimatedBalls(null);
          if (animationRef.current) {
            cancelAnimationFrame(animationRef.current);
            animationRef.current = null;
          }
          resolve();
          return;
        }

        if (timestamp - lastFrameTime >= msPerFrame) {
          setAnimatedBalls(frames[frameIndex]);
          frameIndex++;
          lastFrameTime = timestamp;
        }

        animationRef.current = requestAnimationFrame(animate);
      };

      // Show first frame immediately, then start animation loop
      setAnimatedBalls(frames[0]);
      frameIndex = 1;
      lastFrameTime = performance.now();
      animationRef.current = requestAnimationFrame(animate);
    });
  }, []);

  // Auto-play: trigger AI decisions
  const triggerAIDecision = useCallback(async () => {
    const state = gameStateRef.current;
    if (state.phase === 'game_over' || state.simulating) return;

    setGameState(prev => ({ ...prev, simulating: true, statusMessage: 'AI 思考中...' }));

    try {
      // Get AI decision
      const decision = await getAIMoveDecision(state);
      setGameState(prev => ({
        ...prev,
        statusMessage: `AI决策: ${decision.reasoning}`,
      }));

      // Show aim line
      const cueBall = state.balls.find(b => b.color === 'white' && !b.pocketed);
      if (cueBall) {
        const aimLength = 1500; // mm
        setCurrentAim({
          from: { ...cueBall.pos },
          to: {
            x: cueBall.pos.x + Math.cos(decision.aimAngle) * aimLength,
            y: cueBall.pos.y + Math.sin(decision.aimAngle) * aimLength,
          },
        });
      }

      // Small delay to show the aim line
      await new Promise(r => setTimeout(r, 600));

      // Clear aim line before animation starts
      setCurrentAim(undefined);

      // Apply shot physics
      const ballsCopy = state.balls.map(b => ({
        ...b,
        pos: { ...b.pos },
        vel: { ...b.vel },
      }));

      applyShot(ballsCopy, decision.aimAngle, decision.power, decision.spinX, decision.spinY);

      const shotParams: ShotParams = {
        angle: decision.aimAngle,
        power: decision.power,
        spinX: decision.spinX,
        spinY: decision.spinY,
        targetBallId: decision.targetBallId,
      };

      // Simulate physics and get animation frames
      const simResult = simulateShot(ballsCopy);

      // Animate through the frames
      if (simResult.frames.length > 0) {
        await animateFrames(simResult.frames, speed);
      }

      // After animation completes, evaluate shot result
      const shotResult = evaluateShot(state, shotParams, simResult);
      const newState = applyShotResult(state, shotParams, simResult, shotResult, decision.reasoning);
      newState.simulating = false;

      setGameState(newState);
      setShotInFlight(false);

      // If game continues and still playing, schedule next shot
      if (isPlaying && newState.phase !== 'game_over') {
        tickRef.current = setTimeout(() => {
          triggerAIDecision();
        }, SHOT_SETTLE_DELAY / speed);
      }
    } catch (err) {
      console.error('AI decision error:', err);
      setAnimatedBalls(null);
      setGameState(prev => ({
        ...prev,
        simulating: false,
        statusMessage: `AI决策出错: ${err instanceof Error ? err.message : '未知错误'}`,
      }));
    }
  }, [isPlaying, speed, animateFrames]);

  // Start/stop auto-play
  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
      if (tickRef.current) clearTimeout(tickRef.current);
    } else {
      setIsPlaying(true);
      // Start immediately
      setTimeout(() => triggerAIDecision(), 100);
    }
  }, [isPlaying, triggerAIDecision]);

  // Step: single shot
  const handleStep = useCallback(() => {
    if (!gameState.simulating && gameState.phase !== 'game_over') {
      triggerAIDecision();
    }
  }, [gameState.simulating, gameState.phase, triggerAIDecision]);

  // Reset game
  const handleReset = useCallback(() => {
    if (tickRef.current) clearTimeout(tickRef.current);
    setIsPlaying(false);
    setShotInFlight(false);
    setCurrentAim(undefined);
    const balls = createInitialBalls();
    setGameState(createInitialGameState(['AI 玩家 1', 'AI 玩家 2'], balls));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tickRef.current) clearTimeout(tickRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, []);

  const gameOver = gameState.phase === 'game_over';

  return (
    <div style={styles.app}>
      {/* Header */}
      <header style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleIcon}>🎱</span>
          Auto Snooker
        </h1>
        <p style={styles.subtitle}>
          AI 驱动的斯诺克对局模拟 · Xiaomi MiMo 决策引擎
        </p>
      </header>

      {/* Tab Bar */}
      <div style={styles.tabBar}>
        <button
          style={activeTab === 'game' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('game')}
        >
          🎱 对局
        </button>
        <button
          style={activeTab === 'training' ? styles.tabActive : styles.tab}
          onClick={() => setActiveTab('training')}
        >
          🎓 训练中心
        </button>
      </div>

      {/* Main content */}
      {activeTab === 'game' ? (<div style={styles.main}>
        {/* Left panel: Scoreboard */}
        <div style={styles.leftPanel}>
          <Scoreboard state={gameState} />

          {/* Controls */}
          <div style={styles.controls}>
            <button
              style={{
                ...styles.btn,
                ...(gameOver ? styles.btnDisabled : {}),
              }}
              onClick={handlePlayPause}
              disabled={gameOver}
            >
              {isPlaying ? '⏸ 暂停' : '▶ 开始自动对局'}
            </button>

            <button
              style={{
                ...styles.btnSecondary,
                ...(gameOver || gameState.simulating ? styles.btnDisabled : {}),
              }}
              onClick={handleStep}
              disabled={gameOver || gameState.simulating}
            >
              ⏭ 单步
            </button>

            <button style={styles.btnDanger} onClick={handleReset}>
              🔄 重新开始
            </button>

            {/* Speed control */}
            <div style={styles.speedControl}>
              <span style={styles.speedLabel}>速度:</span>
              {[1, 2, 4].map(s => (
                <button
                  key={s}
                  style={{
                    ...styles.speedBtn,
                    ...(speed === s ? styles.speedBtnActive : {}),
                  }}
                  onClick={() => setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          {/* Shot History */}
          <ShotHistory history={gameState.shotHistory} players={gameState.players} />
        </div>

        {/* Center: Table */}
        <div style={styles.tableContainer}>
          <GameTable
            balls={animatedBalls ?? gameState.balls}
            aimLine={currentAim}
            playerName={gameState.players[gameState.currentPlayerIndex].name}
          />

          {/* Game over overlay */}
          {gameOver && (
            <div style={styles.gameOverOverlay}>
              <div style={styles.gameOverBox}>
                <h2 style={styles.gameOverTitle}>比赛结束!</h2>
                <div style={styles.gameOverScores}>
                  <span>{gameState.players[0].name}: {gameState.players[0].score}</span>
                  <span style={styles.gameOverVs}>VS</span>
                  <span>{gameState.players[1].name}: {gameState.players[1].score}</span>
                </div>
                <button style={styles.btn} onClick={handleReset}>
                  开始新一局
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      ) : (
        <div style={styles.main}>
          <TrainingPanel />
        </div>
      )}

      {/* Footer */}
      <footer style={styles.footer}>
        <span>基于国际斯诺克规则 · 物理引擎模拟 · AI 策略决策</span>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #0f0c29 0%, #1a1a2e 50%, #16213e 100%)',
    color: '#fff',
    fontFamily: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    textAlign: 'center' as const,
    padding: '20px 20px 10px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  title: {
    margin: 0,
    fontSize: '28px',
    fontWeight: 800,
    background: 'linear-gradient(90deg, #64ffda, #48b1ff)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    letterSpacing: '-0.5px',
  },
  titleIcon: {
    marginRight: '8px',
    WebkitTextFillColor: 'initial',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: '13px',
    color: 'rgba(255,255,255,0.4)',
    fontWeight: 400,
  },
  main: {
    flex: 1,
    display: 'flex',
    gap: '20px',
    padding: '20px',
    justifyContent: 'center',
    alignItems: 'flex-start',
    flexWrap: 'wrap' as const,
  },
  leftPanel: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    minWidth: '500px',
    maxWidth: '520px',
  },
  tableContainer: {
    position: 'relative',
  },
  controls: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
  },
  btn: {
    padding: '10px 20px',
    borderRadius: '8px',
    border: 'none',
    background: 'linear-gradient(135deg, #64ffda 0%, #48b1ff 100%)',
    color: '#0f0c29',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    letterSpacing: '0.3px',
  },
  btnSecondary: {
    padding: '10px 16px',
    borderRadius: '8px',
    border: '1px solid rgba(100,255,218,0.3)',
    background: 'rgba(100,255,218,0.1)',
    color: '#64ffda',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  btnDanger: {
    padding: '10px 16px',
    borderRadius: '8px',
    border: '1px solid rgba(255,107,107,0.3)',
    background: 'rgba(255,107,107,0.1)',
    color: '#ff6b6b',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  btnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  speedControl: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginLeft: 'auto',
  },
  speedLabel: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.4)',
  },
  speedBtn: {
    padding: '4px 10px',
    borderRadius: '4px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'transparent',
    color: 'rgba(255,255,255,0.5)',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  speedBtnActive: {
    background: 'rgba(100,255,218,0.15)',
    color: '#64ffda',
    borderColor: '#64ffda',
  },
  gameOverOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '12px',
    zIndex: 100,
    backdropFilter: 'blur(4px)',
  },
  gameOverBox: {
    textAlign: 'center' as const,
    padding: '40px',
    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    borderRadius: '16px',
    border: '1px solid rgba(100,255,218,0.2)',
    boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
  },
  gameOverTitle: {
    margin: '0 0 20px',
    fontSize: '32px',
    fontWeight: 800,
    background: 'linear-gradient(90deg, #ffd700, #ff6b6b)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  gameOverScores: {
    display: 'flex',
    gap: '20px',
    justifyContent: 'center',
    fontSize: '18px',
    fontWeight: 600,
    marginBottom: '24px',
  },
  gameOverVs: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: '14px',
  },
  footer: {
    textAlign: 'center' as const,
    padding: '12px 20px',
    fontSize: '11px',
    color: 'rgba(255,255,255,0.2)',
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  tabBar: {
    display: 'flex',
    justifyContent: 'center',
    gap: '4px',
    padding: '10px 20px 0',
  },
  tab: {
    padding: '8px 20px',
    borderRadius: '8px 8px 0 0',
    border: '1px solid rgba(255,255,255,0.1)',
    borderBottom: 'none',
    background: 'transparent',
    color: 'rgba(255,255,255,0.4)',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  tabActive: {
    padding: '8px 20px',
    borderRadius: '8px 8px 0 0',
    border: '1px solid rgba(100,255,218,0.3)',
    borderBottom: 'none',
    background: 'rgba(100,255,218,0.08)',
    color: '#64ffda',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
};

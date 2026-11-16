import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { playGameTone } from '../../lib/gameAudio';

type RepairState = 'TITLE_MENU' | 'PLAYING' | 'PAUSED' | 'ROUND_SUMMARY';
type RepairStage = 'prep' | 'pour' | 'fill' | 'smooth';

interface DebrisChunk {
  id: number;
  x: number;
  y: number;
  r: number;
  cleared: boolean;
}

interface TampSpot {
  id: number;
  x: number;
  y: number;
  tamped: boolean;
}

interface PotholeRepairGameProps {
  highScore: number;
  onCompleteRun: (score: number, durationMs: number) => void;
}

const LOGICAL_W = 640;
const LOGICAL_H = 380;
const CRATER_CX = 320;
const CRATER_CY = 215;
const CRATER_RX = 138;
const CRATER_RY = 86;

const STAGE_LABELS: Record<RepairStage, { step: number; title: string; instruction: string }> = {
  prep: {
    step: 1,
    title: 'Clear Debris',
    instruction: 'Tap or swipe over all 6 loose chunks inside the crater.',
  },
  pour: {
    step: 2,
    title: 'Pour Asphalt Mix',
    instruction: 'Press & hold inside the crater (or Spacebar) until fill hits 85–100%.',
  },
  fill: {
    step: 3,
    title: 'Compact & Tamp',
    instruction: 'Tap all 5 glowing seam pockets to compact the asphalt mix.',
  },
  smooth: {
    step: 4,
    title: 'Smooth & Level',
    instruction: 'Scrub back and forth across the patch until 100% flush.',
  },
};

function createDebris(): DebrisChunk[] {
  return [
    { id: 1, x: CRATER_CX - 72, y: CRATER_CY - 22, r: 16, cleared: false },
    { id: 2, x: CRATER_CX - 18, y: CRATER_CY - 38, r: 15, cleared: false },
    { id: 3, x: CRATER_CX + 56, y: CRATER_CY - 16, r: 17, cleared: false },
    { id: 4, x: CRATER_CX - 48, y: CRATER_CY + 28, r: 16, cleared: false },
    { id: 5, x: CRATER_CX + 12, y: CRATER_CY + 14, r: 18, cleared: false },
    { id: 6, x: CRATER_CX + 78, y: CRATER_CY + 30, r: 15, cleared: false },
  ];
}

function createTampSpots(): TampSpot[] {
  return [
    { id: 1, x: CRATER_CX - 78, y: CRATER_CY - 14, tamped: false },
    { id: 2, x: CRATER_CX, y: CRATER_CY - 44, tamped: false },
    { id: 3, x: CRATER_CX + 76, y: CRATER_CY - 10, tamped: false },
    { id: 4, x: CRATER_CX - 42, y: CRATER_CY + 36, tamped: false },
    { id: 5, x: CRATER_CX + 46, y: CRATER_CY + 34, tamped: false },
  ];
}

export const PotholeRepairGame: React.FC<PotholeRepairGameProps> = ({
  highScore,
  onCompleteRun,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  const [gameState, setGameState] = useState<RepairState>('TITLE_MENU');
  const [stage, setStage] = useState<RepairStage>('prep');
  const [muted, setMuted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pourLevel, setPourLevel] = useState(0);
  const [smoothness, setSmoothness] = useState(0);
  const [stageProgressText, setStageProgressText] = useState('0 / 6 debris');
  const [summary, setSummary] = useState<{
    score: number;
    grade: 'S' | 'A' | 'B' | 'C';
    precisionBonus: number;
    speedBonus: number;
    durationMs: number;
    pourPercent: number;
  } | null>(null);

  // Mutable simulation state synced cleanly with RAF
  const simRef = useRef<{
    stage: RepairStage;
    debris: DebrisChunk[];
    tampSpots: TampSpot[];
    pourLevel: number;
    isPouring: boolean;
    pourPrecisionPoints: number;
    smoothness: number;
    lastPointerPos: { x: number; y: number } | null;
    elapsedMs: number;
    ripple: { x: number; y: number; alpha: number } | null;
  }>({
    stage: 'prep',
    debris: createDebris(),
    tampSpots: createTampSpots(),
    pourLevel: 0,
    isPouring: false,
    pourPrecisionPoints: 0,
    smoothness: 0,
    lastPointerPos: null,
    elapsedMs: 0,
    ripple: null,
  });

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const finishRepair = useCallback(() => {
    stopLoop();
    const sim = simRef.current;
    const finalDuration = Math.max(2500, Math.round(sim.elapsedMs));
    const basePoints = 520;
    const precisionBonus = sim.pourPrecisionPoints; // up to 280
    const speedBonus = Math.max(0, Math.min(200, Math.round(200 - (finalDuration - 7000) / 110)));
    const totalScore = Math.max(250, Math.min(1000, basePoints + precisionBonus + speedBonus));
    const grade: 'S' | 'A' | 'B' | 'C' =
      totalScore >= 900 ? 'S' : totalScore >= 780 ? 'A' : totalScore >= 640 ? 'B' : 'C';

    playGameTone('win', muted);
    setSummary({
      score: totalScore,
      grade,
      precisionBonus,
      speedBonus,
      durationMs: finalDuration,
      pourPercent: Math.round(sim.pourLevel),
    });
    setGameState('ROUND_SUMMARY');
    onCompleteRun(totalScore, finalDuration);
  }, [muted, onCompleteRun, stopLoop]);

  const startFreshRun = useCallback(() => {
    stopLoop();
    simRef.current = {
      stage: 'prep',
      debris: createDebris(),
      tampSpots: createTampSpots(),
      pourLevel: 0,
      isPouring: false,
      pourPrecisionPoints: 0,
      smoothness: 0,
      lastPointerPos: null,
      elapsedMs: 0,
      ripple: null,
    };
    setStage('prep');
    setElapsedMs(0);
    setPourLevel(0);
    setSmoothness(0);
    setStageProgressText('0 / 6 debris');
    setSummary(null);
    setGameState('PLAYING');
    playGameTone('tap', muted);
  }, [muted, stopLoop]);

  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const targetW = Math.round(LOGICAL_W * dpr);
    const targetH = Math.round(LOGICAL_H * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Atlanta street top-down backdrop
    ctx.fillStyle = '#E8DFC5';
    ctx.fillRect(0, 0, LOGICAL_W, 38); // Sidewalk curb
    ctx.fillStyle = '#D5CCB0';
    ctx.fillRect(0, 38, LOGICAL_W, 8);

    // Asphalt surface
    ctx.fillStyle = '#3A3535';
    ctx.fillRect(0, 46, LOGICAL_W, LOGICAL_H - 46);

    // Subtle aggregate asphalt speckle
    ctx.fillStyle = '#4B4646';
    for (let i = 0; i < 65; i++) {
      const sx = (i * 97 + 23) % LOGICAL_W;
      const sy = 56 + ((i * 53 + 17) % (LOGICAL_H - 64));
      ctx.fillRect(sx, sy, 3, 2);
    }

    // Road center yellow-sand lane dashes
    ctx.fillStyle = '#E8DFC5';
    for (let x = 20; x < LOGICAL_W; x += 96) {
      ctx.fillRect(x, 102, 52, 8);
    }

    const sim = simRef.current;

    // 2. Jagged Pothole Crater Outer Rim
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(CRATER_CX, CRATER_CY, CRATER_RX + 10, CRATER_RY + 8, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#24222A';
    ctx.fill();

    // Inner Crater Cavity
    ctx.beginPath();
    ctx.ellipse(CRATER_CX, CRATER_CY, CRATER_RX, CRATER_RY, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#1B1920';
    ctx.fill();
    ctx.clip();

    // Depth shadow rings
    ctx.strokeStyle = '#2D2B35';
    ctx.lineWidth = 6;
    ctx.stroke();

    // 3. Stage-dependent Asphalt Mix Fill
    if (sim.stage === 'pour' || sim.stage === 'fill' || sim.stage === 'smooth') {
      const fillRatio = Math.min(1.12, Math.max(0, sim.pourLevel / 100));
      if (fillRatio > 0.01) {
        const mixColor =
          sim.stage === 'smooth' && sim.smoothness >= 95
            ? '#36323B'
            : sim.stage === 'smooth'
              ? '#3E3943'
              : '#2D2B35';
        ctx.fillStyle = mixColor;
        const fillRx = CRATER_RX * Math.min(1, 0.3 + fillRatio * 0.7);
        const fillRy = CRATER_RY * Math.min(1, 0.3 + fillRatio * 0.7);
        ctx.beginPath();
        ctx.ellipse(CRATER_CX, CRATER_CY, fillRx, fillRy, 0, 0, Math.PI * 2);
        ctx.fill();

        // Warm aggregate sheen during pour/fill
        if (sim.stage === 'pour' || sim.stage === 'fill') {
          ctx.fillStyle = 'rgba(217, 119, 6, 0.24)';
          for (let i = 0; i < 24; i++) {
            const ax = CRATER_CX - 95 + ((i * 41) % 190);
            const ay = CRATER_CY - 55 + ((i * 29) % 110);
            ctx.fillRect(ax, ay, 4, 3);
          }
        }
      }
    }

    // 4. Prep Stage Debris Chunks
    if (sim.stage === 'prep') {
      for (const chunk of sim.debris) {
        if (chunk.cleared) continue;
        ctx.fillStyle = '#6E6978';
        ctx.beginPath();
        ctx.arc(chunk.x, chunk.y, chunk.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#E8DFC5';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Inner X mark showing removable debris
        ctx.strokeStyle = '#2D2B35';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(chunk.x - 5, chunk.y - 5);
        ctx.lineTo(chunk.x + 5, chunk.y + 5);
        ctx.moveTo(chunk.x + 5, chunk.y - 5);
        ctx.lineTo(chunk.x - 5, chunk.y + 5);
        ctx.stroke();
      }
    }

    // 5. Fill/Tamp Stage Pockets
    if (sim.stage === 'fill') {
      for (const spot of sim.tampSpots) {
        ctx.beginPath();
        ctx.arc(spot.x, spot.y, 18, 0, Math.PI * 2);
        if (spot.tamped) {
          ctx.fillStyle = 'rgba(76, 183, 41, 0.35)';
          ctx.fill();
          ctx.strokeStyle = '#4CB729';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(217, 119, 6, 0.42)';
          ctx.fill();
          ctx.strokeStyle = '#F59E0B';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      }
    }

    // 6. Smooth Stage Texture Seams fading with smoothness
    if (sim.stage === 'smooth') {
      const roughness = Math.max(0, 1 - sim.smoothness / 100);
      if (roughness > 0.04) {
        ctx.strokeStyle = `rgba(232, 223, 197, ${0.45 * roughness})`;
        ctx.lineWidth = 2;
        for (let i = -3; i <= 3; i++) {
          ctx.beginPath();
          ctx.moveTo(CRATER_CX - 95, CRATER_CY + i * 18);
          ctx.lineTo(CRATER_CX + 95, CRATER_CY + i * 18 + (i % 2 === 0 ? 6 : -6));
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = '#4CB729';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.ellipse(CRATER_CX, CRATER_CY, CRATER_RX - 4, CRATER_RY - 4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();

    // 7. Trowel / Pour Nozzle visual affordance on canvas
    if (sim.stage === 'pour') {
      // Draw Pour Gauge along right side of canvas
      const barX = 562;
      const barY = 82;
      const barW = 28;
      const barH = 230;
      ctx.fillStyle = '#2D2B35';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.strokeStyle = '#E8DFC5';
      ctx.lineWidth = 2;
      ctx.strokeRect(barX, barY, barW, barH);

      // Green sweet spot (85% to 100% of 115% scale)
      const sweetTop = barY + barH * (1 - 100 / 115);
      const sweetBottom = barY + barH * (1 - 85 / 115);
      ctx.fillStyle = 'rgba(76, 183, 41, 0.45)';
      ctx.fillRect(barX + 2, sweetTop, barW - 4, sweetBottom - sweetTop);

      const fillPct = Math.min(1, sim.pourLevel / 115);
      const fillH = barH * fillPct;
      ctx.fillStyle = sim.pourLevel > 103 ? '#DC2626' : sim.pourLevel >= 85 ? '#4CB729' : '#D97706';
      ctx.fillRect(barX + 3, barY + barH - fillH, barW - 6, fillH);
    }

    // 8. Touch/Click ripple feedback
    if (sim.ripple && sim.ripple.alpha > 0.02 && !prefersReducedMotion) {
      ctx.beginPath();
      ctx.arc(sim.ripple.x, sim.ripple.y, 28 * (1.2 - sim.ripple.alpha), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(76, 183, 41, ${sim.ripple.alpha})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    ctx.restore();
  }, [prefersReducedMotion]);

  // Main RequestAnimationFrame loop (active ONLY while PLAYING)
  useEffect(() => {
    drawScene();
    if (gameState !== 'PLAYING') {
      stopLoop();
      return;
    }

    lastFrameRef.current = performance.now();

    const step = (now: number) => {
      const dtMs = Math.min(50, Math.max(0, now - lastFrameRef.current));
      lastFrameRef.current = now;

      const sim = simRef.current;
      sim.elapsedMs += dtMs;

      if (sim.ripple) {
        sim.ripple.alpha = Math.max(0, sim.ripple.alpha - dtMs / 240);
        if (sim.ripple.alpha <= 0) sim.ripple = null;
      }

      if (sim.stage === 'pour' && sim.isPouring) {
        sim.pourLevel = Math.min(115, sim.pourLevel + (dtMs / 1000) * 38);
        setPourLevel(Math.round(sim.pourLevel));
        setStageProgressText(`${Math.round(sim.pourLevel)}% filled (target 85–100%)`);

        // Auto-lock if poured to max cap so player never gets stuck
        if (sim.pourLevel >= 112) {
          sim.isPouring = false;
          sim.pourPrecisionPoints = 130; // minor overfill
          sim.stage = 'fill';
          setStage('fill');
          setStageProgressText('0 / 5 tamped');
          playGameTone('stage', muted);
        }
      }

      // Throttle React elapsed timer display updates gently
      setElapsedMs(Math.floor(sim.elapsedMs / 100) * 100);
      drawScene();

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      stopLoop();
    };
  }, [drawScene, gameState, muted, stopLoop]);

  const toLogicalPoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: CRATER_CX, y: CRATER_CY };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * LOGICAL_W,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * LOGICAL_H,
    };
  };

  const handleClearDebrisAt = useCallback(
    (x: number, y: number) => {
      const sim = simRef.current;
      if (sim.stage !== 'prep') return;
      let hit = false;
      for (const chunk of sim.debris) {
        if (chunk.cleared) continue;
        const dist = Math.hypot(x - chunk.x, y - chunk.y);
        if (dist <= chunk.r + 18) {
          chunk.cleared = true;
          hit = true;
        }
      }
      if (hit) {
        playGameTone('tap', muted);
        const clearedCount = sim.debris.filter((d) => d.cleared).length;
        setStageProgressText(`${clearedCount} / ${sim.debris.length} debris`);
        if (clearedCount === sim.debris.length) {
          sim.stage = 'pour';
          setStage('pour');
          setStageProgressText('Hold to pour (85–100%)');
          playGameTone('stage', muted);
        }
      }
    },
    [muted]
  );

  const lockPourStage = useCallback(() => {
    const sim = simRef.current;
    if (sim.stage !== 'pour') return;
    sim.isPouring = false;
    if (sim.pourLevel < 85) {
      // Allow player to keep pouring if released below threshold
      return;
    }
    const idealCenter = 93;
    const errorPct = Math.abs(sim.pourLevel - idealCenter);
    sim.pourPrecisionPoints =
      sim.pourLevel <= 102 ? Math.max(180, Math.round(280 - errorPct * 8)) : 140;
    sim.stage = 'fill';
    setStage('fill');
    setStageProgressText('0 / 5 tamped');
    playGameTone('stage', muted);
  }, [muted]);

  const handleTampAt = useCallback(
    (x: number, y: number) => {
      const sim = simRef.current;
      if (sim.stage !== 'fill') return;
      for (const spot of sim.tampSpots) {
        if (spot.tamped) continue;
        if (Math.hypot(x - spot.x, y - spot.y) <= 30) {
          spot.tamped = true;
          sim.ripple = { x: spot.x, y: spot.y, alpha: 1 };
          playGameTone('tap', muted);
          const count = sim.tampSpots.filter((s) => s.tamped).length;
          setStageProgressText(`${count} / ${sim.tampSpots.length} tamped`);
          if (count === sim.tampSpots.length) {
            sim.stage = 'smooth';
            setStage('smooth');
            setStageProgressText('0% smooth');
            playGameTone('stage', muted);
          }
          break;
        }
      }
    },
    [muted]
  );

  const advanceSmoothness = useCallback(
    (deltaPct: number) => {
      const sim = simRef.current;
      if (sim.stage !== 'smooth') return;
      sim.smoothness = Math.min(100, sim.smoothness + deltaPct);
      const rounded = Math.round(sim.smoothness);
      setSmoothness(rounded);
      setStageProgressText(`${rounded}% smooth`);
      if (sim.smoothness >= 100) {
        finishRepair();
      }
    },
    [finishRepair]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (gameState !== 'PLAYING') return;
    const pt = toLogicalPoint(e.clientX, e.clientY);
    const sim = simRef.current;
    sim.lastPointerPos = pt;
    sim.ripple = { x: pt.x, y: pt.y, alpha: 0.9 };

    if (sim.stage === 'prep') {
      handleClearDebrisAt(pt.x, pt.y);
    } else if (sim.stage === 'pour') {
      sim.isPouring = true;
    } else if (sim.stage === 'fill') {
      handleTampAt(pt.x, pt.y);
    } else if (sim.stage === 'smooth') {
      advanceSmoothness(10);
      playGameTone('tap', muted);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (gameState !== 'PLAYING') return;
    const pt = toLogicalPoint(e.clientX, e.clientY);
    const sim = simRef.current;

    if (sim.stage === 'prep' && e.buttons > 0) {
      handleClearDebrisAt(pt.x, pt.y);
    } else if (sim.stage === 'smooth' && (e.buttons > 0 || e.pointerType === 'touch')) {
      const insideCrater =
        Math.pow((pt.x - CRATER_CX) / (CRATER_RX + 20), 2) +
          Math.pow((pt.y - CRATER_CY) / (CRATER_RY + 20), 2) <=
        1;
      if (insideCrater && sim.lastPointerPos) {
        const dist = Math.hypot(pt.x - sim.lastPointerPos.x, pt.y - sim.lastPointerPos.y);
        if (dist > 3) {
          advanceSmoothness(Math.min(8, dist * 0.28));
        }
      }
    }
    sim.lastPointerPos = pt;
  };

  const handlePointerUp = () => {
    const sim = simRef.current;
    sim.lastPointerPos = null;
    if (sim.stage === 'pour' && sim.isPouring) {
      lockPourStage();
    }
  };

  // Accessible assist action (Keyboard & one-tap fallback)
  const triggerAssistAction = useCallback(
    (holdingPour?: boolean) => {
      if (gameState !== 'PLAYING') return;
      const sim = simRef.current;
      if (sim.stage === 'prep') {
        const next = sim.debris.find((d) => !d.cleared);
        if (next) {
          sim.ripple = { x: next.x, y: next.y, alpha: 1 };
          handleClearDebrisAt(next.x, next.y);
        }
      } else if (sim.stage === 'pour') {
        if (holdingPour === true) {
          sim.isPouring = true;
        } else if (holdingPour === false) {
          lockPourStage();
        } else {
          sim.pourLevel = Math.min(115, sim.pourLevel + 16);
          setPourLevel(Math.round(sim.pourLevel));
          setStageProgressText(`${Math.round(sim.pourLevel)}% filled (target 85–100%)`);
          playGameTone('tap', muted);
          if (sim.pourLevel >= 85) {
            lockPourStage();
          }
        }
      } else if (sim.stage === 'fill') {
        const nextSpot = sim.tampSpots.find((s) => !s.tamped);
        if (nextSpot) {
          handleTampAt(nextSpot.x, nextSpot.y);
        }
      } else if (sim.stage === 'smooth') {
        playGameTone('tap', muted);
        advanceSmoothness(20);
      }
    },
    [advanceSmoothness, gameState, handleClearDebrisAt, handleTampAt, lockPourStage, muted]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (gameState !== 'PLAYING') return;
      if (e.code === 'KeyP' || e.code === 'Escape') {
        setGameState('PAUSED');
        return;
      }
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (simRef.current.stage === 'pour') {
          simRef.current.isPouring = true;
        } else {
          triggerAssistAction();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (gameState !== 'PLAYING') return;
      if ((e.code === 'Space' || e.code === 'Enter') && simRef.current.stage === 'pour') {
        lockPourStage();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gameState, lockPourStage, triggerAssistAction]);

  const stageMeta = STAGE_LABELS[stage];

  return (
    <div className="bg-white rounded-2xl border border-[#E8DFC5] p-4 sm:p-6 space-y-4">
      {/* Unobtrusive Top HUD */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#E8DFC5]">
        <div>
          <h2 className="font-display text-lg sm:text-xl font-bold text-[#2D2B35]">
            Pothole Repair Crew
          </h2>
          <p className="text-xs text-[#6E6978]">
            {gameState === 'PLAYING'
              ? `Step ${stageMeta.step}/4 · ${stageMeta.title}: ${stageMeta.instruction}`
              : '4-step Atlanta street crew repair challenge: Prep, Pour, Tamp, and Smooth.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono tabular-nums text-[#2D2B35]">
            {(elapsedMs / 1000).toFixed(1)}s
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono tabular-nums text-[#4CB729] font-bold">
            Best: {highScore}
          </div>
          {gameState === 'PLAYING' || gameState === 'PAUSED' ? (
            <button
              type="button"
              onClick={() => setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : 'PLAYING'))}
              aria-label={gameState === 'PLAYING' ? 'Pause repair' : 'Resume repair'}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35]"
            >
              {gameState === 'PLAYING' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? 'Unmute sound effects' : 'Mute sound effects'}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35]"
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Stage Stepper Bar */}
      <div className="grid grid-cols-4 gap-2 text-xs">
        {(['prep', 'pour', 'fill', 'smooth'] as RepairStage[]).map((key, idx) => {
          const currentIdx = ['prep', 'pour', 'fill', 'smooth'].indexOf(stage);
          const done = gameState === 'ROUND_SUMMARY' || idx < currentIdx;
          const active = gameState === 'PLAYING' && idx === currentIdx;
          return (
            <div
              key={key}
              className={`rounded-xl px-2.5 py-2 border text-center font-semibold transition ${
                done
                  ? 'bg-[#4CB729]/10 border-[#4CB729]/40 text-[#2D2B35]'
                  : active
                    ? 'bg-[#2D2B35] border-[#2D2B35] text-white'
                    : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#6E6978]'
              }`}
            >
              {idx + 1}. {STAGE_LABELS[key].title.split(' ')[0]}
            </div>
          );
        })}
      </div>

      {/* Interactive Repair Canvas */}
      <div className="relative rounded-2xl overflow-hidden border border-[#E8DFC5] bg-[#3A3535]">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className="w-full aspect-[16/9.5] block touch-none select-none cursor-crosshair"
        />

        {gameState === 'TITLE_MENU' && (
          <div className="absolute inset-0 bg-[#2D2B35]/88 flex flex-col items-center justify-center p-6 text-center text-white space-y-4">
            <h3 className="font-display text-2xl font-extrabold">Ready to Patch Peachtree?</h3>
            <p className="text-xs sm:text-sm text-[#E8DFC5] max-w-md leading-relaxed">
              Clear loose gravel, pour hot asphalt mix to the green 85–100% mark, tamp all 5 seam
              pockets, and scrub the trowel flush.
            </p>
            <button
              type="button"
              onClick={startFreshRun}
              className="min-h-[48px] px-6 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white font-semibold text-sm inline-flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              <span>Start Repair Shift</span>
            </button>
          </div>
        )}

        {gameState === 'PAUSED' && (
          <div className="absolute inset-0 bg-[#2D2B35]/85 flex flex-col items-center justify-center p-6 text-center text-white space-y-4">
            <h3 className="font-display text-2xl font-bold">Repair Paused</h3>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setGameState('PLAYING')}
                className="min-h-[44px] px-5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold"
              >
                Resume
              </button>
              <button
                type="button"
                onClick={startFreshRun}
                className="min-h-[44px] px-5 py-2 rounded-xl border border-[#E8DFC5]/40 bg-white/10 hover:bg-white/20 text-white text-sm font-semibold"
              >
                Restart
              </button>
            </div>
          </div>
        )}

        {gameState === 'ROUND_SUMMARY' && summary && (
          <div className="absolute inset-0 bg-[#2D2B35]/92 flex flex-col items-center justify-center p-5 text-center text-white space-y-3">
            <div className="inline-flex items-center gap-2 text-[#4CB729] text-sm font-bold">
              <CheckCircle2 className="w-5 h-5" />
              <span>Surface Sealed · Grade {summary.grade}</span>
            </div>
            <div className="font-mono text-4xl font-extrabold tabular-nums">
              {summary.score} <span className="text-sm font-normal text-[#E8DFC5]">pts</span>
            </div>
            <div className="text-xs text-[#E8DFC5] font-mono tabular-nums">
              Pour: {summary.pourPercent}% · Precision +{summary.precisionBonus} · Speed +
              {summary.speedBonus} · {(summary.durationMs / 1000).toFixed(1)}s
            </div>
            <button
              type="button"
              onClick={startFreshRun}
              className="min-h-[46px] px-6 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold inline-flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Repair Another</span>
            </button>
          </div>
        )}
      </div>

      {/* Touch & Keyboard Assist Bar Below Canvas (never covers play surface) */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="text-xs font-mono text-[#4B4646] tabular-nums">
          Status: <span className="font-semibold text-[#2D2B35]">{stageProgressText}</span>
          {stage === 'pour' && ` · Pour gauge ${pourLevel}%`}
          {stage === 'smooth' && ` · Smoothness ${smoothness}%`}
        </div>

        {gameState === 'PLAYING' && (
          <div className="flex items-center gap-2">
            {stage === 'pour' ? (
              <button
                type="button"
                onPointerDown={() => triggerAssistAction(true)}
                onPointerUp={() => triggerAssistAction(false)}
                onPointerLeave={() => triggerAssistAction(false)}
                onPointerCancel={() => triggerAssistAction(false)}
                className="min-h-[48px] px-5 py-2.5 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-sm font-semibold touch-none select-none"
              >
                Hold to Pour Asphalt Mix
              </button>
            ) : (
              <button
                type="button"
                onClick={() => triggerAssistAction()}
                className="min-h-[48px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold"
              >
                {stage === 'prep'
                  ? 'Sweep Debris Chunk'
                  : stage === 'fill'
                    ? 'Tamp Next Seam'
                    : 'Smooth Trowel Pass'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

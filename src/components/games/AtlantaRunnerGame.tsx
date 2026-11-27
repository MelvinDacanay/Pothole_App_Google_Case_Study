import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { playGameTone } from '../../lib/gameAudio';

type RunnerState = 'TITLE_MENU' | 'PLAYING' | 'PAUSED' | 'GAME_OVER';
type ObstacleKind = 'pothole' | 'cone' | 'plate' | 'barrel';

interface Obstacle {
  id: number;
  kind: ObstacleKind;
  x: number;
  w: number;
  h: number;
  passed: boolean;
}

interface CollectibleKit {
  id: number;
  x: number;
  y: number;
  collected: boolean;
}

interface AtlantaRunnerGameProps {
  highScore: number;
  onCompleteRun: (score: number, durationMs: number) => void;
}

const LOGICAL_W = 720;
const LOGICAL_H = 360;
const GROUND_Y = 294;
const PLAYER_X = 96;
const GRAVITY = 1750;
const JUMP_VELOCITY = -640;

export const AtlantaRunnerGame: React.FC<AtlantaRunnerGameProps> = ({
  highScore,
  onCompleteRun,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);

  const [gameState, setGameState] = useState<RunnerState>('TITLE_MENU');
  const [muted, setMuted] = useState(true);
  const [hudScore, setHudScore] = useState(0);
  const [hudSpeed, setHudSpeed] = useState(1);
  const [finalStats, setFinalStats] = useState<{
    score: number;
    durationMs: number;
    obstaclesCleared: number;
  } | null>(null);

  const simRef = useRef<{
    playerY: number;
    playerVy: number;
    isGrounded: boolean;
    isDucking: boolean;
    jumpHeld: boolean;
    coyoteMs: number;
    speed: number;
    distanceScore: number;
    bonusScore: number;
    obstaclesCleared: number;
    elapsedMs: number;
    skyScroll: number;
    midScroll: number;
    roadScroll: number;
    martaX: number;
    nextSpawnIn: number;
    nextId: number;
    obstacles: Obstacle[];
    kits: CollectibleKit[];
    runAnimTimer: number;
  }>({
    playerY: GROUND_Y,
    playerVy: 0,
    isGrounded: true,
    isDucking: false,
    jumpHeld: false,
    coyoteMs: 0,
    speed: 270,
    distanceScore: 0,
    bonusScore: 0,
    obstaclesCleared: 0,
    elapsedMs: 0,
    skyScroll: 0,
    midScroll: 0,
    roadScroll: 0,
    martaX: 780,
    nextSpawnIn: 480,
    nextId: 1,
    obstacles: [],
    kits: [],
    runAnimTimer: 0,
  });

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const resetRun = useCallback(() => {
    stopLoop();
    simRef.current = {
      playerY: GROUND_Y,
      playerVy: 0,
      isGrounded: true,
      isDucking: false,
      jumpHeld: false,
      coyoteMs: 0,
      speed: 275,
      distanceScore: 0,
      bonusScore: 0,
      obstaclesCleared: 0,
      elapsedMs: 0,
      skyScroll: 0,
      midScroll: 0,
      roadScroll: 0,
      martaX: 780,
      nextSpawnIn: 460,
      nextId: 1,
      obstacles: [],
      kits: [],
      runAnimTimer: 0,
    };
    setHudScore(0);
    setHudSpeed(1);
    setFinalStats(null);
    setGameState('PLAYING');
    playGameTone('tap', muted);
  }, [muted, stopLoop]);

  const triggerJump = useCallback(() => {
    if (gameState === 'TITLE_MENU') {
      resetRun();
      return;
    }
    if (gameState !== 'PLAYING') return;

    const sim = simRef.current;
    sim.jumpHeld = true;
    sim.isDucking = false;
    if (sim.isGrounded || sim.coyoteMs > 0) {
      sim.playerVy = JUMP_VELOCITY;
      sim.isGrounded = false;
      sim.coyoteMs = 0;
      playGameTone('jump', muted);
    }
  }, [gameState, muted, resetRun]);

  const releaseJump = useCallback(() => {
    const sim = simRef.current;
    sim.jumpHeld = false;
    if (sim.playerVy < -240) {
      sim.playerVy = -240;
    }
  }, []);

  const setDuck = useCallback((ducking: boolean) => {
    const sim = simRef.current;
    sim.isDucking = ducking;
    if (ducking && !sim.isGrounded && sim.playerVy < 320) {
      sim.playerVy = 320;
    }
  }, []);

  // Draw crisp pixel-art Atlanta skyline with Bank of America Plaza landmark
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (canvas.width !== LOGICAL_W || canvas.height !== LOGICAL_H) {
      canvas.width = LOGICAL_W;
      canvas.height = LOGICAL_H;
    }
    ctx.imageSmoothingEnabled = false;

    const sim = simRef.current;

    // 1. Pixel Sky Gradient Band (crisp horizontal pixel bands)
    const skyBands = ['#1F2436', '#2B324B', '#3B4261', '#515474', '#726A82', '#9A7D82'];
    const bandH = Math.ceil((GROUND_Y - 30) / skyBands.length);
    skyBands.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(0, i * bandH, LOGICAL_W, bandH);
    });

    // Subtle pixel stars in upper sky
    ctx.fillStyle = '#E8DFC5';
    const stars = [
      [64, 24],
      [148, 42],
      [230, 18],
      [392, 28],
      [486, 46],
      [612, 20],
      [678, 38],
    ];
    for (const [sx, sy] of stars) {
      ctx.fillRect(sx, sy, 3, 3);
    }

    // 2. Parallax Far Atlanta Skyline + Iconic Bank of America Plaza Obelisk
    const farTileW = 720;
    const farOffset = -Math.floor(sim.skyScroll % farTileW);

    const drawSkylineTile = (ox: number) => {
      // Westin Peachtree Plaza (iconic cylinder + top disc)
      ctx.fillStyle = '#25293A';
      ctx.fillRect(ox + 68, 128, 44, GROUND_Y - 128);
      ctx.fillStyle = '#33394F';
      ctx.fillRect(ox + 74, 120, 32, 8);
      ctx.fillRect(ox + 86, 100, 4, 20);

      // Midtown block tower
      ctx.fillStyle = '#292D40';
      ctx.fillRect(ox + 132, 152, 54, GROUND_Y - 152);
      ctx.fillStyle = '#4B536E';
      for (let wy = 162; wy < 238; wy += 12) {
        ctx.fillRect(ox + 140, wy, 38, 4);
      }

      // 191 Peachtree double-crown silhouette
      ctx.fillStyle = '#232738';
      ctx.fillRect(ox + 212, 134, 48, GROUND_Y - 134);
      ctx.fillRect(ox + 216, 120, 14, 14);
      ctx.fillRect(ox + 242, 120, 14, 14);

      // BANK OF AMERICA PLAZA (Hero Atlanta Landmark: stepped rose-granite tower, illuminated crown pyramid & pencil spire)
      const boaX = ox + 324;
      // Lower & mid stepped granite shaft
      ctx.fillStyle = '#332A38';
      ctx.fillRect(boaX, 114, 58, GROUND_Y - 114);
      // Center recessed tower fin
      ctx.fillStyle = '#473647';
      ctx.fillRect(boaX + 10, 90, 38, GROUND_Y - 90);
      // Warm vertical architectural window ribs
      ctx.fillStyle = '#E8DFC5';
      for (let ry = 104; ry < 246; ry += 10) {
        ctx.fillRect(boaX + 16, ry, 4, 5);
        ctx.fillRect(boaX + 27, ry, 4, 5);
        ctx.fillRect(boaX + 38, ry, 4, 5);
      }
      // Illuminated stepped pyramidal lattice crown
      ctx.fillStyle = '#F59E0B';
      ctx.fillRect(boaX + 14, 78, 30, 12);
      ctx.fillRect(boaX + 19, 64, 20, 14);
      ctx.fillRect(boaX + 23, 52, 12, 12);
      // Inner crown dark lattice
      ctx.fillStyle = '#2D2B35';
      ctx.fillRect(boaX + 20, 72, 18, 14);
      // Signature Pencil Obelisk Spire piercing the Atlanta sky
      ctx.fillStyle = '#FDE68A';
      ctx.fillRect(boaX + 27, 22, 4, 30);
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(boaX + 28, 17, 2, 5); // Aviation beacon

      // Truist / SunTrust tiered tower
      ctx.fillStyle = '#262B3D';
      ctx.fillRect(ox + 428, 128, 50, GROUND_Y - 128);
      ctx.fillRect(ox + 436, 114, 34, 14);
      ctx.fillStyle = '#D97706';
      ctx.fillRect(ox + 438, 124, 30, 3);

      // Georgia-Pacific stepped slab
      ctx.fillStyle = '#2D3042';
      ctx.fillRect(ox + 520, 146, 62, GROUND_Y - 146);
      ctx.fillRect(ox + 532, 134, 42, 12);

      // Colony Square / Ponce mid-rise
      ctx.fillStyle = '#242736';
      ctx.fillRect(ox + 616, 166, 56, GROUND_Y - 166);
      ctx.fillStyle = '#4CB729';
      ctx.fillRect(ox + 626, 172, 36, 4);
    };

    drawSkylineTile(farOffset);
    drawSkylineTile(farOffset + farTileW);

    // 3. Elevated MARTA Viaduct & Canopy Trees (Mid Parallax)
    ctx.fillStyle = '#4B4646';
    ctx.fillRect(0, 232, LOGICAL_W, 10);
    const midOffset = -Math.floor(sim.midScroll % 120);
    for (let px = midOffset; px < LOGICAL_W + 120; px += 120) {
      // Concrete viaduct pillars
      ctx.fillStyle = '#3A3535';
      ctx.fillRect(px + 12, 242, 14, GROUND_Y - 242);

      // Atlanta green tree canopy clusters
      ctx.fillStyle = '#2B7A18';
      ctx.fillRect(px + 48, 250, 40, 34);
      ctx.fillStyle = '#4CB729';
      ctx.fillRect(px + 54, 242, 28, 22);
      ctx.fillStyle = '#3A3535';
      ctx.fillRect(px + 65, 280, 6, 14);
    }

    // Passing pixel MARTA railcar on elevated line
    ctx.fillStyle = '#E8DFC5';
    ctx.fillRect(Math.floor(sim.martaX), 218, 92, 14);
    ctx.fillStyle = '#2563EB';
    ctx.fillRect(Math.floor(sim.martaX), 226, 92, 3);
    ctx.fillStyle = '#D97706';
    ctx.fillRect(Math.floor(sim.martaX), 229, 92, 2);

    // 4. Foreground Peachtree Asphalt Road & Sidewalk Curb
    ctx.fillStyle = '#E8DFC5';
    ctx.fillRect(0, GROUND_Y - 8, LOGICAL_W, 8);
    ctx.fillStyle = '#2D2B35';
    ctx.fillRect(0, GROUND_Y, LOGICAL_W, LOGICAL_H - GROUND_Y);

    // Scrolling dashed yellow-sand lane stripe
    const roadOffset = -Math.floor(sim.roadScroll % 72);
    ctx.fillStyle = '#E8DFC5';
    for (let rx = roadOffset; rx < LOGICAL_W + 72; rx += 72) {
      ctx.fillRect(rx, GROUND_Y + 26, 38, 6);
    }

    // 5. Obstacles (Potholes, Cones, Steel Road Plates, Barrels)
    for (const obs of sim.obstacles) {
      const ox = Math.floor(obs.x);
      if (obs.kind === 'pothole') {
        // Jagged sunken crater on road deck
        ctx.fillStyle = '#141319';
        ctx.fillRect(ox, GROUND_Y - 2, obs.w, 18);
        ctx.fillStyle = '#6E6978';
        ctx.fillRect(ox - 3, GROUND_Y - 2, 4, 6);
        ctx.fillRect(ox + obs.w - 1, GROUND_Y - 2, 4, 6);
        ctx.fillStyle = '#DC2626';
        ctx.fillRect(ox + 6, GROUND_Y + 12, obs.w - 12, 3);
      } else if (obs.kind === 'cone') {
        // Pixel construction cone
        ctx.fillStyle = '#EA580C';
        ctx.fillRect(ox + 2, GROUND_Y - 6, obs.w - 4, 6);
        ctx.fillRect(ox + 6, GROUND_Y - 18, obs.w - 12, 12);
        ctx.fillRect(ox + 10, GROUND_Y - 28, obs.w - 20, 10);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(ox + 7, GROUND_Y - 18, obs.w - 14, 5);
      } else if (obs.kind === 'plate') {
        // Raised steel road plate with caution band
        ctx.fillStyle = '#6E6978';
        ctx.fillRect(ox, GROUND_Y - obs.h, obs.w, obs.h);
        ctx.fillStyle = '#F59E0B';
        ctx.fillRect(ox + 4, GROUND_Y - obs.h + 3, obs.w - 8, 4);
      } else {
        // Striped work-zone barrel
        ctx.fillStyle = '#EA580C';
        ctx.fillRect(ox, GROUND_Y - obs.h, obs.w, obs.h);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(ox + 2, GROUND_Y - obs.h + 8, obs.w - 4, 6);
        ctx.fillRect(ox + 2, GROUND_Y - obs.h + 22, obs.w - 4, 6);
      }
    }

    // 6. Collectible PatchUp Gold Repair Kits
    for (const kit of sim.kits) {
      if (kit.collected) continue;
      const kx = Math.floor(kit.x);
      const ky = Math.floor(kit.y);
      ctx.fillStyle = '#4CB729';
      ctx.fillRect(kx, ky, 18, 18);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.strokeRect(kx, ky, 18, 18);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(kx + 7, ky + 4, 4, 10);
      ctx.fillRect(kx + 4, ky + 7, 10, 4);
    }

    // 7. Pixel-Art PatchUp Street Scout Runner
    const py = Math.floor(sim.playerY);
    const ducking = sim.isDucking && sim.isGrounded;
    const stride = Math.floor(sim.runAnimTimer * 10) % 2;

    if (ducking) {
      // Compact ducking stance
      ctx.fillStyle = '#2D2B35';
      ctx.fillRect(PLAYER_X, py - 24, 30, 18);
      ctx.fillStyle = '#4CB729';
      ctx.fillRect(PLAYER_X + 4, py - 22, 20, 12);
      ctx.fillStyle = '#E8DFC5';
      ctx.fillRect(PLAYER_X + 20, py - 28, 10, 10);
      ctx.fillStyle = '#111827';
      ctx.fillRect(PLAYER_X + 4, py - 6, 8, 6);
      ctx.fillRect(PLAYER_X + 18, py - 6, 8, 6);
    } else {
      // Legs / stride pixels
      ctx.fillStyle = '#1F2937';
      if (sim.isGrounded) {
        ctx.fillRect(PLAYER_X + (stride === 0 ? 6 : 12), py - 14, 6, 14);
        ctx.fillRect(PLAYER_X + (stride === 0 ? 16 : 8), py - 14, 6, 14);
      } else {
        ctx.fillRect(PLAYER_X + 6, py - 16, 7, 12);
        ctx.fillRect(PLAYER_X + 16, py - 12, 7, 10);
      }
      // PatchUp High-Vis Vest torso
      ctx.fillStyle = '#4CB729';
      ctx.fillRect(PLAYER_X + 4, py - 34, 20, 20);
      ctx.fillStyle = '#E8DFC5';
      ctx.fillRect(PLAYER_X + 4, py - 26, 20, 4);
      // Head & Helmet
      ctx.fillStyle = '#FDBA74';
      ctx.fillRect(PLAYER_X + 7, py - 46, 14, 12);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(PLAYER_X + 5, py - 50, 18, 6);
      ctx.fillStyle = '#4CB729';
      ctx.fillRect(PLAYER_X + 11, py - 52, 6, 3);
    }
  }, []);

  // Game Loop with strict cancelAnimationFrame teardown
  useEffect(() => {
    drawFrame();
    if (gameState !== 'PLAYING') {
      stopLoop();
      return;
    }

    lastFrameRef.current = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - lastFrameRef.current) / 1000));
      lastFrameRef.current = now;

      const sim = simRef.current;
      sim.elapsedMs += dt * 1000;
      sim.runAnimTimer += dt;

      // Progressive speed increase (starts 275 px/s -> caps around 560 px/s)
      sim.speed = Math.min(560, 275 + sim.elapsedMs * 0.0045);

      // Parallax scrolls
      sim.skyScroll += sim.speed * 0.14 * dt;
      sim.midScroll += sim.speed * 0.42 * dt;
      sim.roadScroll += sim.speed * dt;
      sim.martaX -= (sim.speed * 0.65 + 75) * dt;
      if (sim.martaX < -120) {
        sim.martaX = LOGICAL_W + 240;
      }

      // Player jump physics + coyote time
      if (sim.isGrounded) {
        sim.coyoteMs = 85;
      } else {
        sim.coyoteMs = Math.max(0, sim.coyoteMs - dt * 1000);
        sim.playerVy += GRAVITY * dt;
        sim.playerY += sim.playerVy * dt;
        if (sim.playerY >= GROUND_Y) {
          sim.playerY = GROUND_Y;
          sim.playerVy = 0;
          sim.isGrounded = true;
        }
      }

      // Spawn obstacles
      sim.nextSpawnIn -= sim.speed * dt;
      if (sim.nextSpawnIn <= 0) {
        const roll = Math.random();
        const kind: ObstacleKind =
          roll < 0.34 ? 'pothole' : roll < 0.64 ? 'cone' : roll < 0.84 ? 'plate' : 'barrel';
        const w = kind === 'pothole' ? 42 : kind === 'plate' ? 46 : kind === 'barrel' ? 28 : 28;
        const h = kind === 'pothole' ? 12 : kind === 'plate' ? 16 : kind === 'barrel' ? 38 : 30;
        const spawnX = LOGICAL_W + 24;
        sim.obstacles.push({
          id: sim.nextId++,
          kind,
          x: spawnX,
          w,
          h,
          passed: false,
        });

        // 45% chance to spawn a bonus kit above obstacle arc
        if (Math.random() < 0.45) {
          sim.kits.push({
            id: sim.nextId++,
            x: spawnX + 6,
            y: GROUND_Y - 92,
            collected: false,
          });
        }

        const minGap = Math.max(230, 340 - (sim.speed - 275) * 0.25);
        sim.nextSpawnIn = minGap + Math.random() * 170;
      }

      // Move & check obstacle collisions
      const pLeft = PLAYER_X + 6;
      const pRight = PLAYER_X + 22;
      const pBottom = sim.playerY;
      const pTop = sim.isDucking && sim.isGrounded ? sim.playerY - 22 : sim.playerY - 44;

      let crashed = false;
      for (const obs of sim.obstacles) {
        obs.x -= sim.speed * dt;
        if (!obs.passed && obs.x + obs.w < PLAYER_X) {
          obs.passed = true;
          sim.obstaclesCleared += 1;
          sim.bonusScore += 15;
        }

        const oLeft = obs.x + 4;
        const oRight = obs.x + obs.w - 4;
        const oTop = obs.kind === 'pothole' ? GROUND_Y - 4 : GROUND_Y - obs.h + 4;
        const oBottom = GROUND_Y + 6;

        // For potholes, crash only if feet are grounded inside the crater span
        if (obs.kind === 'pothole') {
          if (pRight > oLeft && pLeft < oRight && pBottom >= GROUND_Y - 2) {
            crashed = true;
          }
        } else if (pRight > oLeft && pLeft < oRight && pBottom > oTop && pTop < oBottom) {
          crashed = true;
        }
      }
      sim.obstacles = sim.obstacles.filter((o) => o.x + o.w > -40);

      // Collectibles
      for (const kit of sim.kits) {
        kit.x -= sim.speed * dt;
        if (
          !kit.collected &&
          pRight > kit.x &&
          pLeft < kit.x + 18 &&
          pBottom > kit.y &&
          pTop < kit.y + 18
        ) {
          kit.collected = true;
          sim.bonusScore += 25;
          playGameTone('collect', muted);
        }
      }
      sim.kits = sim.kits.filter((k) => !k.collected && k.x > -30);

      sim.distanceScore = Math.floor((sim.elapsedMs / 1000) * 12);
      const totalScore = Math.min(50000, sim.distanceScore + sim.bonusScore);

      if (crashed) {
        playGameTone('crash', muted);
        const safeDuration = Math.max(1500, Math.round(sim.elapsedMs));
        setHudScore(totalScore);
        setFinalStats({
          score: totalScore,
          durationMs: safeDuration,
          obstaclesCleared: sim.obstaclesCleared,
        });
        setGameState('GAME_OVER');
        drawFrame();
        onCompleteRun(totalScore, safeDuration);
        return;
      }

      setHudScore(totalScore);
      setHudSpeed(Number((sim.speed / 275).toFixed(1)));
      drawFrame();
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      stopLoop();
    };
  }, [drawFrame, gameState, muted, onCompleteRun, stopLoop]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        if (gameState === 'PLAYING' || gameState === 'TITLE_MENU') {
          e.preventDefault();
          triggerJump();
        } else if (gameState === 'GAME_OVER') {
          e.preventDefault();
          resetRun();
        }
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        if (gameState === 'PLAYING') {
          e.preventDefault();
          setDuck(true);
        }
      } else if ((e.code === 'KeyP' || e.code === 'Escape') && (gameState === 'PLAYING' || gameState === 'PAUSED')) {
        setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : 'PLAYING'));
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        releaseJump();
      } else if (e.code === 'ArrowDown' || e.code === 'KeyS') {
        setDuck(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [gameState, releaseJump, resetRun, setDuck, triggerJump]);

  return (
    <div className="bg-[#fffaf0] p-4 sm:p-6 space-y-4 [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-[#39a9df]">
      {/* Unobtrusive Top HUD */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#E8DFC5]">
        <div>
          <h2 className="font-display text-lg sm:text-xl font-bold text-[#2D2B35]">
            Peachtree Sprint
          </h2>
          <p className="text-sm text-slate-600">
            Dodge potholes, cones & steel plates beneath Peachtree’s Bank of America Plaza skyline.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono tabular-nums text-[#2D2B35]">
            Score: <span className="font-bold">{hudScore}</span>
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono tabular-nums text-[#6E6978]">
            {hudSpeed.toFixed(1)}x
          </div>
          <div className="px-3 py-1.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono tabular-nums text-[#4CB729] font-bold">
            Best: {Math.max(highScore, hudScore)}
          </div>
          {gameState === 'PLAYING' || gameState === 'PAUSED' ? (
            <button
              type="button"
              onClick={() => setGameState((prev) => (prev === 'PLAYING' ? 'PAUSED' : 'PLAYING'))}
              aria-label={gameState === 'PLAYING' ? 'Pause runner' : 'Resume runner'}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35]"
            >
              {gameState === 'PLAYING' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? 'Unmute sound effects' : 'Mute sound effects'}
            aria-pressed={!muted}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35]"
          >
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Pixel-Art Runner Canvas */}
      <div className="relative overflow-hidden border-2 border-[#24212b] bg-[#1F2436]">
        <canvas
          ref={canvasRef}
          aria-label="Peachtree Sprint: jump over street hazards. Use the Jump button or Space, and Tuck or the down arrow."
          onPointerDown={triggerJump}
          onPointerUp={releaseJump}
          onPointerCancel={releaseJump}
          className="w-full aspect-[2/1] block touch-none select-none cursor-pointer"
        />

        {gameState === 'TITLE_MENU' && (
          <div className="absolute inset-0 overflow-y-auto bg-[#24212b]/95 flex flex-col items-center justify-center p-4 text-center text-white space-y-3">
            <h3 className="font-display text-xl sm:text-3xl font-extrabold">RUN THE CITY.</h3>
            <p className="text-sm text-[#E8DFC5] max-w-md">
              Tap, click, or press Space / ArrowUp to leap over potholes and cones. Grab green repair
              kits for +25 bonus points!
            </p>
            <button
              type="button"
              onClick={resetRun}
              className="min-h-[48px] px-6 py-2.5 bg-[#f4c52f] hover:bg-[#fbd65c] text-[#24212b] font-semibold text-sm inline-flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              <span>Start Run</span>
            </button>
          </div>
        )}

        {gameState === 'PAUSED' && (
          <div className="absolute inset-0 bg-[#1F2436]/82 flex flex-col items-center justify-center p-5 text-center text-white space-y-4">
            <h3 className="font-display text-2xl font-bold">Run Paused</h3>
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
                onClick={resetRun}
                className="min-h-[44px] px-5 py-2 rounded-xl border border-[#E8DFC5]/40 bg-white/10 hover:bg-white/20 text-white text-sm font-semibold"
              >
                Restart
              </button>
            </div>
          </div>
        )}

        {gameState === 'GAME_OVER' && finalStats && (
          <div className="absolute inset-0 bg-[#1F2436]/88 flex flex-col items-center justify-center p-5 text-center text-white space-y-3">
            <div className="text-xs font-semibold text-[#F59E0B]">Hazard Hit!</div>
            <div className="font-mono text-4xl font-extrabold tabular-nums">
              {finalStats.score} <span className="text-sm font-normal text-[#E8DFC5]">pts</span>
            </div>
            <div className="text-xs text-[#E8DFC5] font-mono tabular-nums">
              Hazards cleared: {finalStats.obstaclesCleared} · Time:{' '}
              {(finalStats.durationMs / 1000).toFixed(1)}s
            </div>
            <button
              type="button"
              onClick={resetRun}
              className="min-h-[46px] px-6 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold inline-flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Run Again</span>
            </button>
          </div>
        )}
      </div>

      {/* Dedicated Mobile Touch Controls & Keyboard Hint */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-[#6E6978]">
          Controls: Tap canvas / <span className="font-mono">Space</span> /{' '}
          <span className="font-mono">↑</span> to Jump · <span className="font-mono">↓</span> to
          Tuck
        </span>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onPointerDown={() => setDuck(true)}
            onPointerUp={() => setDuck(false)}
            onPointerLeave={() => setDuck(false)}
            onPointerCancel={() => setDuck(false)}
            disabled={gameState !== 'PLAYING'}
            className="flex-1 sm:flex-initial min-h-[50px] px-5 py-2.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 touch-none select-none"
          >
            <ArrowDown className="w-4 h-4" />
            <span>Tuck</span>
          </button>
          <button
            type="button"
            onPointerDown={triggerJump}
            onPointerUp={releaseJump}
            onPointerLeave={releaseJump}
            onPointerCancel={releaseJump}
            className="flex-1 sm:flex-initial min-h-[50px] px-7 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold inline-flex items-center justify-center gap-2 touch-none select-none"
          >
            <ArrowUp className="w-4 h-4" />
            <span>{gameState === 'PLAYING' ? 'Jump' : gameState === 'GAME_OVER' ? 'Run Again' : 'Jump / Start'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

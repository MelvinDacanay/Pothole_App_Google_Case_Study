import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Car, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { playGameTone } from '../../lib/gameAudio';

type Mode = 'crater_blitz' | 'connector_cruise';
type Phase = 'ready' | 'playing' | 'paused' | 'done';
type Hazard = { id: number; lane: number; y: number };
type Round = { elapsed: number; score: number; hits: number; lane: number; target: number; cone: number; next: number; hazards: Hazard[]; serial: number };
const fresh = (): Round => ({ elapsed: 0, score: 0, hits: 0, lane: 1, target: 4, cone: 0, next: 800, hazards: [], serial: 0 });
const keys = ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];
const control = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 border border-[#b6ac98] px-4 py-2 text-sm font-bold focus-visible:ring-2 focus-visible:ring-[#39a9df] disabled:cursor-not-allowed';

export function StreetChallengeGame({ mode, highScore, onCompleteRun }: {
  mode: Mode; highScore: number; onCompleteRun: (score: number, duration: number) => void;
}) {
  const blitz = mode === 'crater_blitz';
  const model = useRef<Round>(fresh());
  const [view, setView] = useState<Round>(fresh);
  const [phase, setPhase] = useState<Phase>('ready');
  const [muted, setMuted] = useState(true);
  const phaseRef = useRef<Phase>('ready');
  const completeRef = useRef(onCompleteRun);
  completeRef.current = onCompleteRun;
  const startButton = useRef<HTMLButtonElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const setStatus = useCallback((next: Phase) => { phaseRef.current = next; setPhase(next); }, []);

  const nextTarget = useCallback(() => {
    const state = model.current;
    const choices = Array.from({ length: 9 }, (_, i) => i).filter((i) => i !== state.target);
    state.target = choices[Math.floor(Math.random() * choices.length)];
    state.cone = (state.target + 1 + Math.floor(Math.random() * 8)) % 9;
  }, []);

  const start = () => {
    model.current = fresh();
    nextTarget();
    setView({ ...model.current });
    setStatus('playing');
    board.current?.focus();
  };
  const act = useCallback((value: number) => {
    if (phaseRef.current !== 'playing') return;
    const state = model.current;
    if (!blitz) {
      state.lane = Math.max(0, Math.min(2, state.lane + value));
      playGameTone('lane', muted);
    } else if (value === state.target) {
      state.score = Math.min(6000, state.score + 50);
      nextTarget();
      state.next = state.elapsed + Math.max(600, 1300 - state.elapsed / 50);
      playGameTone('collect', muted);
    } else if (value === state.cone) {
      state.score = Math.max(0, state.score - 25);
      playGameTone('penalty', muted);
    }
    setView({ ...state, hazards: [...state.hazards] });
  }, [blitz, muted, nextTarget]);

  useEffect(() => {
    if (phase !== 'playing') return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      if (phaseRef.current !== 'playing') return;
      const now = performance.now();
      const dt = Math.min(100, now - previous);
      previous = now;
      const state = model.current;
      state.elapsed += dt;
      if (blitz && state.elapsed >= state.next) {
        nextTarget();
        state.next = state.elapsed + Math.max(600, 1300 - state.elapsed / 50);
      } else if (!blitz) {
        if (state.elapsed >= state.next) {
          state.hazards.push({ id: state.serial++, lane: Math.floor(Math.random() * 3), y: -10 });
          state.next = state.elapsed + Math.max(650, 1150 - state.elapsed / 70);
        }
        state.hazards = state.hazards.filter((hazard) => {
          const previousY = hazard.y;
          hazard.y += dt * (0.035 + state.elapsed / 1500000);
          if (previousY < 83 && hazard.y >= 83) {
            if (hazard.lane === state.lane) { state.hits++; playGameTone('penalty', muted); }
            else { state.score += 20; playGameTone('collect', muted); }
          }
          return hazard.y < 108;
        });
      }
      setView({ ...state, hazards: [...state.hazards] });
      if (state.elapsed >= 30000 || state.hits >= 3) {
        setStatus('done');
        playGameTone('win', muted);
        completeRef.current(state.score, Math.round(state.elapsed));
        window.setTimeout(() => startButton.current?.focus(), 0);
      }
    }, 40);
    return () => window.clearInterval(timer);
  }, [phase, blitz, muted, nextTarget, setStatus]);

  useEffect(() => {
    const hidden = () => { if (document.hidden && phaseRef.current === 'playing') setStatus('paused'); };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [setStatus]);

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && phaseRef.current === 'playing') { event.preventDefault(); setStatus('paused'); }
    if (phaseRef.current !== 'playing') return;
    const key = event.key.toLowerCase();
    const index = keys.indexOf(key);
    if (blitz && index >= 0 && !event.repeat) { event.preventDefault(); act(index); }
    if (!blitz && ['arrowleft', 'arrowright', 'a', 'd'].includes(key)) {
      event.preventDefault(); act(['arrowleft', 'a'].includes(key) ? -1 : 1);
    }
  };
  const remaining = Math.max(0, Math.ceil((30000 - view.elapsed) / 1000));

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d5cbb8] pb-3">
        <div className="flex gap-5"><div><p className="text-xs font-bold text-slate-600">SCORE</p><strong className="font-data text-2xl">{view.score}</strong></div><div><p className="text-xs font-bold text-slate-600">TIME</p><strong className="font-data text-2xl">{remaining}s</strong></div>{!blitz && <div><p className="text-xs font-bold text-slate-600">TIRES LEFT</p><strong className="font-data text-2xl">{Math.max(0, 3 - view.hits)}</strong></div>}</div>
        <div className="flex gap-2">
          {['playing', 'paused'].includes(phase) && <button className={control} aria-label={phase === 'playing' ? 'Pause game' : 'Resume game'} onClick={() => { setStatus(phase === 'playing' ? 'paused' : 'playing'); board.current?.focus(); }}>{phase === 'playing' ? <Pause className="h-4 w-4 shrink-0" /> : <Play className="h-4 w-4 shrink-0" />}</button>}
          <button className={control} aria-label={muted ? 'Enable game sound' : 'Mute game sound'} aria-pressed={!muted} onClick={() => setMuted(!muted)}>{muted ? <VolumeX className="h-4 w-4 shrink-0" /> : <Volume2 className="h-4 w-4 shrink-0" />}</button>
        </div>
      </div>
      <div ref={board} tabIndex={0} onKeyDown={onKey} aria-label={blitz ? 'Pothole Blitz play area. Use Q W E, A S D, Z X C to patch the matching cell.' : 'Connector Cruise play area. Use left and right arrows to change lane.'} className="relative min-h-[340px] overflow-hidden border-2 border-[#24212b] bg-[#625b68] focus-visible:ring-4 focus-visible:ring-[#39a9df]">
        {blitz ? <div className="grid grid-cols-3 gap-3 p-4 sm:gap-4 sm:p-6">
          {keys.map((key, index) => <button key={key} disabled={phase !== 'playing'} onClick={() => act(index)} aria-label={`${key.toUpperCase()}: ${view.target === index ? 'patch pothole' : view.cone === index ? 'cone, avoid' : 'empty road'}`} className="relative flex h-24 min-h-11 items-center justify-center border border-[#aaa1a8] bg-[#514b57] focus-visible:ring-4 focus-visible:ring-[#f4c52f]">
            <span className="absolute left-2 top-1 text-xs font-bold uppercase text-white">{key}</span>
            {view.target === index ? <svg viewBox="0 0 100 60" className="h-16 w-24" aria-hidden="true"><path d="m8 26 14-8 4-8 20 4 17-7 12 9 17 7-7 11 6 10-22 5-16 6-19-8-21 1 3-11Z" fill="#24212b" stroke="#efbf99" strokeWidth="4" /><path d="m32 35 17-8 21 7-18 9Z" fill="#39a9df" /></svg> : view.cone === index ? <svg viewBox="0 0 70 70" className="h-16 w-16" aria-hidden="true"><path d="M13 60 30 10h10l17 50Z" fill="#f36a3d" stroke="#24212b" strokeWidth="3" /><path d="M23 35h24l4 10H19Z" fill="#fff3de" /><path d="M7 62h56" stroke="#24212b" strokeWidth="7" /></svg> : <span className="h-1 w-10 bg-[#d4ccb8]" />}
          </button>)}
        </div> : <div className="relative mx-auto h-[360px] w-full max-w-md border-x-8 border-[#e6d6b6]">
          <div className="absolute inset-y-0 left-1/3 border-l-4 border-dashed border-[#fff3de]" /><div className="absolute inset-y-0 left-2/3 border-l-4 border-dashed border-[#fff3de]" />
          <span className="absolute left-3 top-3 bg-[#17231d] px-3 py-1 text-xs font-bold text-white">DOWNTOWN CONNECTOR</span>
          {view.hazards.map((hazard) => <div key={hazard.id} className="absolute h-8 w-[22%] rounded-[50%] border-4 border-[#efbf99] bg-[#24212b]" style={{ top: `${hazard.y}%`, left: `${hazard.lane * 33.33 + 5.5}%` }} />)}
          <div className="absolute bottom-[6%] flex h-16 w-[22%] items-center justify-center rounded-lg border-4 border-[#24212b] bg-[#f4c52f]" style={{ left: `${view.lane * 33.33 + 5.5}%` }}><Car className="h-10 w-10 shrink-0 text-[#24212b]" aria-hidden="true" /></div>
        </div>}
        {phase !== 'playing' && <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#24212b]/95 p-5 text-center text-[#fff3de]">
          <span className="text-xs font-bold tracking-widest text-[#f4c52f]">{phase === 'done' ? 'SHIFT COMPLETE' : phase === 'paused' ? 'TAKE YOUR TIME' : 'A QUICK ATLANTA CHALLENGE'}</span>
          <h3 className="text-3xl">{phase === 'done' ? `${view.score} POINTS` : phase === 'paused' ? 'ON A BREAK.' : blitz ? 'PATCH THE BLOCK.' : 'STAY IN YOUR LANE.'}</h3>
          <p className="max-w-sm text-sm leading-6 text-slate-300">{phase === 'done' ? `Personal best: ${Math.max(highScore, view.score)}. Another round?` : phase === 'paused' ? 'Your timer is stopped. Pick up right where you left off.' : blitz ? 'Tap the dark potholes, not the orange cones. You’ve got 30 seconds.' : 'Move between three lanes to dodge potholes. Three hits and your shift is over.'}</p>
          <button ref={startButton} onClick={phase === 'paused' ? () => { setStatus('playing'); board.current?.focus(); } : start} className={`${control} border-[#f4c52f] bg-[#f4c52f] text-[#24212b]`}>{phase === 'done' ? <RotateCcw className="h-4 w-4 shrink-0" aria-hidden="true" /> : <Play className="h-4 w-4 shrink-0" aria-hidden="true" />}{phase === 'paused' ? 'Resume game' : phase === 'done' ? 'Play again' : 'Let’s play'}</button>
        </div>}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">{blitz ? '+50 per patch · −25 per cone' : '+20 per pothole avoided · Three tires, one run'}</p>
        {!blitz && <div className="flex gap-2"><button disabled={phase !== 'playing'} onClick={() => { act(-1); board.current?.focus(); }} aria-label="Move left" className={`${control} bg-[#f4c52f]`}><ArrowLeft className="h-5 w-5 shrink-0" aria-hidden="true" />Left</button><button disabled={phase !== 'playing'} onClick={() => { act(1); board.current?.focus(); }} aria-label="Move right" className={`${control} bg-[#f4c52f]`}>Right<ArrowRight className="h-5 w-5 shrink-0" aria-hidden="true" /></button></div>}
      </div>
      <p className="sr-only" role="status">{phase === 'done' ? `Game complete. ${view.score} points.` : phase === 'paused' ? 'Game paused.' : ''}</p>
    </div>
  );
}

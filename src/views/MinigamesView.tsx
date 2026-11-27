import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Car, Gamepad2, Hammer, Play, ShieldCheck, Target, Trophy, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { GameStatsMap, MinigameId, loadLocalGameStats, reconcileGameStatsFromServer, recordLocalGameRun, syncGameScoreWithServer } from '../lib/gameStats';
import { PotholeRepairGame } from '../components/games/PotholeRepairGame';
import { AtlantaRunnerGame } from '../components/games/AtlantaRunnerGame';
import { StreetChallengeGame } from '../components/games/StreetChallengeGame';

const GAMES = [
  { id: 'pothole_runner', title: 'Peachtree Sprint', genre: 'ENDLESS RUNNER', description: 'Big city. Quick feet. Hop the hazards and chase the Atlanta skyline.', color: '#39a9df', icon: Zap, controls: 'Space / ↑ to jump · ↓ to tuck', goal: 'Clear hazards, collect repair kits, and keep your run alive.' },
  { id: 'pothole_repair', title: 'Repair Crew', genre: 'PRECISION & TIMING', description: 'Clock in. Clear it out. Turn a rough patch into your best work.', color: '#f36a3d', icon: Hammer, controls: 'Tap or drag · Space for keyboard assist', goal: 'Clear, pour, tamp, and smooth. A precise pour earns a better grade.' },
  { id: 'crater_blitz', title: 'Pothole Blitz', genre: 'QUICK REFLEXES', description: 'Potholes pop up. You patch them. How many can you catch in 30 seconds?', color: '#f4c52f', icon: Target, controls: 'Tap a pothole · Keyboard Q W E / A S D / Z X C', goal: 'Patch the dark potholes for 50 points. Avoid orange cones: they cost 25.' },
  { id: 'connector_cruise', title: 'Connector Cruise', genre: 'LANE DODGER', description: 'Find your lane on the Downtown Connector. Keep those tires intact.', color: '#b4d59b', icon: Car, controls: '← → or A / D · On-screen lane buttons', goal: 'Dodge potholes for 30 seconds. Each one passed earns 20 points. Three hits end the run.' },
] as const;

function CabinetArt({ id, color }: { id: MinigameId; color: string }) {
  return (
    <svg viewBox="0 0 320 150" className="h-full w-full" aria-hidden="true">
      <rect width="320" height="150" fill={color} />
      <circle cx="267" cy="33" r="25" fill="#fff3de" />
      {id === 'pothole_runner' ? <>
        <path d="M0 115V78h30v37h15V51h24v64h14V67h31v48h15V36h12V18h6v18h12v79h18V61h28v54h14V80h40v35h61v35H0" fill="#24212b" />
        <path d="M0 128h320" stroke="#fff3de" strokeWidth="4" strokeDasharray="32 20" />
        <circle cx="111" cy="65" r="9" fill="#fff3de" /><path d="m110 77-7 20 18 10m-14-17-18 8m22-18 15 9m-8 15 11 15" fill="none" stroke="#f36a3d" strokeWidth="9" />
      </> : id === 'pothole_repair' ? <>
        <path d="M0 91 320 68v82H0Z" fill="#625b68" /><path d="m0 121 320-23" stroke="#fff3de" strokeWidth="4" strokeDasharray="35 23" />
        <ellipse cx="164" cy="102" rx="64" ry="25" fill="#24212b" stroke="#efbf99" strokeWidth="6" />
        <path d="m134 93 57 14m-49-22 56 14" stroke="#f4c52f" strokeWidth="5" />
        <path d="m168 74 32-41 17 10-32 42Z" fill="#fff3de" stroke="#24212b" strokeWidth="3" />
      </> : id === 'crater_blitz' ? <>
        <path d="M0 70h320v80H0Z" fill="#625b68" />
        {[65, 157, 249].map((x, i) => <g key={x}><ellipse cx={x} cy={100 + (i % 2) * 16} rx="31" ry="14" fill="#24212b" stroke="#efbf99" strokeWidth="4" /><path d={`m${x - 10} ${100 + (i % 2) * 16} 11-5 13 4-10 5Z`} fill="#39a9df" /></g>)}
        <path d="M150 25v22m-27-12 12 13m37-13-12 13" stroke="#24212b" strokeWidth="5" />
      </> : <>
        <path d="M97 0h126l69 150H28Z" fill="#625b68" />
        <path d="m139 0-16 150m58-150 16 150" stroke="#fff3de" strokeWidth="3" strokeDasharray="14 12" />
        <rect x="143" y="86" width="34" height="52" rx="7" fill="#f4c52f" stroke="#24212b" strokeWidth="3" /><rect x="148" y="95" width="24" height="15" fill="#24212b" />
        <ellipse cx="112" cy="49" rx="18" ry="8" fill="#24212b" stroke="#efbf99" strokeWidth="3" />
      </>}
    </svg>
  );
}

export const MinigamesView: React.FC<{ onBack?: () => void }> = ({ onBack }) => {
  const { user } = useAuth();
  const [active, setActive] = useState<MinigameId>('pothole_runner');
  const [stats, setStats] = useState<GameStatsMap>(loadLocalGameStats);
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState(0);
  const playArea = useRef<HTMLDivElement>(null);
  const selected = GAMES.find((game) => game.id === active)!;
  const totalRuns = Object.values(stats).reduce((sum, stat) => sum + stat.gamesPlayed, 0);
  const gamesPlayed = Object.values(stats).filter((stat) => stat.gamesPlayed > 0).length;

  useEffect(() => {
    let alive = true;
    const reconcile = () => {
      if (user) void reconcileGameStatsFromServer(user).then((next) => { if (alive) setStats(next); });
    };
    reconcile();
    window.addEventListener('online', reconcile);
    return () => { alive = false; window.removeEventListener('online', reconcile); };
  }, [user]);

  const complete = useCallback(async (id: MinigameId, score: number, duration: number) => {
    if (!user) {
      setStats(recordLocalGameRun(id, score, duration));
      setNotice('Personal best updated for this browser. Cloud backup requires a connected backend and sign-in.');
      return;
    }
    const result = syncGameScoreWithServer(user, id, score, duration);
    setStats(loadLocalGameStats());
    const next = await result;
    setStats(next);
    setNotice(next[id].synced ? 'Score backed up to your game record.' : 'Score kept in this browser. Cloud backup is unavailable; we’ll retry on reconnect or your next visit.');
  }, [user]);

  return (
    <div className="mx-auto max-w-6xl space-y-7 overflow-x-hidden pb-8 text-[#24212b]">
      <header className="relative overflow-hidden border-2 border-[#24212b] bg-[#24212b] text-[#fff3de] shadow-[6px_6px_0_#f4c52f]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#fff3de]/30 px-6 py-3 text-xs font-bold tracking-widest">
          <span className="flex items-center gap-2"><Gamepad2 className="h-5 w-5 shrink-0" aria-hidden="true" />PATCHUP • ATLANTA</span>
        </div>
        <div className="grid gap-7 p-6 sm:p-9 md:grid-cols-[1fr_auto] md:items-end">
          <div><p className="mb-3 text-sm font-semibold text-[#b4d59b]">TAKE A BREAK FROM THE BUMPS</p><h1 className="text-5xl leading-[.95] tracking-[-.05em] sm:text-7xl">STREET SMART.<br /><span className="text-[#f4c52f]">GAME ON.</span></h1><p className="mt-5 max-w-lg text-base leading-relaxed text-slate-300">Take up a little friendly competition in Patcher minigames!</p></div>
          <div className="flex gap-8 border-t border-[#fff3de]/30 pt-5 md:block md:space-y-5 md:border-l md:border-t-0 md:pl-8 md:pt-0">
            <div><strong className="font-data text-3xl">{totalRuns}</strong><p className="mt-1 text-sm text-slate-300">completed runs</p></div><div><strong className="font-data text-3xl">{gamesPlayed}<span className="text-lg"> / {GAMES.length}</span></strong><p className="mt-1 text-sm text-slate-300">games explored</p></div>
          </div>
        </div>
      </header>

      <section aria-labelledby="game-library">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 id="game-library" className="text-2xl tracking-tight">PICK YOUR PLAY.</h2><span className="text-sm text-slate-600">Quick breaks. Unlimited retries.</span></div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {GAMES.map((game) => <button key={game.id} aria-pressed={active === game.id} onClick={() => { setActive(game.id); setNotice(''); setSession((value) => value + 1); }} className={`group min-w-0 overflow-hidden border-2 border-[#24212b] bg-[#fffaf0] text-left transition hover:-translate-y-1 focus-visible:ring-4 focus-visible:ring-[#39a9df] motion-reduce:transform-none ${active === game.id ? 'shadow-[4px_4px_0_#24212b]' : ''}`}>
            <div className="relative h-32 overflow-hidden border-b-2 border-[#24212b]"><CabinetArt id={game.id} color={game.color} />{active === game.id && <span className="absolute bottom-2 left-2 bg-[#24212b] px-2 py-1 text-xs font-bold text-white">IN THE CABINET</span>}</div>
            <div className="space-y-3 p-4"><span className="text-xs font-bold tracking-wider text-slate-600">{game.genre}</span><h3 className="flex items-center justify-between gap-2 text-lg">{game.title}<ArrowUpRight className="h-5 w-5 shrink-0" aria-hidden="true" /></h3><p className="min-h-16 text-sm leading-5 text-slate-600">{game.description}</p><div className="flex items-center justify-between border-t border-[#d6cdbb] pt-3 text-xs"><span className="flex items-center gap-1.5"><Trophy className="h-4 w-4 shrink-0" aria-hidden="true" />Best {stats[game.id].highScore.toLocaleString()}</span><span>{stats[game.id].gamesPlayed} plays</span></div></div>
          </button>)}
        </div>
      </section>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_230px]">
        <div ref={playArea} tabIndex={-1} className="min-w-0 border-2 border-[#24212b] bg-[#24212b] p-2 shadow-[5px_5px_0_#24212b] sm:p-3">
          <div className="flex items-center justify-between gap-3 px-2 pb-3 pt-1 text-[#fff3de]"><span className="flex items-center gap-2 text-sm font-bold"><selected.icon className="h-5 w-5 shrink-0" aria-hidden="true" />{selected.title}</span><span className="text-xs text-[#f4c52f]">FREE PLAY</span></div>
          <div key={`${active}-${session}`} className="min-w-0 bg-[#fffaf0]">
            {active === 'pothole_repair' ? <PotholeRepairGame highScore={stats[active].highScore} onCompleteRun={(score, duration) => void complete(active, score, duration)} /> : active === 'pothole_runner' ? <AtlantaRunnerGame highScore={stats[active].highScore} onCompleteRun={(score, duration) => void complete(active, score, duration)} /> : <StreetChallengeGame mode={active} highScore={stats[active].highScore} onCompleteRun={(score, duration) => void complete(active, score, duration)} />}
          </div>
        </div>
        <aside className="space-y-5 border-2 border-[#24212b] bg-[#e9e0cd] p-5">
          <div><span className="text-xs font-bold tracking-widest text-slate-600">THE GAME PLAN</span><h2 className="mt-3 text-xl">{selected.title}</h2><p className="mt-3 text-sm leading-6">{selected.goal}</p></div>
          <div className="border-t border-[#b5ac9a] pt-4"><h3 className="font-sans text-sm font-bold">Your controls</h3><p className="mt-2 text-sm leading-6 text-slate-600">{selected.controls}</p></div>
          <div className="border-t border-[#b5ac9a] pt-4"><span className="flex items-center gap-2 text-sm font-bold"><ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" />Just for the fun of it.</span><p className="mt-2 text-sm leading-6 text-slate-600">Arcade scores never affect real pothole counts, community rankings, or reporting.</p></div>
        </aside>
      </div>
      {notice && <p role="status" className="border border-[#24212b] bg-[#e0ebd7] p-4 text-sm">{notice}</p>}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#c8beaa] pt-4 text-sm text-slate-600"><span className="flex items-center gap-2"><Play className="h-4 w-4 shrink-0" aria-hidden="true" />Touch-friendly. Keyboard-ready. Made for your next break.</span>{onBack && <button onClick={onBack} className="flex min-h-11 items-center gap-2 px-3 font-semibold focus-visible:ring-2"><ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />Back to the streets</button>}</footer>
    </div>
  );
};

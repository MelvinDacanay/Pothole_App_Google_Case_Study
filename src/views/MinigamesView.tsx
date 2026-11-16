import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Gamepad2, Hammer, Info, Trophy, Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  GameStatsMap,
  MinigameId,
  loadLocalGameStats,
  reconcileGameStatsFromServer,
  recordLocalGameRun,
  syncGameScoreWithServer,
} from '../lib/gameStats';
import { PotholeRepairGame } from '../components/games/PotholeRepairGame';
import { AtlantaRunnerGame } from '../components/games/AtlantaRunnerGame';

interface MinigamesViewProps {
  onBack: () => void;
}

export const MinigamesView: React.FC<MinigamesViewProps> = ({ onBack }) => {
  const { user } = useAuth();
  const [activeGame, setActiveGame] = useState<MinigameId>('pothole_repair');
  const [stats, setStats] = useState<GameStatsMap>(() => loadLocalGameStats());
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setStats(loadLocalGameStats());
      return;
    }
    reconcileGameStatsFromServer(user).then((merged) => {
      if (!cancelled) {
        setStats(merged);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleCompleteRun = useCallback(
    async (gameId: MinigameId, score: number, durationMs: number) => {
      if (!user) {
        const updated = recordLocalGameRun(gameId, score, durationMs);
        setStats(updated);
        setSyncNotice('Saved locally on this device (sign in anytime to back up personal bests).');
        return;
      }

      const immediate = recordLocalGameRun(gameId, score, durationMs);
      setStats(immediate);
      const synced = await syncGameScoreWithServer(user, gameId, score, durationMs);
      setStats(synced);
      setSyncNotice(
        synced[gameId].synced
          ? 'Score saved to your isolated game record.'
          : 'Saved offline — will sync automatically next time you are online.'
      );
    },
    [user]
  );

  const repairStat = stats.pothole_repair;
  const runnerStat = stats.pothole_runner;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>
            <div>
              <h1 className="font-display text-xl sm:text-2xl font-extrabold text-[#2D2B35] flex items-center gap-2">
                <Gamepad2 className="w-5 h-5 text-[#4CB729]" />
                <span>PatchUp Arcade</span>
              </h1>
              <p className="text-xs text-[#6E6978]">
                Two offline-playable Atlanta street minigames for quick breaks.
              </p>
            </div>
          </div>

          <div className="text-xs font-mono text-[#6E6978] tabular-nums">
            Total Runs:{' '}
            <span className="font-bold text-[#2D2B35]">
              {repairStat.gamesPlayed + runnerStat.gamesPlayed}
            </span>
          </div>
        </div>

        {/* Game Selector Tabs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              setSyncNotice(null);
              setActiveGame('pothole_repair');
            }}
            className={`text-left rounded-2xl border p-4 transition min-h-[76px] flex items-center justify-between gap-3 ${
              activeGame === 'pothole_repair'
                ? 'bg-[#2D2B35] border-[#2D2B35] text-white'
                : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#2D2B35] hover:bg-[#E8DFC5]/40'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  activeGame === 'pothole_repair'
                    ? 'bg-[#4CB729] text-white'
                    : 'bg-white border border-[#E8DFC5] text-[#4CB729]'
                }`}
              >
                <Hammer className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-display font-bold text-sm truncate">Pothole Repair Crew</div>
                <div
                  className={`text-xs truncate ${
                    activeGame === 'pothole_repair' ? 'text-[#E8DFC5]' : 'text-[#6E6978]'
                  }`}
                >
                  4-step touch repair · Prep, Pour, Tamp, Smooth
                </div>
              </div>
            </div>

            <div className="text-right shrink-0 font-mono tabular-nums">
              <div className="text-sm font-bold flex items-center justify-end gap-1">
                <Trophy className="w-3.5 h-3.5 text-[#4CB729]" />
                <span>{repairStat.highScore}</span>
              </div>
              <div
                className={`text-[11px] ${
                  activeGame === 'pothole_repair' ? 'text-[#E8DFC5]' : 'text-[#6E6978]'
                }`}
              >
                {repairStat.gamesPlayed} shifts
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setSyncNotice(null);
              setActiveGame('pothole_runner');
            }}
            className={`text-left rounded-2xl border p-4 transition min-h-[76px] flex items-center justify-between gap-3 ${
              activeGame === 'pothole_runner'
                ? 'bg-[#2D2B35] border-[#2D2B35] text-white'
                : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#2D2B35] hover:bg-[#E8DFC5]/40'
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                  activeGame === 'pothole_runner'
                    ? 'bg-[#4CB729] text-white'
                    : 'bg-white border border-[#E8DFC5] text-[#4CB729]'
                }`}
              >
                <Zap className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="font-display font-bold text-sm truncate">
                  Atlanta Pothole Runner
                </div>
                <div
                  className={`text-xs truncate ${
                    activeGame === 'pothole_runner' ? 'text-[#E8DFC5]' : 'text-[#6E6978]'
                  }`}
                >
                  Pixel Peachtree runner · Bank of America Plaza skyline
                </div>
              </div>
            </div>

            <div className="text-right shrink-0 font-mono tabular-nums">
              <div className="text-sm font-bold flex items-center justify-end gap-1">
                <Trophy className="w-3.5 h-3.5 text-[#4CB729]" />
                <span>{runnerStat.highScore}</span>
              </div>
              <div
                className={`text-[11px] ${
                  activeGame === 'pothole_runner' ? 'text-[#E8DFC5]' : 'text-[#6E6978]'
                }`}
              >
                {runnerStat.gamesPlayed} runs
              </div>
            </div>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#6E6978] pt-1">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#4B4646]" />
            <span>
              Entertainment-only scores stay strictly separate from distinct pothole counts,
              community leaderboards, badges, and civic corridor reports.
            </span>
          </div>
          {syncNotice && (
            <span className="font-mono text-[11px] font-semibold text-[#4CB729]">{syncNotice}</span>
          )}
        </div>
      </section>

      {/* Active Game Surface */}
      {activeGame === 'pothole_repair' ? (
        <PotholeRepairGame
          highScore={repairStat.highScore}
          onCompleteRun={(score, durationMs) =>
            void handleCompleteRun('pothole_repair', score, durationMs)
          }
        />
      ) : (
        <AtlantaRunnerGame
          highScore={runnerStat.highScore}
          onCompleteRun={(score, durationMs) =>
            void handleCompleteRun('pothole_runner', score, durationMs)
          }
        />
      )}
    </div>
  );
};

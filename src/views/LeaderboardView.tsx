import React, { useEffect, useState } from 'react';
import { Award, Users } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAchievements } from '../hooks/useSocial';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import {
  AchievementBadge,
  getAchievementBadgeState,
} from '../components/AchievementBadge';

type LeaderboardPeriod = 'overall' | 'weekly' | 'monthly' | 'neighborhood';

interface LeaderboardEntry {
  uid: string;
  username: string;
  displayName: string;
  photoURL?: string;
  neighborhood?: string;
  shareNeighborhood: boolean;
  primaryScore: number;
  evidenceScore: number;
  overallDistinctCount: number;
  overallEvidenceCount: number;
}

export const LeaderboardView: React.FC<{ onOpenProfile?: (uid: string) => void }> = ({ onOpenProfile }) => {
  const { user, isSigningIn, signIn } = useAuth();
  const { badges, loading: loadingBadges } = useAchievements(user);

  const [period, setPeriod] = useState<LeaderboardPeriod>('overall');
  const [selectedNeighborhood, setSelectedNeighborhood] = useState('');
  const [neighborhoods, setNeighborhoods] = useState<string[]>([]);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [periodMeta, setPeriodMeta] = useState<{ weekKey?: string; monthKey?: string }>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user) {
      setEntries([]);
      setNeighborhoods([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    user
      .getIdToken()
      .then((token) => {
        const params = new URLSearchParams({ period });
        if (period === 'neighborhood' && selectedNeighborhood) {
          params.set('neighborhood', selectedNeighborhood);
        }
        return fetch(`/api/leaderboard?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      })
      .then((res) => res.json())
      .then(
        (data: {
          entries?: LeaderboardEntry[];
          neighborhoods?: string[];
          weekKey?: string;
          monthKey?: string;
        }) => {
          if (cancelled) return;
          setEntries(Array.isArray(data.entries) ? data.entries : []);
          setNeighborhoods(Array.isArray(data.neighborhoods) ? data.neighborhoods : []);
          setPeriodMeta({ weekKey: data.weekKey, monthKey: data.monthKey });
          setLoading(false);
        }
      )
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, period, selectedNeighborhood]);

  return (
    <div className="city-page city-leaderboard max-w-6xl mx-auto space-y-6">
      <div className="page-banner page-banner-ranks">
        <div>
          <span className="page-banner-index">THE SCORE</span>
          <h1>WHO RUNS<br /><em>THE BLOCK?</em></h1>
          <p>Verified finds only. See which Patchers and neighborhoods are putting in the street work.</p>
        </div>
        <Award className="page-banner-icon" aria-hidden="true" />
      </div>
      <section className="rank-board bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-8 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
              Atlanta Leaderboards
            </h1>
            <p className="text-sm text-[#6E6978] mt-1">
              Psst, Patcher! Climb the ranks to catch the most potholes!
            </p>
          </div>
          <Award className="w-7 h-7 text-[#4CB729] shrink-0" />
        </div>

        {!user ? (
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-6 text-center space-y-4">
            <Users className="w-8 h-8 text-[#6E6978] mx-auto" />
            <p className="text-sm text-[#3A3535]">
              Sign in with Google to view live opted-in Atlanta Patchers across overall, weekly,
              monthly, and neighborhood standings.
            </p>
            <div className="flex justify-center">
              <GoogleSignInButton onClick={() => void signIn()} disabled={isSigningIn} />
            </div>
          </div>
        ) : (
          <>
            <div className="min-w-0 flex flex-wrap items-center justify-between gap-3">
              <div className="scrollbar-none w-full sm:w-auto inline-flex items-center gap-1 p-1 bg-[#F7F7F8] border border-[#E8DFC5] rounded-xl overflow-x-auto">
                {(
                  [
                    { id: 'overall', label: 'Overall' },
                    { id: 'weekly', label: 'Weekly' },
                    { id: 'monthly', label: 'Monthly' },
                    { id: 'neighborhood', label: 'Neighborhood' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setPeriod(tab.id)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                      period === tab.id
                        ? 'bg-white text-[#2D2B35] shadow-xs'
                        : 'text-[#6E6978] hover:text-[#2D2B35]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {period === 'weekly' && periodMeta.weekKey && (
                <span className="font-mono text-xs text-[#6E6978]">Week {periodMeta.weekKey}</span>
              )}
              {period === 'monthly' && periodMeta.monthKey && (
                <span className="font-mono text-xs text-[#6E6978]">
                  Month {periodMeta.monthKey}
                </span>
              )}
              {period === 'neighborhood' && (
                <select
                  aria-label="Filter by neighborhood"
                  value={selectedNeighborhood}
                  onChange={(e) => setSelectedNeighborhood(e.target.value)}
                  className="w-full sm:w-auto min-h-[40px] px-3 py-1.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-xs font-semibold text-[#2D2B35]"
                >
                  <option value="">All opted-in neighborhoods</option>
                  {neighborhoods.map((nh) => (
                    <option key={nh} value={nh}>
                      {nh}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {loading ? (
              <div className="py-10 text-center text-sm text-[#6E6978]">
                Loading server-verified leaderboard...
              </div>
            ) : entries.length === 0 ? (
              <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-6 text-center text-sm text-[#6E6978]">
                {period === 'neighborhood'
                  ? 'No Patchers have opted in to share a neighborhood here yet. Enable neighborhood sharing in Profile to join.'
                  : 'No opted-in Patchers listed yet.'}
              </div>
            ) : (
              <div className="divide-y divide-[#E8DFC5]">
                {entries.map((entry, idx) => (
                  <div key={entry.uid} className="py-3.5 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="w-7 text-center font-mono text-sm font-bold text-[#6E6978] tabular-nums">
                        {idx + 1}
                      </span>
                      {entry.photoURL ? (
                        <img
                          src={entry.photoURL}
                          alt={entry.displayName}
                          referrerPolicy="no-referrer"
                          className="w-9 h-9 rounded-full object-cover border border-[#E8DFC5] shrink-0"
                        />
                      ) : (
                        <span className="w-9 h-9 rounded-full bg-[#3A3535] text-white text-xs font-bold flex items-center justify-center shrink-0">
                          {entry.displayName.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        {onOpenProfile ? (
                          <button
                            type="button"
                            onClick={() => onOpenProfile(entry.uid)}
                            className="text-sm font-semibold text-[#2D2B35] truncate hover:underline text-left"
                          >
                            {entry.displayName}
                          </button>
                        ) : (
                          <div className="text-sm font-semibold text-[#2D2B35] truncate">
                            {entry.displayName}
                          </div>
                        )}
                        <div className="text-xs text-[#6E6978] font-mono truncate">
                          @{entry.username} · {entry.evidenceScore} evidence
                          {entry.shareNeighborhood && entry.neighborhood
                            ? ` · ${entry.neighborhood}`
                            : ''}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-base font-bold text-[#2D2B35] tabular-nums">
                        {entry.primaryScore}
                      </div>
                      <div className="text-[11px] text-[#6E6978]">distinct</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* Community Achievements Showcase */}
      {user && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-8 space-y-4">
          <div>
            <h2 className="font-display text-xl font-bold text-[#2D2B35]">
              Atlanta Community Achievements
            </h2>
            <p className="text-xs text-[#6E6978] mt-1">
              As you catch more potholes, you can unlock more achievements!
            </p>
          </div>

          {loadingBadges && badges.length === 0 ? (
            <div className="text-xs text-[#6E6978] py-4">Loading achievements...</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {badges.map((badge) => {
                const pct = Math.min(100, Math.round((badge.progress / badge.target) * 100));
                const badgeState = getAchievementBadgeState(badge);
                return (
                  <div
                    key={badge.badgeType}
                    className={`rounded-xl border p-4 ${
                      badge.unlocked
                        ? 'border-[#4CB729]/50 bg-[#4CB729]/5'
                        : 'border-[#E8DFC5] bg-[#F7F7F8]'
                    }`}
                  >
                    <div className="flex items-center gap-3 sm:gap-4">
                      <AchievementBadge
                        badgeType={badge.badgeType}
                        state={badgeState}
                        title={badge.title}
                        className="w-24 h-24 sm:w-28 sm:h-28"
                      />
                      <div className="min-w-0 flex-1 space-y-3">
                        <div>
                          <div className="text-sm font-bold text-[#2D2B35]">{badge.title}</div>
                          <p className="text-xs text-[#4B4646] mt-0.5">
                            {badge.description}
                          </p>
                        </div>

                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono text-[#6E6978] tabular-nums">
                            <span>
                              {badgeState === 'earned'
                                ? 'Earned'
                                : badgeState === 'in-progress'
                                  ? 'In progress'
                                  : 'Locked'}
                            </span>
                            <span>
                              {badge.progress} / {badge.target}
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full bg-white border border-[#E8DFC5] overflow-hidden">
                            <div
                              className={`h-full ${badge.unlocked ? 'bg-[#4CB729]' : 'bg-[#6E6978]/50'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

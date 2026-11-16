import { type User } from 'firebase/auth';

export type MinigameId = 'pothole_repair' | 'pothole_runner';

export interface LocalGameStat {
  highScore: number;
  lastScore: number;
  gamesPlayed: number;
  bestDurationMs: number;
  synced: boolean;
  pendingSync: {
    score: number;
    durationMs: number;
  } | null;
}

export type GameStatsMap = Record<MinigameId, LocalGameStat>;

const STORAGE_KEY = 'patchup_minigame_stats_v1';

const DEFAULT_STAT: LocalGameStat = {
  highScore: 0,
  lastScore: 0,
  gamesPlayed: 0,
  bestDurationMs: 0,
  synced: true,
  pendingSync: null,
};

export function createEmptyGameStats(): GameStatsMap {
  return {
    pothole_repair: { ...DEFAULT_STAT },
    pothole_runner: { ...DEFAULT_STAT },
  };
}

export function loadLocalGameStats(): GameStatsMap {
  const empty = createEmptyGameStats();
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Record<MinigameId, Partial<LocalGameStat>>>;
    for (const id of ['pothole_repair', 'pothole_runner'] as const) {
      const entry = parsed[id];
      if (!entry || typeof entry !== 'object') continue;
      empty[id] = {
        highScore: Number.isFinite(Number(entry.highScore)) ? Math.max(0, Math.round(Number(entry.highScore))) : 0,
        lastScore: Number.isFinite(Number(entry.lastScore)) ? Math.max(0, Math.round(Number(entry.lastScore))) : 0,
        gamesPlayed: Number.isFinite(Number(entry.gamesPlayed)) ? Math.max(0, Math.round(Number(entry.gamesPlayed))) : 0,
        bestDurationMs: Number.isFinite(Number(entry.bestDurationMs)) ? Math.max(0, Math.round(Number(entry.bestDurationMs))) : 0,
        synced: typeof entry.synced === 'boolean' ? entry.synced : true,
        pendingSync:
          entry.pendingSync &&
          typeof entry.pendingSync === 'object' &&
          Number.isFinite(Number(entry.pendingSync.score)) &&
          Number.isFinite(Number(entry.pendingSync.durationMs))
            ? {
                score: Math.max(0, Math.round(Number(entry.pendingSync.score))),
                durationMs: Math.max(1500, Math.round(Number(entry.pendingSync.durationMs))),
              }
            : null,
      };
    }
    return empty;
  } catch {
    return empty;
  }
}

export function saveLocalGameStats(stats: GameStatsMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // Ignore storage quota / private mode failures gracefully
  }
}

export function recordLocalGameRun(
  gameId: MinigameId,
  score: number,
  durationMs: number
): GameStatsMap {
  const cleanScore = Math.max(0, Math.round(score));
  const cleanDuration = Math.max(gameId === 'pothole_repair' ? 2500 : 1500, Math.round(durationMs));
  const current = loadLocalGameStats();
  const prev = current[gameId];
  const isNewHigh = cleanScore > prev.highScore;

  const shouldReplacePending =
    !prev.pendingSync || cleanScore >= prev.pendingSync.score;

  current[gameId] = {
    highScore: Math.max(prev.highScore, cleanScore),
    lastScore: cleanScore,
    gamesPlayed: prev.gamesPlayed + 1,
    bestDurationMs: isNewHigh ? cleanDuration : prev.bestDurationMs || cleanDuration,
    synced: false,
    pendingSync: shouldReplacePending
      ? { score: cleanScore, durationMs: cleanDuration }
      : prev.pendingSync,
  };

  saveLocalGameStats(current);
  return current;
}

export async function syncGameScoreWithServer(
  user: User,
  gameId: MinigameId,
  score: number,
  durationMs: number
): Promise<GameStatsMap> {
  const localUpdated = recordLocalGameRun(gameId, score, durationMs);
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return localUpdated;
  }

  try {
    const token = await user.getIdToken();
    const res = await fetch('/api/games/score', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        gameId,
        score: Math.max(0, Math.round(score)),
        durationMs: Math.max(gameId === 'pothole_repair' ? 2500 : 1500, Math.round(durationMs)),
      }),
    });

    if (!res.ok) {
      return localUpdated;
    }

    const data = (await res.json()) as {
      ok?: boolean;
      highScore?: number;
      gamesPlayed?: number;
      bestDurationMs?: number;
    };

    const next = loadLocalGameStats();
    next[gameId] = {
      highScore: Math.max(next[gameId].highScore, Number(data.highScore || 0)),
      lastScore: next[gameId].lastScore,
      gamesPlayed: Math.max(next[gameId].gamesPlayed, Number(data.gamesPlayed || 0)),
      bestDurationMs: Number(data.bestDurationMs || next[gameId].bestDurationMs || 0),
      synced: true,
      pendingSync: null,
    };
    saveLocalGameStats(next);
    return next;
  } catch {
    return localUpdated;
  }
}

export async function reconcileGameStatsFromServer(user: User): Promise<GameStatsMap> {
  const current = loadLocalGameStats();
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return current;
  }

  try {
    const token = await user.getIdToken();

    // Flush any queued offline personal-best run first
    for (const id of ['pothole_repair', 'pothole_runner'] as const) {
      const pending = current[id].pendingSync;
      if (pending) {
        const postRes = await fetch('/api/games/score', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            gameId: id,
            score: pending.score,
            durationMs: pending.durationMs,
          }),
        });
        if (postRes.ok) {
          current[id].pendingSync = null;
          current[id].synced = true;
        }
      }
    }

    const res = await fetch('/api/games/stats', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      saveLocalGameStats(current);
      return current;
    }

    const payload = (await res.json()) as {
      stats?: Partial<
        Record<
          MinigameId,
          {
            highScore: number;
            lastScore: number;
            gamesPlayed: number;
            bestDurationMs: number;
          } | null
        >
      >;
    };

    for (const id of ['pothole_repair', 'pothole_runner'] as const) {
      const remote = payload.stats?.[id];
      if (!remote) continue;
      current[id] = {
        highScore: Math.max(current[id].highScore, Number(remote.highScore || 0)),
        lastScore: current[id].lastScore || Number(remote.lastScore || 0),
        gamesPlayed: Math.max(current[id].gamesPlayed, Number(remote.gamesPlayed || 0)),
        bestDurationMs: Number(remote.bestDurationMs || current[id].bestDurationMs || 0),
        synced: current[id].pendingSync === null,
        pendingSync: current[id].pendingSync,
      };
    }

    saveLocalGameStats(current);
    return current;
  } catch {
    return current;
  }
}

import { FieldValue, type Firestore, type Timestamp } from 'firebase-admin/firestore';

export const MINIGAME_IDS = [
  'pothole_repair',
  'pothole_runner',
  'crater_blitz',
  'connector_cruise',
] as const;

export type MinigameId = (typeof MINIGAME_IDS)[number];

export interface ValidatedGameSubmission {
  gameId: MinigameId;
  score: number;
  durationMs: number;
}

export interface ServerGameStat {
  statId: string;
  uid: string;
  gameId: MinigameId;
  highScore: number;
  lastScore: number;
  gamesPlayed: number;
  bestDurationMs: number;
  updatedAtMs: number;
}

export function isValidMinigameId(value: unknown): value is MinigameId {
  return typeof value === 'string' && (MINIGAME_IDS as readonly string[]).includes(value);
}

export function validateGameScorePayload(input: {
  gameId: unknown;
  score: unknown;
  durationMs: unknown;
}): { ok: true; value: ValidatedGameSubmission } | { ok: false; error: string } {
  if (!isValidMinigameId(input.gameId)) {
    return { ok: false, error: 'Unsupported minigame identifier.' };
  }

  const rawScore = Number(input.score);
  const rawDuration = Number(input.durationMs);

  if (!Number.isFinite(rawScore) || !Number.isInteger(rawScore) || rawScore < 0) {
    return { ok: false, error: 'Score must be a non-negative integer.' };
  }

  if (!Number.isFinite(rawDuration) || !Number.isInteger(rawDuration) || rawDuration <= 0) {
    return { ok: false, error: 'Run durationMs must be a positive integer.' };
  }

  if (input.gameId === 'pothole_repair') {
    if (rawScore > 1000) {
      return { ok: false, error: 'Pothole Repair score exceeds maximum valid bound (1000).' };
    }
    if (rawDuration < 2500 || rawDuration > 1800000) {
      return {
        ok: false,
        error: 'Pothole Repair durationMs is outside plausible bounds (2500ms–1800000ms).',
      };
    }
    return {
      ok: true,
      value: {
        gameId: 'pothole_repair',
        score: rawScore,
        durationMs: rawDuration,
      },
    };
  }

  if (input.gameId === 'crater_blitz') {
    if (rawScore > 6000) {
      return { ok: false, error: 'Pothole Blitz score exceeds maximum valid bound (6000).' };
    }
    if (rawDuration < 5000 || rawDuration > 120000) {
      return {
        ok: false,
        error: 'Pothole Blitz durationMs is outside plausible bounds (5000ms–120000ms).',
      };
    }
    return {
      ok: true,
      value: {
        gameId: 'crater_blitz',
        score: rawScore,
        durationMs: rawDuration,
      },
    };
  }

  if (input.gameId === 'connector_cruise') {
    if (rawScore > 50000) {
      return { ok: false, error: 'Connector Cruise score exceeds maximum valid bound (50000).' };
    }
    if (rawDuration < 1500 || rawDuration > 3600000) {
      return {
        ok: false,
        error: 'Connector Cruise durationMs is outside plausible bounds (1500ms–3600000ms).',
      };
    }
    const maxCruiseScore = Math.floor(rawDuration / 10) + 120;
    if (rawScore > maxCruiseScore) {
      return {
        ok: false,
        error: `Submitted score (${rawScore}) is implausible for recorded run duration (${rawDuration}ms).`,
      };
    }
    return {
      ok: true,
      value: {
        gameId: 'connector_cruise',
        score: rawScore,
        durationMs: rawDuration,
      },
    };
  }

  // pothole_runner bounds & duration plausibility ratio
  if (rawScore > 50000) {
    return { ok: false, error: 'Atlanta Pothole Runner score exceeds maximum valid bound (50000).' };
  }
  if (rawDuration < 1500 || rawDuration > 3600000) {
    return {
      ok: false,
      error: 'Atlanta Pothole Runner durationMs is outside plausible bounds (1500ms–3600000ms).',
    };
  }
  const maxPlausibleScore = Math.floor(rawDuration / 12) + 50;
  if (rawScore > maxPlausibleScore) {
    return {
      ok: false,
      error: `Submitted score (${rawScore}) is implausible for recorded run duration (${rawDuration}ms).`,
    };
  }

  return {
    ok: true,
    value: {
      gameId: 'pothole_runner',
      score: rawScore,
      durationMs: rawDuration,
    },
  };
}

export async function recordValidatedGameScore(
  serverDb: Firestore,
  params: {
    uid: string;
    gameId: MinigameId;
    score: number;
    durationMs: number;
  }
): Promise<{
  statId: string;
  gameId: MinigameId;
  highScore: number;
  lastScore: number;
  gamesPlayed: number;
  bestDurationMs: number;
  isNewHighScore: boolean;
}> {
  const statId = `${params.uid}_${params.gameId}`;
  const statRef = serverDb.collection('gameStats').doc(statId);

  return serverDb.runTransaction(async (tx) => {
    const existingSnap = await tx.get(statRef);
    const existing = existingSnap.exists ? existingSnap.data() : undefined;

    const prevHigh = Number(existing?.highScore || 0);
    const prevGames = Number(existing?.gamesPlayed || 0);
    const prevBestDuration = Number(existing?.bestDurationMs || params.durationMs);
    const isNewHighScore = !existingSnap.exists || params.score > prevHigh;
    const nextHigh = Math.max(prevHigh, params.score);
    const nextBestDuration =
      params.score >= prevHigh ? params.durationMs : prevBestDuration;

    tx.set(
      statRef,
      {
        statId,
        uid: params.uid,
        gameId: params.gameId,
        highScore: nextHigh,
        lastScore: params.score,
        gamesPlayed: prevGames + 1,
        bestDurationMs: nextBestDuration,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      statId,
      gameId: params.gameId,
      highScore: nextHigh,
      lastScore: params.score,
      gamesPlayed: prevGames + 1,
      bestDurationMs: nextBestDuration,
      isNewHighScore,
    };
  });
}

export async function getUserGameStats(
  serverDb: Firestore,
  uid: string
): Promise<Record<MinigameId, ServerGameStat | null>> {
  const refs = MINIGAME_IDS.map((id) => serverDb.collection('gameStats').doc(`${uid}_${id}`));
  const snaps = await serverDb.getAll(...refs);

  const mapDoc = (snap: FirebaseFirestore.DocumentSnapshot, gameId: MinigameId): ServerGameStat | null => {
    if (!snap.exists) return null;
    const data = snap.data()!;
    const updatedAt = data.updatedAt as Timestamp | undefined;
    return {
      statId: String(data.statId || snap.id),
      uid: String(data.uid || uid),
      gameId,
      highScore: Number(data.highScore || 0),
      lastScore: Number(data.lastScore || 0),
      gamesPlayed: Number(data.gamesPlayed || 0),
      bestDurationMs: Number(data.bestDurationMs || 0),
      updatedAtMs: updatedAt?.toMillis?.() ?? 0,
    };
  };

  return {
    pothole_repair: mapDoc(snaps[0], 'pothole_repair'),
    pothole_runner: mapDoc(snaps[1], 'pothole_runner'),
    crater_blitz: mapDoc(snaps[2], 'crater_blitz'),
    connector_cruise: mapDoc(snaps[3], 'connector_cruise'),
  };
}

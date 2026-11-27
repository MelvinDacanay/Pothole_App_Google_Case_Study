import { isCommunityNotification, type CommunityNotificationType } from '../src/lib/communityNotifications.ts';
import { FieldValue, type Firestore, type Timestamp } from 'firebase-admin/firestore';

export interface AchievementDefinition {
  badgeType: string;
  title: string;
  description: string;
  target: number;
  metric: 'distinct' | 'neighborhoods' | 'repaired';
}

export const ACHIEVEMENT_CATALOG: AchievementDefinition[] = [
  {
    badgeType: 'first_spot',
    title: 'First Spot',
    description: 'Log your first accepted distinct Atlanta pothole.',
    target: 1,
    metric: 'distinct',
  },
  {
    badgeType: 'road_scout',
    title: 'Road Scout',
    description: 'Document 10 accepted distinct potholes across Atlanta.',
    target: 10,
    metric: 'distinct',
  },
  {
    badgeType: 'pothole_hunter',
    title: 'Pothole Hunter',
    description: 'Reach 25 accepted distinct potholes.',
    target: 25,
    metric: 'distinct',
  },
  {
    badgeType: 'asphalt_detective',
    title: 'Asphalt Detective',
    description: 'Reach 50 accepted distinct potholes.',
    target: 50,
    metric: 'distinct',
  },
  {
    badgeType: 'atlanta_road_warrior',
    title: 'Atlanta Road Warrior',
    description: 'Reach 100 accepted distinct potholes.',
    target: 100,
    metric: 'distinct',
  },
  {
    badgeType: 'neighborhood_watch',
    title: 'Neighborhood Watch',
    description: 'Contribute accepted distinct potholes across 5 Atlanta neighborhoods.',
    target: 5,
    metric: 'neighborhoods',
  },
  {
    badgeType: 'community_champion',
    title: 'Community Champion',
    description: 'Contribute to a pothole that receives a credibly confirmed repair.',
    target: 1,
    metric: 'repaired',
  },
];

export function getCurrentWeekKey(now = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getCurrentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function makeFriendshipId(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('__');
}

export type NotificationType = CommunityNotificationType;

export async function createNotification(
  db: Firestore,
  params: {
    uid: string;
    type: NotificationType;
    title: string;
    body: string;
    relatedId?: string;
    notificationId?: string;
  }
): Promise<void> {
  if (!isCommunityNotification(params.type)) return;
  const notificationId =
    params.notificationId || `ntf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await db
    .collection('notifications')
    .doc(params.uid)
    .collection('items')
    .doc(notificationId)
    .set({
      notificationId,
      uid: params.uid,
      type: params.type,
      title: params.title.trim().slice(0, 96),
      body: params.body.trim().slice(0, 240),
      ...(params.relatedId ? { relatedId: params.relatedId.slice(0, 128) } : {}),
      read: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

export async function createActivityFeedEvent(
  db: Firestore,
  params: {
    eventId?:string;
    actorUid: string;
    actorUsername: string;
    actorDisplayName: string;
    eventType: 'new_pothole' | 'evidence_added' | 'badge_unlocked' | 'confirmed_repair';
    summary: string;
    streetName?: string;
    neighborhood?: string;
    potholeId?: string;
  }
): Promise<void> {
  const eventId = params.eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.collection('activityFeed').doc(eventId).set({
    eventId,
    actorUid: params.actorUid,
    actorUsername: params.actorUsername.slice(0, 32),
    actorDisplayName: params.actorDisplayName.slice(0, 64),
    eventType: params.eventType,
    summary: params.summary.trim().slice(0, 200),
    ...(params.streetName ? { streetName: params.streetName.trim().slice(0, 128) } : {}),
    ...(params.neighborhood ? { neighborhood: params.neighborhood.trim().slice(0, 64) } : {}),
    ...(params.potholeId ? { potholeId: params.potholeId.slice(0, 128) } : {}),
    visibility: 'public',
    createdAt: FieldValue.serverTimestamp(),
  });
}

export async function evaluateUserAchievements(
  db: Firestore,
  uid: string,
  emitNotifications = true
): Promise<
  Array<{
    badgeType: string;
    uid: string;
    title: string;
    description: string;
    progress: number;
    target: number;
    unlocked: boolean;
    unlockedAt?: Timestamp;
  }>
> {
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return [];

  const userData = userSnap.data()!;
  const distinctCount = Number(userData.distinctPotholeCount || 0);
  const username = String(userData.username || 'atlanta_user');
  const displayName = String(userData.displayName || 'Patcher');

  // Inspect accepted potholes contributed by this user to calculate neighborhoods & confirmed repairs
  const potholeSnap = await db
    .collection('potholes')
    .where('primaryContributorUid', '==', uid)
    .limit(200)
    .get();

  const neighborhoodSet = new Set<string>();
  let repairedCount = 0;

  for (const docSnap of potholeSnap.docs) {
    const p = docSnap.data();
    if (p.status === 'rejected' || p.status === 'provisional') continue;
    const nh = typeof p.neighborhood === 'string' ? p.neighborhood.trim() : '';
    if (nh) neighborhoodSet.add(nh.toLowerCase());
    if (p.status === 'repaired') {
      repairedCount += 1;
    }
  }

  const badgesCol = db.collection('achievements').doc(uid).collection('badges');
  const existingSnap = await badgesCol.get();
  const existingMap = new Map<string, FirebaseFirestore.DocumentData>();
  existingSnap.docs.forEach((d) => existingMap.set(d.id, d.data()));

  const batch = db.batch();
  const newlyUnlocked: AchievementDefinition[] = [];
  const results: Array<{
    badgeType: string;
    uid: string;
    title: string;
    description: string;
    progress: number;
    target: number;
    unlocked: boolean;
    unlockedAt?: Timestamp;
  }> = [];

  let unlockedTotal = 0;

  for (const def of ACHIEVEMENT_CATALOG) {
    const rawProgress =
      def.metric === 'distinct'
        ? distinctCount
        : def.metric === 'neighborhoods'
          ? neighborhoodSet.size
          : repairedCount;
    const progress = Math.min(def.target, Math.max(0, rawProgress));
    const wasUnlocked = Boolean(existingMap.get(def.badgeType)?.unlocked);
    const unlocked = wasUnlocked || rawProgress >= def.target;

    if (unlocked) unlockedTotal += 1;
    if (unlocked && !wasUnlocked) {
      newlyUnlocked.push(def);
    }

    const existingUnlockedAt = existingMap.get(def.badgeType)?.unlockedAt as Timestamp | undefined;
    const badgeRef = badgesCol.doc(def.badgeType);

    batch.set(
      badgeRef,
      {
        badgeType: def.badgeType,
        uid,
        title: def.title,
        description: def.description,
        progress,
        target: def.target,
        unlocked,
        ...(unlocked
          ? { unlockedAt: existingUnlockedAt ?? FieldValue.serverTimestamp() }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    results.push({
      badgeType: def.badgeType,
      uid,
      title: def.title,
      description: def.description,
      progress,
      target: def.target,
      unlocked,
      ...(existingUnlockedAt ? { unlockedAt: existingUnlockedAt } : {}),
    });
  }

  batch.update(userRef, {
    unlockedBadgesCount: unlockedTotal,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();

  if (emitNotifications && newlyUnlocked.length > 0) {
    for (const badge of newlyUnlocked) {
      await Promise.all([
        createNotification(db, {
          uid,
          type: 'badge_unlocked',
          notificationId:`badge_${badge.badgeType}`,
          title: `Badge Unlocked: ${badge.title}`,
          body: badge.description,
          relatedId: badge.badgeType,
        }),
        createActivityFeedEvent(db, {
          eventId:`badge_${uid}_${badge.badgeType}`.slice(0,128),
          actorUid: uid,
          actorUsername: username,
          actorDisplayName: displayName,
          eventType: 'badge_unlocked',
          summary: `@${username} unlocked the ${badge.title} achievement`,
        }),
      ]);
    }
  }

  return results;
}

export async function syncUserLeaderboardProfile(db: Firestore, uid: string): Promise<void> {
  const userRef=db.collection('users').doc(uid);
  const statsRef = db.collection('leaderboardStats').doc(uid);
  const weekKey = getCurrentWeekKey();
  const monthKey = getCurrentMonthKey();

  await db.runTransaction(async (tx) => {
    const [userSnap,statsSnap]=await Promise.all([tx.get(userRef),tx.get(statsRef)]);
    if(!userSnap.exists)return;
    const user=userSnap.data()!;
    const existing = statsSnap.exists ? statsSnap.data()! : null;

    const shareNeighborhood = Boolean(user.shareNeighborhood);
    const homeNeighborhood =
      shareNeighborhood && typeof user.homeNeighborhood === 'string'
        ? user.homeNeighborhood.trim().slice(0, 64)
        : '';

    const weeklyDistinctCount =
      existing && existing.weekKey === weekKey ? Number(existing.weeklyDistinctCount || 0) : 0;
    const weeklyEvidenceCount =
      existing && existing.weekKey === weekKey ? Number(existing.weeklyEvidenceCount || 0) : 0;
    const monthlyDistinctCount =
      existing && existing.monthKey === monthKey ? Number(existing.monthlyDistinctCount || 0) : 0;
    const monthlyEvidenceCount =
      existing && existing.monthKey === monthKey ? Number(existing.monthlyEvidenceCount || 0) : 0;

    tx.set(
      statsRef,
      {
        uid,
        username: String(user.username || 'atlanta_user').slice(0, 32),
        displayName: String(user.displayName || 'Patcher').slice(0, 64),
        ...(typeof user.photoURL === 'string' && user.photoURL
          ? { photoURL: user.photoURL.slice(0, 512) }
          : {}),
        showOnLeaderboard: Boolean(user.showOnLeaderboard),
        shareNeighborhood,
        neighborhood: homeNeighborhood,
        overallDistinctCount: Number(user.distinctPotholeCount || 0),
        overallEvidenceCount: Number(user.evidenceCount || 0),
        weeklyDistinctCount,
        weeklyEvidenceCount,
        weekKey,
        monthlyDistinctCount,
        monthlyEvidenceCount,
        monthKey,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

export async function recordContributionSocialImpact(
  db: Firestore,
  params: {
    uid: string;
    username: string;
    displayName: string;
    potholeId: string;
    streetName: string;
    neighborhood?: string;
    distinctDelta: number;
    evidenceDelta: number;
    eventType: 'new_pothole' | 'evidence_added';
  }
): Promise<void> {
  const userRef = db.collection('users').doc(params.uid);
  const statsRef = db.collection('leaderboardStats').doc(params.uid);
  const weekKey = getCurrentWeekKey();
  const monthKey = getCurrentMonthKey();

  let newOverallDistinct = 0;

  await db.runTransaction(async (tx) => {
    const [userSnap, statsSnap] = await Promise.all([tx.get(userRef), tx.get(statsRef)]);
    if (!userSnap.exists) return;

    const userData = userSnap.data()!;
    const existingStats = statsSnap.exists ? statsSnap.data()! : null;

    newOverallDistinct = Number(userData.distinctPotholeCount || 0);
    const overallEvidenceCount = Number(userData.evidenceCount || 0);

    const prevWeekDistinct =
      existingStats && existingStats.weekKey === weekKey
        ? Number(existingStats.weeklyDistinctCount || 0)
        : 0;
    const prevWeekEvidence =
      existingStats && existingStats.weekKey === weekKey
        ? Number(existingStats.weeklyEvidenceCount || 0)
        : 0;
    const prevMonthDistinct =
      existingStats && existingStats.monthKey === monthKey
        ? Number(existingStats.monthlyDistinctCount || 0)
        : 0;
    const prevMonthEvidence =
      existingStats && existingStats.monthKey === monthKey
        ? Number(existingStats.monthlyEvidenceCount || 0)
        : 0;

    const shareNeighborhood = Boolean(userData.shareNeighborhood);
    const userHomeNeighborhood =
      shareNeighborhood && typeof userData.homeNeighborhood === 'string'
        ? userData.homeNeighborhood.trim().slice(0, 64)
        : '';
    const resolvedNeighborhood = shareNeighborhood
      ? userHomeNeighborhood || (params.neighborhood || '').trim().slice(0, 64)
      : '';

    tx.set(
      statsRef,
      {
        uid: params.uid,
        username: String(userData.username || params.username).slice(0, 32),
        displayName: String(userData.displayName || params.displayName).slice(0, 64),
        ...(typeof userData.photoURL === 'string' && userData.photoURL
          ? { photoURL: userData.photoURL.slice(0, 512) }
          : {}),
        showOnLeaderboard: Boolean(userData.showOnLeaderboard),
        shareNeighborhood,
        neighborhood: resolvedNeighborhood,
        overallDistinctCount: newOverallDistinct,
        overallEvidenceCount,
        weeklyDistinctCount: prevWeekDistinct + params.distinctDelta,
        weeklyEvidenceCount: prevWeekEvidence + params.evidenceDelta,
        weekKey,
        monthlyDistinctCount: prevMonthDistinct + params.distinctDelta,
        monthlyEvidenceCount: prevMonthEvidence + params.evidenceDelta,
        monthKey,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  // Public-safe street-level feed event (street name & optional neighborhood only, no house number/coords)
  const cleanStreet = params.streetName.replace(/^\d+\s+/, '').trim() || params.streetName;
  const feedSummary =
    params.eventType === 'new_pothole'
      ? `@${params.username} documented a distinct pothole on ${cleanStreet}`
      : `@${params.username} added supporting photo evidence on ${cleanStreet}`;

  await createActivityFeedEvent(db, {
    actorUid: params.uid,
    actorUsername: params.username,
    actorDisplayName: params.displayName,
    eventType: params.eventType,
    summary: feedSummary,
    streetName: cleanStreet,
    neighborhood: params.neighborhood,
    potholeId: params.potholeId,
  });

  // Evaluate achievement unlocks & milestone notifications
  await evaluateUserAchievements(db, params.uid, true);

  if (
    params.distinctDelta > 0 &&
    (newOverallDistinct === 5 ||
      newOverallDistinct === 15 ||
      newOverallDistinct === 30 ||
      newOverallDistinct === 75)
  ) {
    await createNotification(db, {
      uid: params.uid,
      type: 'leaderboard_milestone',
      title: `${newOverallDistinct} Distinct Atlanta Potholes`,
      body: `You have documented ${newOverallDistinct} accepted distinct potholes on the leaderboard.`,
      relatedId: params.potholeId,
    });
  }
}

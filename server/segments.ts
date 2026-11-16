import { FieldValue, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import {
  classifyJurisdiction,
  haversineMeters,
  isWithinAtlantaMetro,
  normalizeStreetName,
  type JurisdictionType,
} from './geo.ts';
import {
  createActivityFeedEvent,
  createNotification,
  evaluateUserAchievements,
} from './social.ts';

export type SegmentConfidence = 'verified' | 'provisional' | 'needs_review';
export type ReportStatus =
  | 'awaiting_admin_review'
  | 'ready_for_submission'
  | 'submitted'
  | 'acknowledged'
  | 'resolved'
  | 'unable_to_submit'
  | 'closed';

const ACTIVE_CYCLE_POTHOLE_STATUSES = new Set(['accepted', 'reported', 'acknowledged']);
const ACCEPTED_HISTORICAL_STATUSES = new Set([
  'accepted',
  'reported',
  'acknowledged',
  'repaired',
]);

const CORRIDOR_ANCHOR_RADIUS_METERS = 600;
const CORRIDOR_MAX_SPAN_METERS = 1100;
const THRESHOLD_DISTINCT_COUNT = 5;

const ALLOWED_REPORT_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  awaiting_admin_review: ['ready_for_submission', 'unable_to_submit', 'closed'],
  ready_for_submission: ['submitted', 'unable_to_submit', 'closed'],
  submitted: ['acknowledged', 'resolved', 'closed'],
  acknowledged: ['resolved', 'closed'],
  unable_to_submit: ['ready_for_submission', 'closed'],
  resolved: ['closed'],
  closed: [],
};

export interface AdminActor {
  uid: string;
  email: string;
}

export function parseStreetNumber(formattedAddress: string): number | null {
  const match = formattedAddress.trim().match(/^(\d{1,6})\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function assessSegmentConfidence(params: {
  lat: number;
  lng: number;
  streetName: string;
  normalizedStreet: string;
  formattedAddress: string;
  jurisdiction: JurisdictionType;
}): SegmentConfidence {
  const street = params.streetName.trim();
  const normalized = params.normalizedStreet.trim();
  const address = params.formattedAddress.trim();

  if (
    !normalized ||
    normalized === 'coordinate pin' ||
    normalized === 'unverified street' ||
    /^near\s+-?\d+/i.test(street) ||
    params.jurisdiction === 'unknown' ||
    !isWithinAtlantaMetro(params.lat, params.lng)
  ) {
    return 'needs_review';
  }

  const hasRampOrHighwayEdge =
    /\b(ramp|exit|milepost|mm\s*\d+|overpass|viaduct|bridge|interchange|collector)\b/i.test(
      `${street} ${address}`
    );
  const hasBareIntersection = /[&/]/.test(street) && parseStreetNumber(address) === null;

  if (hasRampOrHighwayEdge || hasBareIntersection) {
    return 'provisional';
  }

  return 'verified';
}

function buildBlockRangeLabel(
  streetName: string,
  minBlock: number | null,
  maxBlock: number | null
): string {
  const cleanStreet = streetName.replace(/^\d+[a-z]?\s+/i, '').trim() || streetName;
  if (minBlock && maxBlock) {
    const low = Math.floor(minBlock / 100) * 100;
    const high = Math.floor(maxBlock / 100) * 100;
    if (low === high) {
      return `${cleanStreet} (${low} block)`;
    }
    return `${cleanStreet} (${low}–${high} blocks)`;
  }
  return `${cleanStreet} corridor`;
}

function makeSegmentSlug(normalizedStreet: string, lat: number, lng: number): string {
  const slug = normalizedStreet
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  const latBucket = Math.round(lat * 200);
  const lngBucket = Math.round(Math.abs(lng) * 200);
  const rand = Math.random().toString(36).slice(2, 6);
  return `seg_${slug || 'corridor'}_${latBucket}_${lngBucket}_${rand}`;
}

export async function writeAdminAudit(
  db: Firestore,
  params: {
    actor: AdminActor;
    action: string;
    targetType: 'pothole' | 'segment' | 'report' | 'admin';
    targetId: string;
    reason: string;
    beforeSummary?: string;
    afterSummary?: string;
  }
): Promise<string> {
  const eventId = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await db.collection('adminAudit').doc(eventId).set({
    eventId,
    actorUid: params.actor.uid.slice(0, 128),
    actorEmail: params.actor.email.slice(0, 254),
    action: params.action.slice(0, 96),
    targetType: params.targetType,
    targetId: params.targetId.slice(0, 128),
    reason: params.reason.trim().slice(0, 400) || 'Admin operational update',
    ...(params.beforeSummary ? { beforeSummary: params.beforeSummary.slice(0, 300) } : {}),
    ...(params.afterSummary ? { afterSummary: params.afterSummary.slice(0, 300) } : {}),
    createdAt: FieldValue.serverTimestamp(),
  });
  return eventId;
}

export async function resolveOrCreateStreetSegment(
  db: Firestore,
  pothole: {
    potholeId: string;
    lat: number;
    lng: number;
    streetName: string;
    normalizedStreet: string;
    formattedAddress: string;
    neighborhood?: string;
    city: string;
    state: string;
    jurisdiction: JurisdictionType;
    segmentId?: string;
  }
): Promise<{ segmentId: string; confidence: SegmentConfidence }> {
  if (pothole.segmentId) {
    const existingSegSnap = await db.collection('streetSegments').doc(pothole.segmentId).get();
    if (existingSegSnap.exists && existingSegSnap.data()?.status === 'active') {
      return {
        segmentId: existingSegSnap.id,
        confidence: (existingSegSnap.data()!.confidence as SegmentConfidence) || 'needs_review',
      };
    }
  }

  const cleanNormalized =
    pothole.normalizedStreet || normalizeStreetName(pothole.streetName) || 'unverified street';
  const candidateConfidence = assessSegmentConfidence({
    lat: pothole.lat,
    lng: pothole.lng,
    streetName: pothole.streetName,
    normalizedStreet: cleanNormalized,
    formattedAddress: pothole.formattedAddress,
    jurisdiction: pothole.jurisdiction,
  });

  const blockNum = parseStreetNumber(pothole.formattedAddress);

  const candidatesSnap = await db
    .collection('streetSegments')
    .where('normalizedStreet', '==', cleanNormalized)
    .limit(40)
    .get();

  let matchedSeg: FirebaseFirestore.QueryDocumentSnapshot | null = null;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const docSnap of candidatesSnap.docs) {
    const seg = docSnap.data();
    if (seg.status !== 'active') continue;
    if (seg.jurisdiction !== pothole.jurisdiction) continue;

    const anchorDist = haversineMeters(
      pothole.lat,
      pothole.lng,
      Number(seg.anchorLat),
      Number(seg.anchorLng)
    );
    if (anchorDist > CORRIDOR_ANCHOR_RADIUS_METERS) continue;

    const minLat = Math.min(Number(seg.minLat ?? seg.anchorLat), pothole.lat);
    const maxLat = Math.max(Number(seg.maxLat ?? seg.anchorLat), pothole.lat);
    const minLng = Math.min(Number(seg.minLng ?? seg.anchorLng), pothole.lng);
    const maxLng = Math.max(Number(seg.maxLng ?? seg.anchorLng), pothole.lng);
    const corridorSpan = haversineMeters(minLat, minLng, maxLat, maxLng);

    if (corridorSpan > CORRIDOR_MAX_SPAN_METERS) continue;

    if (anchorDist < bestDist) {
      bestDist = anchorDist;
      matchedSeg = docSnap;
    }
  }

  if (matchedSeg) {
    const segData = matchedSeg.data();
    const minLat = Math.min(Number(segData.minLat ?? segData.anchorLat), pothole.lat);
    const maxLat = Math.max(Number(segData.maxLat ?? segData.anchorLat), pothole.lat);
    const minLng = Math.min(Number(segData.minLng ?? segData.anchorLng), pothole.lng);
    const maxLng = Math.max(Number(segData.maxLng ?? segData.anchorLng), pothole.lng);
    const prevMinBlock = typeof segData.minBlock === 'number' ? segData.minBlock : null;
    const prevMaxBlock = typeof segData.maxBlock === 'number' ? segData.maxBlock : null;
    const nextMinBlock =
      blockNum !== null
        ? prevMinBlock !== null
          ? Math.min(prevMinBlock, blockNum)
          : blockNum
        : prevMinBlock;
    const nextMaxBlock =
      blockNum !== null
        ? prevMaxBlock !== null
          ? Math.max(prevMaxBlock, blockNum)
          : blockNum
        : prevMaxBlock;

    const segConfidence = (segData.confidence as SegmentConfidence) || candidateConfidence;

    await matchedSeg.ref.update({
      minLat,
      maxLat,
      minLng,
      maxLng,
      ...(nextMinBlock !== null ? { minBlock: nextMinBlock } : {}),
      ...(nextMaxBlock !== null ? { maxBlock: nextMaxBlock } : {}),
      corridorLabel: buildBlockRangeLabel(
        String(segData.streetName || pothole.streetName),
        nextMinBlock,
        nextMaxBlock
      ).slice(0, 160),
      ...(!segData.neighborhood && pothole.neighborhood
        ? { neighborhood: pothole.neighborhood.slice(0, 64) }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await db.collection('potholes').doc(pothole.potholeId).update({
      segmentId: matchedSeg.id,
      segmentConfidence: segConfidence,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { segmentId: matchedSeg.id, confidence: segConfidence };
  }

  const segmentId = makeSegmentSlug(cleanNormalized, pothole.lat, pothole.lng);
  const cleanStreet = pothole.streetName.replace(/^\d+[a-z]?\s+/i, '').trim() || pothole.streetName;
  const corridorLabel = buildBlockRangeLabel(cleanStreet, blockNum, blockNum).slice(0, 160);

  await db.collection('streetSegments').doc(segmentId).set({
    segmentId,
    streetName: cleanStreet.slice(0, 128),
    normalizedStreet: cleanNormalized.slice(0, 128),
    corridorLabel,
    city: (pothole.city || 'Atlanta').slice(0, 64),
    state: (pothole.state || 'GA').slice(0, 32),
    ...(pothole.neighborhood ? { neighborhood: pothole.neighborhood.slice(0, 64) } : {}),
    jurisdiction: pothole.jurisdiction,
    confidence: candidateConfidence,
    anchorLat: pothole.lat,
    anchorLng: pothole.lng,
    minLat: pothole.lat,
    maxLat: pothole.lat,
    minLng: pothole.lng,
    maxLng: pothole.lng,
    ...(blockNum !== null ? { minBlock: blockNum, maxBlock: blockNum } : {}),
    distinctAcceptedCount: 0,
    currentCycleNumber: 1,
    currentCycleDistinctCount: 0,
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection('potholes').doc(pothole.potholeId).update({
    segmentId,
    segmentConfidence: candidateConfidence,
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { segmentId, confidence: candidateConfidence };
}

export async function evaluateSegmentMembershipAndThreshold(
  db: Firestore,
  potholeId: string
): Promise<{
  segmentId: string;
  cycleNumber: number;
  currentCycleDistinctCount: number;
  reportId: string | null;
  reportCreated: boolean;
}> {
  const potholeSnap = await db.collection('potholes').doc(potholeId).get();
  if (!potholeSnap.exists) {
    throw new Error('Pothole record not found for segment evaluation.');
  }
  const initialPothole = potholeSnap.data()!;

  const { segmentId } = await resolveOrCreateStreetSegment(db, {
    potholeId,
    lat: Number(initialPothole.lat),
    lng: Number(initialPothole.lng),
    streetName: String(initialPothole.streetName || 'Atlanta Street'),
    normalizedStreet: String(initialPothole.normalizedStreet || ''),
    formattedAddress: String(initialPothole.formattedAddress || ''),
    neighborhood:
      typeof initialPothole.neighborhood === 'string' ? initialPothole.neighborhood : undefined,
    city: String(initialPothole.city || 'Atlanta'),
    state: String(initialPothole.state || 'GA'),
    jurisdiction: (initialPothole.jurisdiction as JurisdictionType) || 'unknown',
    segmentId:
      typeof initialPothole.segmentId === 'string' ? initialPothole.segmentId : undefined,
  });

  const txResult = await db.runTransaction(async (tx) => {
    const potRef = db.collection('potholes').doc(potholeId);
    const segRef = db.collection('streetSegments').doc(segmentId);
    const memberRef = segRef.collection('acceptedPotholes').doc(potholeId);

    const [potDoc, segDoc, memberDoc] = await Promise.all([
      tx.get(potRef),
      tx.get(segRef),
      tx.get(memberRef),
    ]);

    if (!potDoc.exists || !segDoc.exists) {
      throw new Error('Pothole or street segment disappeared during transaction.');
    }

    const pot = potDoc.data()!;
    const seg = segDoc.data()!;
    const cycleNumber = Number(seg.currentCycleNumber || 1);
    const deterministicReportId = `rep_${segmentId}_c${cycleNumber}`;
    const activeReportId =
      typeof seg.activeReportId === 'string' && seg.activeReportId ? seg.activeReportId : null;

    const existingReportRef = db
      .collection('reports')
      .doc(activeReportId || deterministicReportId);
    const existingReportDoc = await tx.get(existingReportRef);

    const isEligibleStatus = ACTIVE_CYCLE_POTHOLE_STATUSES.has(String(pot.status));
    if (!isEligibleStatus) {
      return {
        segmentId,
        cycleNumber,
        currentCycleDistinctCount: Number(seg.currentCycleDistinctCount || 0),
        reportId: activeReportId,
        reportCreated: false,
        notifyUids: [] as string[],
        corridorLabel: String(seg.corridorLabel || seg.streetName),
      };
    }

    // If an active report already exists for this cycle, attach as supplement if not already included
    if (
      activeReportId &&
      existingReportDoc.exists &&
      existingReportDoc.data()?.status !== 'closed' &&
      existingReportDoc.data()?.status !== 'resolved'
    ) {
      const reportData = existingReportDoc.data()!;
      const snapshotIds = Array.isArray(reportData.snapshotPotholeIds)
        ? (reportData.snapshotPotholeIds as string[])
        : [];
      const supRef = existingReportRef.collection('supplements').doc(potholeId);
      const supSnap = await tx.get(supRef);

      let totalDistinct = Number(seg.distinctAcceptedCount || 0);
      if (!memberDoc.exists) {
        totalDistinct += 1;
        tx.set(memberRef, {
          potholeId,
          segmentId,
          cycleNumber,
          countedForThreshold: false,
          streetName: String(pot.streetName || seg.streetName).slice(0, 128),
          lat: Number(pot.lat),
          lng: Number(pot.lng),
          addedAt: FieldValue.serverTimestamp(),
        });
        tx.update(segRef, {
          distinctAcceptedCount: totalDistinct,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      if (!snapshotIds.includes(potholeId) && !supSnap.exists) {
        tx.set(supRef, {
          supplementId: potholeId,
          reportId: activeReportId,
          potholeId,
          streetName: String(pot.streetName || seg.streetName).slice(0, 128),
          formattedAddress: String(pot.formattedAddress || '').slice(0, 256),
          addedAt: FieldValue.serverTimestamp(),
        });
        tx.update(existingReportRef, {
          supplementCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      return {
        segmentId,
        cycleNumber,
        currentCycleDistinctCount: Number(seg.currentCycleDistinctCount || 0),
        reportId: activeReportId,
        reportCreated: false,
        notifyUids: [] as string[],
        corridorLabel: String(seg.corridorLabel || seg.streetName),
      };
    }

    // Standard active cycle accounting
    if (memberDoc.exists) {
      return {
        segmentId,
        cycleNumber,
        currentCycleDistinctCount: Number(seg.currentCycleDistinctCount || 0),
        reportId: activeReportId,
        reportCreated: false,
        notifyUids: [] as string[],
        corridorLabel: String(seg.corridorLabel || seg.streetName),
      };
    }

    // Read current accepted members BEFORE writes so we can form snapshot atomically if threshold is hit
    const currentMembersSnap = await tx.get(
      segRef.collection('acceptedPotholes').where('cycleNumber', '==', cycleNumber)
    );

    const countedMembers = currentMembersSnap.docs.filter(
      (d) => d.data().countedForThreshold === true
    );
    const nextCycleDistinctCount = countedMembers.length + 1;
    const nextTotalDistinct = Number(seg.distinctAcceptedCount || 0) + 1;

    tx.set(memberRef, {
      potholeId,
      segmentId,
      cycleNumber,
      countedForThreshold: true,
      streetName: String(pot.streetName || seg.streetName).slice(0, 128),
      lat: Number(pot.lat),
      lng: Number(pot.lng),
      addedAt: FieldValue.serverTimestamp(),
    });

    const segConfidence = (seg.confidence as SegmentConfidence) || 'needs_review';
    const shouldCreateReport =
      segConfidence === 'verified' &&
      nextCycleDistinctCount >= THRESHOLD_DISTINCT_COUNT &&
      !existingReportDoc.exists;

    if (shouldCreateReport) {
      const snapshotIds = Array.from(
        new Set([...countedMembers.map((d) => String(d.data().potholeId || d.id)), potholeId])
      );
      const snapshotPotRefs = snapshotIds.map((id) => db.collection('potholes').doc(id));
      const snapshotPotDocs =
        snapshotPotRefs.length > 0 ? await tx.getAll(...snapshotPotRefs) : [];

      let sumLat = 0;
      let sumLng = 0;
      let validCount = 0;
      const contribUidSet = new Set<string>();

      for (const snap of snapshotPotDocs) {
        if (!snap.exists) continue;
        const pData = snap.data()!;
        sumLat += Number(pData.lat || 0);
        sumLng += Number(pData.lng || 0);
        validCount += 1;
        if (typeof pData.primaryContributorUid === 'string') {
          contribUidSet.add(pData.primaryContributorUid);
        }
      }

      const centerLat = validCount > 0 ? Number((sumLat / validCount).toFixed(6)) : Number(seg.anchorLat);
      const centerLng = validCount > 0 ? Number((sumLng / validCount).toFixed(6)) : Number(seg.anchorLng);

      tx.set(existingReportRef, {
        reportId: deterministicReportId,
        segmentId,
        cycleNumber,
        streetName: String(seg.streetName || pot.streetName).slice(0, 128),
        corridorLabel: String(seg.corridorLabel || seg.streetName).slice(0, 160),
        jurisdiction: (seg.jurisdiction as JurisdictionType) || 'unknown',
        status: 'awaiting_admin_review',
        distinctPotholeCount: snapshotIds.length,
        supplementCount: 0,
        snapshotPotholeIds: snapshotIds,
        centerLat,
        centerLng,
        addressRange: String(seg.corridorLabel || seg.streetName).slice(0, 200),
        evidenceMateriallyChanged: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      tx.update(segRef, {
        distinctAcceptedCount: nextTotalDistinct,
        currentCycleDistinctCount: nextCycleDistinctCount,
        activeReportId: deterministicReportId,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        segmentId,
        cycleNumber,
        currentCycleDistinctCount: nextCycleDistinctCount,
        reportId: deterministicReportId,
        reportCreated: true,
        notifyUids: Array.from(contribUidSet),
        corridorLabel: String(seg.corridorLabel || seg.streetName),
      };
    }

    tx.update(segRef, {
      distinctAcceptedCount: nextTotalDistinct,
      currentCycleDistinctCount: nextCycleDistinctCount,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      segmentId,
      cycleNumber,
      currentCycleDistinctCount: nextCycleDistinctCount,
      reportId: activeReportId,
      reportCreated: false,
      notifyUids: [] as string[],
      corridorLabel: String(seg.corridorLabel || seg.streetName),
    };
  });

  if (txResult.reportCreated && txResult.reportId) {
    const adminsSnap = await db.collection('admins').limit(10).get();
    const adminUids = adminsSnap.docs.map((d) => d.id);
    const allTargets = Array.from(new Set([...txResult.notifyUids, ...adminUids]));

    await Promise.all(
      allTargets.map((uid) =>
        createNotification(db, {
          uid,
          notificationId: `thresh_${txResult.reportId}_${uid}`.slice(0, 128),
          type: 'segment_threshold',
          title: '5-Pothole Street Report Triggered',
          body: `${txResult.corridorLabel} reached ${txResult.currentCycleDistinctCount} distinct potholes and entered admin review.`,
          relatedId: txResult.reportId!,
        }).catch(() => {})
      )
    );
  }

  return {
    segmentId: txResult.segmentId,
    cycleNumber: txResult.cycleNumber,
    currentCycleDistinctCount: txResult.currentCycleDistinctCount,
    reportId: txResult.reportId,
    reportCreated: txResult.reportCreated,
  };
}

export async function recountSegmentTransactionally(
  db: Firestore,
  segmentId: string
): Promise<{
  distinctAcceptedCount: number;
  currentCycleDistinctCount: number;
  reportCreated: boolean;
  reportId: string | null;
}> {
  const result = await db.runTransaction(async (tx) => {
    const segRef = db.collection('streetSegments').doc(segmentId);
    const segSnap = await tx.get(segRef);
    if (!segSnap.exists) {
      throw new Error('Street segment not found.');
    }
    const seg = segSnap.data()!;
    const cycleNumber = Number(seg.currentCycleNumber || 1);
    const activeReportId =
      typeof seg.activeReportId === 'string' && seg.activeReportId ? seg.activeReportId : null;
    const deterministicReportId = `rep_${segmentId}_c${cycleNumber}`;
    const reportRef = db.collection('reports').doc(activeReportId || deterministicReportId);

    const [potholesSnap, membersSnap, reportSnap] = await Promise.all([
      tx.get(db.collection('potholes').where('segmentId', '==', segmentId)),
      tx.get(segRef.collection('acceptedPotholes')),
      tx.get(reportRef),
    ]);

    const existingMemberMap = new Map<string, FirebaseFirestore.DocumentData>();
    membersSnap.docs.forEach((d) => existingMemberMap.set(d.id, d.data()));

    let distinctAcceptedCount = 0;
    let currentCycleDistinctCount = 0;
    const activeCycleIds: string[] = [];
    const contribUids = new Set<string>();
    let sumLat = 0;
    let sumLng = 0;
    let minBlock: number | null = null;
    let maxBlock: number | null = null;
    let minLat = Number(seg.anchorLat);
    let maxLat = Number(seg.anchorLat);
    let minLng = Number(seg.anchorLng);
    let maxLng = Number(seg.anchorLng);

    for (const pDoc of potholesSnap.docs) {
      const p = pDoc.data();
      const status = String(p.status);
      const existingMember = existingMemberMap.get(pDoc.id);
      const pLat = Number(p.lat);
      const pLng = Number(p.lng);

      if (!ACCEPTED_HISTORICAL_STATUSES.has(status)) {
        if (existingMember) {
          tx.delete(segRef.collection('acceptedPotholes').doc(pDoc.id));
        }
        continue;
      }

      distinctAcceptedCount += 1;
      minLat = Math.min(minLat, pLat);
      maxLat = Math.max(maxLat, pLat);
      minLng = Math.min(minLng, pLng);
      maxLng = Math.max(maxLng, pLng);

      const bNum = parseStreetNumber(String(p.formattedAddress || ''));
      if (bNum !== null) {
        minBlock = minBlock !== null ? Math.min(minBlock, bNum) : bNum;
        maxBlock = maxBlock !== null ? Math.max(maxBlock, bNum) : bNum;
      }

      const memberCycle = existingMember ? Number(existingMember.cycleNumber || cycleNumber) : cycleNumber;
      const qualifiesForActiveCycle =
        memberCycle === cycleNumber && ACTIVE_CYCLE_POTHOLE_STATUSES.has(status);

      if (qualifiesForActiveCycle) {
        currentCycleDistinctCount += 1;
        activeCycleIds.push(pDoc.id);
        sumLat += pLat;
        sumLng += pLng;
        if (typeof p.primaryContributorUid === 'string') {
          contribUids.add(p.primaryContributorUid);
        }
      }

      tx.set(
        segRef.collection('acceptedPotholes').doc(pDoc.id),
        {
          potholeId: pDoc.id,
          segmentId,
          cycleNumber: memberCycle,
          countedForThreshold: qualifiesForActiveCycle,
          streetName: String(p.streetName || seg.streetName).slice(0, 128),
          lat: pLat,
          lng: pLng,
          addedAt: existingMember?.addedAt || FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    const updatedCorridorLabel = buildBlockRangeLabel(
      String(seg.streetName),
      minBlock,
      maxBlock
    ).slice(0, 160);

    let reportCreated = false;
    let finalActiveReportId = activeReportId;

    if (reportSnap.exists && reportSnap.data()?.status !== 'closed' && reportSnap.data()?.status !== 'resolved') {
      const rData = reportSnap.data()!;
      const prevSnapshots = Array.isArray(rData.snapshotPotholeIds)
        ? (rData.snapshotPotholeIds as string[])
        : [];
      const changed =
        prevSnapshots.length !== activeCycleIds.length ||
        prevSnapshots.some((id) => !activeCycleIds.includes(id));

      if (changed) {
        tx.update(reportRef, {
          evidenceMateriallyChanged: true,
          distinctPotholeCount: activeCycleIds.length,
          snapshotPotholeIds: activeCycleIds,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    } else if (
      seg.confidence === 'verified' &&
      currentCycleDistinctCount >= THRESHOLD_DISTINCT_COUNT &&
      !reportSnap.exists
    ) {
      reportCreated = true;
      finalActiveReportId = deterministicReportId;
      const centerLat = Number((sumLat / activeCycleIds.length).toFixed(6));
      const centerLng = Number((sumLng / activeCycleIds.length).toFixed(6));

      tx.set(reportRef, {
        reportId: deterministicReportId,
        segmentId,
        cycleNumber,
        streetName: String(seg.streetName).slice(0, 128),
        corridorLabel: updatedCorridorLabel,
        jurisdiction: (seg.jurisdiction as JurisdictionType) || 'unknown',
        status: 'awaiting_admin_review',
        distinctPotholeCount: activeCycleIds.length,
        supplementCount: 0,
        snapshotPotholeIds: activeCycleIds,
        centerLat,
        centerLng,
        addressRange: updatedCorridorLabel.slice(0, 200),
        evidenceMateriallyChanged: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    tx.update(segRef, {
      corridorLabel: updatedCorridorLabel,
      minLat,
      maxLat,
      minLng,
      maxLng,
      ...(minBlock !== null ? { minBlock } : {}),
      ...(maxBlock !== null ? { maxBlock } : {}),
      distinctAcceptedCount,
      currentCycleDistinctCount,
      ...(finalActiveReportId ? { activeReportId: finalActiveReportId } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      distinctAcceptedCount,
      currentCycleDistinctCount,
      reportCreated,
      reportId: finalActiveReportId,
      notifyUids: Array.from(contribUids),
      corridorLabel: updatedCorridorLabel,
    };
  });

  if (result.reportCreated && result.reportId) {
    await Promise.all(
      result.notifyUids.map((uid) =>
        createNotification(db, {
          uid,
          notificationId: `thresh_${result.reportId}_${uid}`.slice(0, 128),
          type: 'segment_threshold',
          title: '5-Pothole Street Report Triggered',
          body: `${result.corridorLabel} reached ${result.currentCycleDistinctCount} distinct potholes and entered admin review.`,
          relatedId: result.reportId!,
        }).catch(() => {})
      )
    );
  }

  return {
    distinctAcceptedCount: result.distinctAcceptedCount,
    currentCycleDistinctCount: result.currentCycleDistinctCount,
    reportCreated: result.reportCreated,
    reportId: result.reportId,
  };
}

export async function adminReviewPothole(
  db: Firestore,
  params: {
    potholeId: string;
    status?: string;
    severityLabel?: string;
    streetName?: string;
    jurisdiction?: JurisdictionType;
    segmentConfidence?: SegmentConfidence;
    reason: string;
    actor: AdminActor;
  }
): Promise<{
  potholeId: string;
  status: string;
  segmentId: string | null;
  recount: Awaited<ReturnType<typeof recountSegmentTransactionally>> | null;
}> {
  const potRef = db.collection('potholes').doc(params.potholeId);
  const potSnap = await potRef.get();
  if (!potSnap.exists) {
    throw new Error('Pothole record not found.');
  }
  const prev = potSnap.data()!;
  const prevStatus = String(prev.status || 'accepted');

  const nextStatus = params.status || prevStatus;
  const nextStreet = params.streetName?.trim() || String(prev.streetName || 'Atlanta Street');
  const nextNormalizedStreet = normalizeStreetName(nextStreet) || String(prev.normalizedStreet || '');
  const nextJurisdiction =
    params.jurisdiction ||
    classifyJurisdiction(nextStreet, String(prev.formattedAddress || ''), String(prev.city || 'Atlanta'));
  const nextSeverity = params.severityLabel || String(prev.severityLabel || 'unclassified');

  const updates: Record<string, unknown> = {
    status: nextStatus,
    verificationStatus:
      nextStatus === 'rejected'
        ? 'rejected'
        : nextStatus === 'provisional'
          ? 'needs_review'
          : 'accepted',
    severityLabel: nextSeverity,
    streetName: nextStreet.slice(0, 128),
    normalizedStreet: nextNormalizedStreet.slice(0, 128),
    jurisdiction: nextJurisdiction,
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (params.segmentConfidence) {
    updates.segmentConfidence = params.segmentConfidence;
  }

  await potRef.update(updates);

  let segmentId = typeof prev.segmentId === 'string' && prev.segmentId ? prev.segmentId : null;
  if (!segmentId && ACCEPTED_HISTORICAL_STATUSES.has(nextStatus)) {
    const resolved = await resolveOrCreateStreetSegment(db, {
      potholeId: params.potholeId,
      lat: Number(prev.lat),
      lng: Number(prev.lng),
      streetName: nextStreet,
      normalizedStreet: nextNormalizedStreet,
      formattedAddress: String(prev.formattedAddress || ''),
      neighborhood: typeof prev.neighborhood === 'string' ? prev.neighborhood : undefined,
      city: String(prev.city || 'Atlanta'),
      state: String(prev.state || 'GA'),
      jurisdiction: nextJurisdiction,
    });
    segmentId = resolved.segmentId;
  }

  if (segmentId && params.segmentConfidence) {
    await db.collection('streetSegments').doc(segmentId).update({
      confidence: params.segmentConfidence,
      jurisdiction: nextJurisdiction,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  // If newly marked confirmed repaired, evaluate Community Champion & emit repair notifications
  if (nextStatus === 'repaired' && prevStatus !== 'repaired') {
    const contribUid = String(prev.primaryContributorUid || '');
    const contribUsername = String(prev.primaryContributorUsername || 'atlanta_user');
    const contribDisplay = String(prev.primaryContributorDisplayName || 'Contributor');
    if (contribUid) {
      await Promise.all([
        evaluateUserAchievements(db, contribUid, true).catch(() => {}),
        createNotification(db, {
          uid: contribUid,
          notificationId: `repair_${params.potholeId}_${contribUid}`.slice(0, 128),
          type: 'confirmed_repair',
          title: 'Confirmed Street Repair',
          body: `Your documented pothole on ${nextStreet} was confirmed repaired.`,
          relatedId: params.potholeId,
        }).catch(() => {}),
        createActivityFeedEvent(db, {
          actorUid: contribUid,
          actorUsername: contribUsername,
          actorDisplayName: contribDisplay,
          eventType: 'confirmed_repair',
          summary: `Pothole documented by @${contribUsername} on ${nextStreet} confirmed repaired`,
          streetName: nextStreet,
          neighborhood: typeof prev.neighborhood === 'string' ? prev.neighborhood : undefined,
          potholeId: params.potholeId,
        }).catch(() => {}),
      ]);
    }
  }

  const recount = segmentId ? await recountSegmentTransactionally(db, segmentId) : null;

  await writeAdminAudit(db, {
    actor: params.actor,
    action: 'pothole_review',
    targetType: 'pothole',
    targetId: params.potholeId,
    reason: params.reason,
    beforeSummary: `status=${prevStatus}, street=${prev.streetName}, jur=${prev.jurisdiction}`,
    afterSummary: `status=${nextStatus}, street=${nextStreet}, jur=${nextJurisdiction}, seg=${segmentId ?? 'none'}`,
  });

  return {
    potholeId: params.potholeId,
    status: nextStatus,
    segmentId,
    recount,
  };
}

export async function adminReassignPotholeSegment(
  db: Firestore,
  params: {
    potholeId: string;
    targetSegmentId?: string;
    createNewCorridor?: boolean;
    streetName?: string;
    jurisdiction?: JurisdictionType;
    confidence?: SegmentConfidence;
    reason: string;
    actor: AdminActor;
  }
): Promise<{
  potholeId: string;
  oldSegmentId: string | null;
  newSegmentId: string;
}> {
  const potRef = db.collection('potholes').doc(params.potholeId);
  const potSnap = await potRef.get();
  if (!potSnap.exists) throw new Error('Pothole record not found.');
  const pot = potSnap.data()!;
  const oldSegmentId = typeof pot.segmentId === 'string' ? pot.segmentId : null;

  let newSegmentId = params.targetSegmentId?.trim() || '';
  const nextConfidence: SegmentConfidence = params.confidence || 'verified';

  if (params.createNewCorridor || !newSegmentId) {
    const cleanStreet = (params.streetName?.trim() || String(pot.streetName || 'Atlanta Street'))
      .replace(/^\d+[a-z]?\s+/i, '')
      .trim();
    const normStreet = normalizeStreetName(cleanStreet) || 'unverified street';
    const jur = params.jurisdiction || (pot.jurisdiction as JurisdictionType) || 'atldot';
    const bNum = parseStreetNumber(String(pot.formattedAddress || ''));
    newSegmentId = makeSegmentSlug(normStreet, Number(pot.lat), Number(pot.lng));
    const corridorLabel = buildBlockRangeLabel(cleanStreet, bNum, bNum).slice(0, 160);

    await db.collection('streetSegments').doc(newSegmentId).set({
      segmentId: newSegmentId,
      streetName: cleanStreet.slice(0, 128),
      normalizedStreet: normStreet.slice(0, 128),
      corridorLabel,
      city: String(pot.city || 'Atlanta').slice(0, 64),
      state: String(pot.state || 'GA').slice(0, 32),
      ...(pot.neighborhood ? { neighborhood: String(pot.neighborhood).slice(0, 64) } : {}),
      jurisdiction: jur,
      confidence: nextConfidence,
      anchorLat: Number(pot.lat),
      anchorLng: Number(pot.lng),
      minLat: Number(pot.lat),
      maxLat: Number(pot.lat),
      minLng: Number(pot.lng),
      maxLng: Number(pot.lng),
      ...(bNum !== null ? { minBlock: bNum, maxBlock: bNum } : {}),
      distinctAcceptedCount: 0,
      currentCycleNumber: 1,
      currentCycleDistinctCount: 0,
      status: 'active',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } else {
    const targetSegSnap = await db.collection('streetSegments').doc(newSegmentId).get();
    if (!targetSegSnap.exists || targetSegSnap.data()?.status !== 'active') {
      throw new Error('Target active street segment not found.');
    }
    if (params.confidence) {
      await targetSegSnap.ref.update({
        confidence: params.confidence,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  await potRef.update({
    segmentId: newSegmentId,
    segmentConfidence: nextConfidence,
    ...(params.jurisdiction ? { jurisdiction: params.jurisdiction } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });

  if (oldSegmentId && oldSegmentId !== newSegmentId) {
    await db
      .collection('streetSegments')
      .doc(oldSegmentId)
      .collection('acceptedPotholes')
      .doc(params.potholeId)
      .delete()
      .catch(() => {});
    await recountSegmentTransactionally(db, oldSegmentId).catch(() => {});
  }

  await recountSegmentTransactionally(db, newSegmentId);

  await writeAdminAudit(db, {
    actor: params.actor,
    action: 'segment_reassign',
    targetType: 'pothole',
    targetId: params.potholeId,
    reason: params.reason,
    beforeSummary: `segment=${oldSegmentId ?? 'none'}`,
    afterSummary: `segment=${newSegmentId}, confidence=${nextConfidence}`,
  });

  return {
    potholeId: params.potholeId,
    oldSegmentId,
    newSegmentId,
  };
}

export async function adminMergeSegments(
  db: Firestore,
  params: {
    sourceSegmentId: string;
    targetSegmentId: string;
    reason: string;
    actor: AdminActor;
  }
): Promise<{ mergedCount: number; targetSegmentId: string }> {
  if (params.sourceSegmentId === params.targetSegmentId) {
    throw new Error('Source and target segments must be different.');
  }
  const [srcSnap, dstSnap] = await Promise.all([
    db.collection('streetSegments').doc(params.sourceSegmentId).get(),
    db.collection('streetSegments').doc(params.targetSegmentId).get(),
  ]);
  if (!srcSnap.exists || !dstSnap.exists) {
    throw new Error('Both source and target segments must exist.');
  }
  if (dstSnap.data()?.status !== 'active') {
    throw new Error('Target segment must be active.');
  }

  const potholesSnap = await db
    .collection('potholes')
    .where('segmentId', '==', params.sourceSegmentId)
    .get();

  const targetConfidence = (dstSnap.data()!.confidence as SegmentConfidence) || 'verified';

  const batch = db.batch();
  potholesSnap.docs.forEach((docSnap) => {
    batch.update(docSnap.ref, {
      segmentId: params.targetSegmentId,
      segmentConfidence: targetConfidence,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const srcMembersSnap = await srcSnap.ref.collection('acceptedPotholes').get();
  srcMembersSnap.docs.forEach((mDoc) => batch.delete(mDoc.ref));

  batch.update(srcSnap.ref, {
    status: 'merged',
    distinctAcceptedCount: 0,
    currentCycleDistinctCount: 0,
    activeReportId: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  await recountSegmentTransactionally(db, params.targetSegmentId);

  await writeAdminAudit(db, {
    actor: params.actor,
    action: 'segment_merge',
    targetType: 'segment',
    targetId: params.targetSegmentId,
    reason: params.reason,
    beforeSummary: `source=${params.sourceSegmentId} (${potholesSnap.size} potholes)`,
    afterSummary: `merged into target=${params.targetSegmentId}`,
  });

  return {
    mergedCount: potholesSnap.size,
    targetSegmentId: params.targetSegmentId,
  };
}

export async function adminSplitSegment(
  db: Firestore,
  params: {
    sourceSegmentId: string;
    splitPotholeIds: string[];
    newCorridorLabel?: string;
    reason: string;
    actor: AdminActor;
  }
): Promise<{ newSegmentId: string; movedCount: number }> {
  if (params.splitPotholeIds.length === 0) {
    throw new Error('Select at least one pothole to split into a new corridor.');
  }

  const srcSnap = await db.collection('streetSegments').doc(params.sourceSegmentId).get();
  if (!srcSnap.exists) throw new Error('Source street segment not found.');
  const srcData = srcSnap.data()!;

  const potRefs = params.splitPotholeIds.map((id) => db.collection('potholes').doc(id));
  const potDocs = await db.getAll(...potRefs);
  const validPots = potDocs.filter(
    (d) => d.exists && d.data()?.segmentId === params.sourceSegmentId
  );
  if (validPots.length === 0) {
    throw new Error('No matching potholes on source segment selected for split.');
  }

  const firstPot = validPots[0].data()!;
  const newSegmentId = makeSegmentSlug(
    String(srcData.normalizedStreet || 'corridor'),
    Number(firstPot.lat),
    Number(firstPot.lng)
  );
  const label =
    params.newCorridorLabel?.trim().slice(0, 160) ||
    `${String(srcData.streetName)} (Split Corridor)`.slice(0, 160);

  await db.collection('streetSegments').doc(newSegmentId).set({
    segmentId: newSegmentId,
    streetName: String(srcData.streetName).slice(0, 128),
    normalizedStreet: String(srcData.normalizedStreet).slice(0, 128),
    corridorLabel: label,
    city: String(srcData.city || 'Atlanta').slice(0, 64),
    state: String(srcData.state || 'GA').slice(0, 32),
    ...(srcData.neighborhood ? { neighborhood: String(srcData.neighborhood).slice(0, 64) } : {}),
    jurisdiction: (srcData.jurisdiction as JurisdictionType) || 'atldot',
    confidence: (srcData.confidence as SegmentConfidence) || 'verified',
    anchorLat: Number(firstPot.lat),
    anchorLng: Number(firstPot.lng),
    minLat: Number(firstPot.lat),
    maxLat: Number(firstPot.lat),
    minLng: Number(firstPot.lng),
    maxLng: Number(firstPot.lng),
    distinctAcceptedCount: 0,
    currentCycleNumber: 1,
    currentCycleDistinctCount: 0,
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const batch = db.batch();
  for (const pDoc of validPots) {
    batch.update(pDoc.ref, {
      segmentId: newSegmentId,
      updatedAt: FieldValue.serverTimestamp(),
    });
    batch.delete(srcSnap.ref.collection('acceptedPotholes').doc(pDoc.id));
  }
  await batch.commit();

  await Promise.all([
    recountSegmentTransactionally(db, params.sourceSegmentId),
    recountSegmentTransactionally(db, newSegmentId),
  ]);

  await writeAdminAudit(db, {
    actor: params.actor,
    action: 'segment_split',
    targetType: 'segment',
    targetId: newSegmentId,
    reason: params.reason,
    beforeSummary: `source=${params.sourceSegmentId}`,
    afterSummary: `created=${newSegmentId} with ${validPots.length} potholes`,
  });

  return { newSegmentId, movedCount: validPots.length };
}

export async function adminTransitionReportStatus(
  db: Firestore,
  params: {
    reportId: string;
    status: ReportStatus;
    externalReference?: string;
    submissionChannel?: string;
    adminReviewNotes?: string;
    reason: string;
    actor: AdminActor;
  }
): Promise<{ reportId: string; status: ReportStatus; cycleClosed: boolean }> {
  const reportRef = db.collection('reports').doc(params.reportId);

  const txOutcome = await db.runTransaction(async (tx) => {
    const reportSnap = await tx.get(reportRef);
    if (!reportSnap.exists) {
      throw new Error('Civic report record not found.');
    }
    const report = reportSnap.data()!;
    const currentStatus = report.status as ReportStatus;

    const allowedNext = ALLOWED_REPORT_TRANSITIONS[currentStatus] || [];
    if (!allowedNext.includes(params.status)) {
      throw new Error(
        `Invalid report status transition from '${currentStatus}' to '${params.status}'.`
      );
    }

    const cleanExtRef = params.externalReference?.trim().slice(0, 128) || '';
    const cleanChannel = params.submissionChannel?.trim().slice(0, 128) || '';
    const cleanNotes = params.adminReviewNotes?.trim().slice(0, 500) || '';

    if (params.status === 'submitted') {
      if (!cleanExtRef || !cleanChannel) {
        throw new Error(
          'External agency case reference AND submission channel are required before marking a report Submitted.'
        );
      }
    }

    const segmentId = String(report.segmentId);
    const segRef = db.collection('streetSegments').doc(segmentId);
    const segSnap = await tx.get(segRef);

    const snapshotIds = Array.isArray(report.snapshotPotholeIds)
      ? (report.snapshotPotholeIds as string[])
      : [];
    const potDocs =
      snapshotIds.length > 0
        ? await tx.getAll(...snapshotIds.map((id) => db.collection('potholes').doc(id)))
        : [];

    const contribUids = new Set<string>();
    for (const pDoc of potDocs) {
      if (pDoc.exists && typeof pDoc.data()?.primaryContributorUid === 'string') {
        contribUids.add(String(pDoc.data()!.primaryContributorUid));
      }
    }

    const reportUpdates: Record<string, unknown> = {
      status: params.status,
      updatedAt: FieldValue.serverTimestamp(),
      ...(cleanExtRef ? { externalReference: cleanExtRef } : {}),
      ...(cleanChannel ? { submissionChannel: cleanChannel } : {}),
      ...(cleanNotes ? { adminReviewNotes: cleanNotes } : {}),
      ...(params.status === 'submitted' ? { submittedByUid: params.actor.uid } : {}),
    };

    const isCycleClose = params.status === 'resolved' || params.status === 'closed';
    if (isCycleClose) {
      reportUpdates.cutoffAt = FieldValue.serverTimestamp();
    }

    tx.update(reportRef, reportUpdates);

    // Sync member pothole statuses when submitted/acknowledged/resolved
    if (params.status === 'submitted') {
      for (const pDoc of potDocs) {
        if (pDoc.exists && pDoc.data()?.status === 'accepted') {
          tx.update(pDoc.ref, {
            status: 'reported',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    } else if (params.status === 'acknowledged') {
      for (const pDoc of potDocs) {
        if (
          pDoc.exists &&
          (pDoc.data()?.status === 'accepted' || pDoc.data()?.status === 'reported')
        ) {
          tx.update(pDoc.ref, {
            status: 'acknowledged',
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }
    }

    if (isCycleClose && segSnap.exists) {
      const segData = segSnap.data()!;
      const nextCycle = Number(segData.currentCycleNumber || 1) + 1;
      tx.update(segRef, {
        activeReportId: FieldValue.delete(),
        lastCutoffAt: FieldValue.serverTimestamp(),
        currentCycleNumber: nextCycle,
        currentCycleDistinctCount: 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      prevStatus: currentStatus,
      corridorLabel: String(report.corridorLabel || report.streetName),
      cycleClosed: isCycleClose,
      contribUids: Array.from(contribUids),
      cleanExtRef,
    };
  });

  if (
    params.status === 'submitted' ||
    params.status === 'acknowledged' ||
    params.status === 'resolved'
  ) {
    const labelMap: Record<string, string> = {
      submitted: `Submitted (${txOutcome.cleanExtRef})`,
      acknowledged: 'Acknowledged by agency',
      resolved: 'Resolved & cycle closed',
    };
    await Promise.all(
      txOutcome.contribUids.map((uid) =>
        createNotification(db, {
          uid,
          notificationId: `rep_${params.reportId}_${params.status}_${uid}`.slice(0, 128),
          type: 'report_status',
          title: `Report Update: ${txOutcome.corridorLabel}`,
          body: `Street report status updated to ${labelMap[params.status] || params.status}.`,
          relatedId: params.reportId,
        }).catch(() => {})
      )
    );
  }

  await writeAdminAudit(db, {
    actor: params.actor,
    action: 'report_status_transition',
    targetType: 'report',
    targetId: params.reportId,
    reason: params.reason,
    beforeSummary: `status=${txOutcome.prevStatus}`,
    afterSummary: `status=${params.status}${
      params.externalReference ? `, ref=${params.externalReference}` : ''
    }${txOutcome.cycleClosed ? ', cycle_closed=true' : ''}`,
  });

  return {
    reportId: params.reportId,
    status: params.status,
    cycleClosed: txOutcome.cycleClosed,
  };
}

export async function backfillAcceptedPotholeSegments(db: Firestore): Promise<number> {
  const snap = await db.collection('potholes').limit(120).get();
  let updated = 0;

  for (const docSnap of snap.docs) {
    const p = docSnap.data();
    const status = String(p.status || 'accepted');
    if (status === 'rejected' || status === 'provisional') continue;
    if (typeof p.segmentId === 'string' && p.segmentId.length > 0) continue;

    try {
      await evaluateSegmentMembershipAndThreshold(db, docSnap.id);
      updated += 1;
    } catch {
      // Non-fatal individual backfill error
    }
  }
  return updated;
}

export type { Timestamp };

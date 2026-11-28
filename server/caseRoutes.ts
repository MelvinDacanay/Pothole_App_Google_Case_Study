import type { Express, Request, Response } from 'express';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { DecodedIdToken } from 'firebase-admin/auth';
import {
  deriveFollowUpStatus,
  ESCALATION_REASONS,
  evaluateCaseNotifications,
  reasonKind,
  sanitizeCaseText,
  type FollowUpAction,
} from './cases.ts';

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

type VerifyBearer = (
  req: Request,
  res: Response,
  requireVerifiedEmail?: boolean
) => Promise<DecodedIdToken | null>;

async function userNotificationsEnabled(db: Firestore, uid: string): Promise<boolean> {
  try {
    const snap = await db.collection('users').doc(uid).collection('private').doc('account').get();
    if (!snap.exists) return true;
    return snap.data()?.notificationsEnabled !== false;
  } catch {
    return false;
  }
}

export function registerCaseRoutes(
  app: Express,
  deps: {
    verifyBearerToken: VerifyBearer;
    getServerFirestore: () => Firestore | null;
    isFirestoreReady: () => boolean;
  }
) {
  const { verifyBearerToken, getServerFirestore, isFirestoreReady } = deps;

  app.post('/api/cases/log', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;
    const serverDb = getServerFirestore();
    if (!serverDb || !isFirestoreReady()) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    const body = req.body ?? {};
    const potholeId = typeof body.potholeId === 'string' ? body.potholeId.trim() : '';
    if (!SAFE_ID_REGEX.test(potholeId)) {
      res.status(400).json({ error: 'Valid potholeId is required.' });
      return;
    }

    const ALLOWED_CHANNELS = new Set(['atl311', 'gdot', 'email', 'other']);
    const ALLOWED_METHODS = new Set(['official_portal', 'phone', 'email']);
    const ALLOWED_CASE_STATUSES = new Set([
      'drafted',
      'submitted_unconfirmed',
      'case_logged',
      'acknowledged',
      'resolved',
      'reopened',
    ]);
    const channel = ALLOWED_CHANNELS.has(String(body.channel)) ? String(body.channel) : '';
    const reportMethod = ALLOWED_METHODS.has(String(body.reportMethod)) ? String(body.reportMethod) : '';
    const externalCaseRef =
      typeof body.externalCaseRef === 'string'
        ? body.externalCaseRef.replace(/[^\w\s#/\-.]/g, '').trim().slice(0, 64)
        : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 400) : '';
    let requestedStatus = ALLOWED_CASE_STATUSES.has(String(body.status)) ? String(body.status) : '';
    if (
      externalCaseRef &&
      (!requestedStatus || requestedStatus === 'drafted' || requestedStatus === 'submitted_unconfirmed')
    ) {
      requestedStatus = 'case_logged';
    }

    try {
      const potholeSnap = await serverDb.collection('potholes').doc(potholeId).get();
      if (!potholeSnap.exists) {
        res.status(404).json({ error: 'Pothole record not found.' });
        return;
      }
      const pothole = potholeSnap.data()!;
      if (pothole.primaryContributorUid !== decoded.uid) {
        res.status(403).json({ error: 'You can only track official cases for potholes you reported.' });
        return;
      }

      const existingSnap = await serverDb
        .collection('potholeCases')
        .where('userId', '==', decoded.uid)
        .where('potholeId', '==', potholeId)
        .limit(1)
        .get();

      const nowMillis = Date.now();
      const eventType = externalCaseRef
        ? 'case_ref_logged'
        : requestedStatus === 'resolved'
          ? 'agency_closed'
          : requestedStatus === 'reopened'
            ? 'reopened'
            : requestedStatus === 'acknowledged'
              ? 'agency_acknowledged'
              : requestedStatus === 'submitted_unconfirmed'
                ? 'marked_submitted'
                : 'draft_saved';
      const event = {
        type: eventType,
        ...(notes ? { note: notes } : {}),
        ...(externalCaseRef ? { externalCaseRef } : {}),
        atMillis: nowMillis,
      };

      if (existingSnap.empty) {
        const caseId = `cas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const status = requestedStatus || 'drafted';
        await serverDb.collection('potholeCases').doc(caseId).set({
          caseId,
          userId: decoded.uid,
          potholeId,
          streetName: String(pothole.streetName || 'Unverified Street'),
          formattedAddress: String(pothole.formattedAddress || ''),
          lat: Number(pothole.lat),
          lng: Number(pothole.lng),
          jurisdiction: String(pothole.jurisdiction || 'unknown'),
          channel: channel || (pothole.jurisdiction === 'gdot' ? 'gdot' : 'atl311'),
          ...(reportMethod ? { reportMethod } : {}),
          status,
          ...(externalCaseRef ? { externalCaseRef } : {}),
          ...(pothole.primaryPhotoUrl ? { primaryPhotoUrl: String(pothole.primaryPhotoUrl) } : {}),
          ...(pothole.primaryMediaId ? { primaryMediaId: String(pothole.primaryMediaId) } : {}),
          ...(notes ? { notes } : {}),
          events: [event],
          ...(status === 'submitted_unconfirmed' || status === 'case_logged'
            ? { submittedAt: FieldValue.serverTimestamp() }
            : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        res.status(201).json({ ok: true, caseId });
        return;
      }

      const existingDoc = existingSnap.docs[0];
      const existing = existingDoc.data();
      const prevStatus = String(existing.status || 'drafted');
      const STAGE: Record<string, number> = {
        drafted: 0,
        submitted_unconfirmed: 1,
        case_logged: 2,
        acknowledged: 3,
        resolved: 4,
        reopened: 1,
      };
      const nextStatus =
        requestedStatus && (STAGE[requestedStatus] ?? 0) >= (STAGE[prevStatus] ?? 0)
          ? requestedStatus
          : prevStatus;
      const update: Record<string, unknown> = {
        status: nextStatus,
        events: FieldValue.arrayUnion(event),
        updatedAt: FieldValue.serverTimestamp(),
        ...(channel ? { channel } : {}),
        ...(reportMethod ? { reportMethod } : {}),
        ...(externalCaseRef ? { externalCaseRef } : {}),
        ...(notes ? { notes } : {}),
      };
      if (!existing.submittedAt && (nextStatus === 'submitted_unconfirmed' || nextStatus === 'case_logged')) {
        update.submittedAt = FieldValue.serverTimestamp();
      }
      await existingDoc.ref.update(update);
      res.json({ ok: true, caseId: String(existing.caseId || existingDoc.id) });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to log official case.',
        detail: err instanceof Error ? err.message : 'Case write failed',
      });
    }
  });

  app.post('/api/cases/deadline', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;
    const serverDb = getServerFirestore();
    if (!serverDb || !isFirestoreReady()) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }
    const body = req.body ?? {};
    const caseId = typeof body.caseId === 'string' ? body.caseId.trim() : '';
    if (!SAFE_ID_REGEX.test(caseId)) {
      res.status(400).json({ error: 'Valid caseId is required.' });
      return;
    }
    const hasExpected = body.expectedCompletionAtMillis != null;
    const clearExpected = body.clearDeadline === true;
    const expectedMillis = Number(body.expectedCompletionAtMillis);
    const hasPersonal = body.personalFollowUpAtMillis != null;
    const clearPersonal = body.clearPersonalReminder === true;
    const personalMillis = Number(body.personalFollowUpAtMillis);
    const citation = sanitizeCaseText(body.deadlineCitation, 160);
    if (hasExpected && (!Number.isFinite(expectedMillis) || expectedMillis <= 0)) {
      res.status(400).json({ error: 'expectedCompletionAtMillis must be a valid timestamp.' });
      return;
    }
    if (hasPersonal && (!Number.isFinite(personalMillis) || personalMillis <= 0)) {
      res.status(400).json({ error: 'personalFollowUpAtMillis must be a valid timestamp.' });
      return;
    }

    try {
      const caseRef = serverDb.collection('potholeCases').doc(caseId);
      const caseSnap = await caseRef.get();
      if (!caseSnap.exists || caseSnap.data()?.userId !== decoded.uid) {
        res.status(404).json({ error: 'Case not found.' });
        return;
      }
      const existing = caseSnap.data()!;
      const nowMillis = Date.now();
      const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
      const events: Array<Record<string, unknown>> = [];
      if (clearExpected) {
        update.expectedCompletionAt = FieldValue.delete();
        update.deadlineSource = FieldValue.delete();
        update.deadlineCitation = FieldValue.delete();
        update.deadlineRecordedAt = FieldValue.delete();
        events.push({ type: 'deadline_cleared', atMillis: nowMillis });
      } else if (hasExpected) {
        const prevMs = (existing.expectedCompletionAt as Timestamp | undefined)?.toMillis?.();
        update.expectedCompletionAt = Timestamp.fromMillis(expectedMillis);
        update.deadlineSource = 'user_recorded_from_agency';
        update.deadlineRecordedAt = FieldValue.serverTimestamp();
        if (citation) update.deadlineCitation = citation;
        events.push({
          type: prevMs ? 'deadline_changed' : 'deadline_recorded',
          ...(citation ? { note: citation } : {}),
          atMillis: nowMillis,
        });
      }
      if (clearPersonal) {
        update.personalFollowUpAt = FieldValue.delete();
        events.push({ type: 'personal_reminder_cleared', atMillis: nowMillis });
      } else if (hasPersonal) {
        update.personalFollowUpAt = Timestamp.fromMillis(personalMillis);
        events.push({ type: 'personal_reminder_set', atMillis: nowMillis });
      }
      if (events.length === 0) {
        res.status(400).json({ error: 'Nothing to update.' });
        return;
      }
      update.events = FieldValue.arrayUnion(...events);
      await caseRef.update(update);
      res.json({ ok: true, caseId });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to save deadline.',
        detail: err instanceof Error ? err.message : 'Deadline write failed',
      });
    }
  });

  app.post('/api/cases/followup', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;
    const serverDb = getServerFirestore();
    if (!serverDb || !isFirestoreReady()) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }
    const body = req.body ?? {};
    const caseId = typeof body.caseId === 'string' ? body.caseId.trim() : '';
    if (!SAFE_ID_REGEX.test(caseId)) {
      res.status(400).json({ error: 'Valid caseId is required.' });
      return;
    }
    const ALLOWED_ACTIONS = new Set<FollowUpAction>([
      'prepare_draft',
      'open_link',
      'copy',
      'open_gmail',
      'open_phone',
      'user_confirmed_sent',
      'save_reference',
      'mark_resolved',
    ]);
    const action = ALLOWED_ACTIONS.has(String(body.action) as FollowUpAction)
      ? (String(body.action) as FollowUpAction)
      : 'prepare_draft';
    const reasonDef = ESCALATION_REASONS.find((r) => r.id === String(body.reasonId));
    const reasonId = reasonDef ? reasonDef.id : 'status_update';
    const reasonLabel = reasonDef ? reasonDef.label : 'Request a status update';
    const kind = reasonKind(reasonId);
    const ALLOWED_METHODS = new Set(['official_portal', 'phone', 'email', 'none']);
    const contactMethod = ALLOWED_METHODS.has(String(body.contactMethod)) ? String(body.contactMethod) : 'none';
    const newReference =
      typeof body.newReference === 'string'
        ? body.newReference.replace(/[^\w\s#/\-.]/g, '').trim().slice(0, 64)
        : '';
    const newEvidenceNotes = sanitizeCaseText(body.newEvidenceNotes, 400);
    const status = deriveFollowUpStatus(action);

    try {
      const caseRef = serverDb.collection('potholeCases').doc(caseId);
      const caseSnap = await caseRef.get();
      if (!caseSnap.exists || caseSnap.data()?.userId !== decoded.uid) {
        res.status(404).json({ error: 'Case not found.' });
        return;
      }
      const existing = caseSnap.data()!;
      const nowMillis = Date.now();
      const followUp: Record<string, unknown> = {
        followUpId: `fu_${nowMillis}_${Math.random().toString(36).slice(2, 8)}`,
        reasonId,
        reasonLabel,
        kind,
        status,
        contactMethod,
        draftedAtMillis: nowMillis,
        ...(existing.externalCaseRef ? { externalCaseRef: String(existing.externalCaseRef) } : {}),
        ...(newEvidenceNotes ? { newEvidenceNotes } : {}),
      };
      if (action === 'user_confirmed_sent') followUp.contactConfirmedAtMillis = nowMillis;
      const update: Record<string, unknown> = {
        followUps: FieldValue.arrayUnion(followUp),
        updatedAt: FieldValue.serverTimestamp(),
      };
      const events: Array<Record<string, unknown>> = [
        { type: `followup_${action}`, note: reasonLabel, atMillis: nowMillis },
      ];
      if (action === 'save_reference' && newReference) {
        followUp.newReference = newReference;
        followUp.referenceSavedAtMillis = nowMillis;
        update.externalCaseRef = newReference;
        const STAGE: Record<string, number> = {
          drafted: 0,
          submitted_unconfirmed: 1,
          case_logged: 2,
          acknowledged: 3,
          resolved: 4,
          reopened: 1,
        };
        const prevStatus = String(existing.status || 'drafted');
        if ((STAGE[prevStatus] ?? 0) < STAGE.case_logged) update.status = 'case_logged';
        events.push({ type: 'case_ref_logged', externalCaseRef: newReference, atMillis: nowMillis });
      }
      if (reasonId === 'closed_still_there' || body.agencyClosureDamageRemains === true) {
        update.agencyClosureDamageRemains = true;
      }
      update.events = FieldValue.arrayUnion(...events);
      await caseRef.update(update);
      res.status(201).json({ ok: true, caseId, followUpStatus: status });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to save follow-up.',
        detail: err instanceof Error ? err.message : 'Follow-up write failed',
      });
    }
  });

  app.get('/api/cases/mine', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;
    const serverDb = getServerFirestore();
    if (!serverDb || !isFirestoreReady()) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }
    const toMillis = (value: unknown): number | undefined => {
      const stamp = value as Timestamp | undefined;
      return stamp && typeof stamp.toMillis === 'function' ? stamp.toMillis() : undefined;
    };

    try {
      const snap = await serverDb.collection('potholeCases').where('userId', '==', decoded.uid).limit(100).get();
      const cases = snap.docs.map((doc) => doc.data());
      const potholeIds = Array.from(new Set(cases.map((item) => String(item.potholeId)).filter(Boolean)));
      const statusByPothole = new Map<string, string>();
      const potholeUpdatedByPothole = new Map<string, number>();
      if (potholeIds.length > 0) {
        const potholeSnaps = await serverDb.getAll(
          ...potholeIds.map((id) => serverDb.collection('potholes').doc(id))
        );
        for (const potholeSnap of potholeSnaps) {
          if (!potholeSnap.exists) continue;
          statusByPothole.set(potholeSnap.id, String(potholeSnap.data()?.status || ''));
          const updatedAt = toMillis(potholeSnap.data()?.updatedAt);
          if (updatedAt) potholeUpdatedByPothole.set(potholeSnap.id, updatedAt);
        }
      }

      const nowMillis = Date.now();
      const normalized = cases.map((item) => {
        const events = Array.isArray(item.events) ? (item.events as Array<Record<string, unknown>>) : [];
        const followUps = Array.isArray(item.followUps)
          ? (item.followUps as Array<Record<string, unknown>>)
          : [];
        const agencyClosedEvent = events.find((event) => String(event.type) === 'agency_closed');
        const refSavedMillis = followUps
          .map((followUp) => Number(followUp.referenceSavedAtMillis) || 0)
          .reduce((max, value) => Math.max(max, value), 0);
        return {
          caseId: String(item.caseId),
          potholeId: String(item.potholeId),
          streetName: String(item.streetName || ''),
          formattedAddress: String(item.formattedAddress || ''),
          lat: Number(item.lat),
          lng: Number(item.lng),
          jurisdiction: String(item.jurisdiction || 'unknown'),
          channel: String(item.channel || 'atl311'),
          reportMethod: item.reportMethod ? String(item.reportMethod) : undefined,
          status: String(item.status || 'drafted'),
          externalCaseRef: item.externalCaseRef ? String(item.externalCaseRef) : undefined,
          primaryPhotoUrl: item.primaryPhotoUrl ? String(item.primaryPhotoUrl) : undefined,
          primaryMediaId: item.primaryMediaId ? String(item.primaryMediaId) : undefined,
          notes: item.notes ? String(item.notes) : undefined,
          events,
          followUps,
          deadlineSource: item.deadlineSource ? String(item.deadlineSource) : undefined,
          deadlineCitation: item.deadlineCitation ? String(item.deadlineCitation) : undefined,
          agencyClosureDamageRemains: Boolean(item.agencyClosureDamageRemains),
          submittedAtMillis: toMillis(item.submittedAt),
          createdAtMillis: toMillis(item.createdAt),
          updatedAtMillis: toMillis(item.updatedAt),
          expectedCompletionAtMillis: toMillis(item.expectedCompletionAt),
          deadlineRecordedAtMillis: toMillis(item.deadlineRecordedAt),
          personalFollowUpAtMillis: toMillis(item.personalFollowUpAt),
          potholeStatus: statusByPothole.get(String(item.potholeId)) || undefined,
          potholeUpdatedAtMillis: potholeUpdatedByPothole.get(String(item.potholeId)),
          agencyClosedAtMillis: agencyClosedEvent ? Number(agencyClosedEvent.atMillis) || undefined : undefined,
          followUpRefSavedAtMillis: refSavedMillis || undefined,
        };
      });

      if (await userNotificationsEnabled(serverDb, decoded.uid)) {
        const pending = normalized.flatMap((item) =>
          evaluateCaseNotifications({
            caseId: item.caseId,
            potholeId: item.potholeId,
            streetName: item.streetName,
            status: item.status as never,
            externalCaseRef: item.externalCaseRef,
            expectedCompletionAtMillis: item.expectedCompletionAtMillis,
            submittedAtMillis: item.submittedAtMillis,
            personalFollowUpAtMillis: item.personalFollowUpAtMillis,
            potholeStatus: item.potholeStatus,
            potholeUpdatedAtMillis: item.potholeUpdatedAtMillis,
            agencyClosedAtMillis: item.agencyClosedAtMillis,
            followUpRefSavedAtMillis: item.followUpRefSavedAtMillis,
            nowMillis,
          })
        );
        if (pending.length > 0) {
          const itemsCol = serverDb.collection('notifications').doc(decoded.uid).collection('items');
          const existingSnaps = await serverDb.getAll(...pending.map((item) => itemsCol.doc(item.id)));
          const batch = serverDb.batch();
          let writes = 0;
          existingSnaps.forEach((docSnap, index) => {
            if (docSnap.exists) return;
            const item = pending[index];
            batch.set(itemsCol.doc(item.id), {
              notificationId: item.id,
              uid: decoded.uid,
              type: item.type,
              title: item.title.slice(0, 96),
              body: item.body.slice(0, 240),
              relatedId: item.relatedId.slice(0, 128),
              read: false,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            writes += 1;
          });
          if (writes > 0) await batch.commit();
        }
      }

      res.json({
        cases: normalized
          .map(({ agencyClosedAtMillis: _closed, followUpRefSavedAtMillis: _saved, ...item }) => item)
          .sort((a, b) => (b.updatedAtMillis || b.createdAtMillis || 0) - (a.updatedAtMillis || a.createdAtMillis || 0)),
      });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load your cases.',
        detail: err instanceof Error ? err.message : 'Case query failed',
      });
    }
  });

  app.get('/api/profile/:uid', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;
    const { uid } = req.params;
    if (!SAFE_ID_REGEX.test(uid)) {
      res.status(400).json({ error: 'Invalid profile id.' });
      return;
    }
    const serverDb = getServerFirestore();
    if (!serverDb || !isFirestoreReady()) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }
    try {
      const snap = await serverDb.collection('users').doc(uid).get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Profile not found.' });
        return;
      }
      const user = snap.data()!;
      if (uid !== decoded.uid && user.showOnLeaderboard !== true) {
        res.status(404).json({ error: 'Profile not found.' });
        return;
      }
      const joinedAt = user.joinedAt as Timestamp | undefined;
      res.json({
        profile: {
          uid: String(user.uid),
          username: String(user.username || ''),
          displayName: String(user.displayName || ''),
          ...(typeof user.photoURL === 'string' ? { photoURL: user.photoURL } : {}),
          ...(user.shareNeighborhood === true && typeof user.homeNeighborhood === 'string'
            ? { homeNeighborhood: user.homeNeighborhood }
            : {}),
          distinctPotholeCount: Number(user.distinctPotholeCount || 0),
          evidenceCount: Number(user.evidenceCount || 0),
          unlockedBadgesCount: Number(user.unlockedBadgesCount || 0),
          ...(joinedAt?.toMillis ? { joinedAtMillis: joinedAt.toMillis() } : {}),
        },
      });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load profile.',
        detail: err instanceof Error ? err.message : 'Profile query failed',
      });
    }
  });
}

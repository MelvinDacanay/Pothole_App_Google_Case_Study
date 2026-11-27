import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { initializeApp as initClientApp, deleteApp as deleteClientApp } from 'firebase/app';
import { getFirestore as getClientFirestore, connectFirestoreEmulator, doc as clientDoc, setDoc as clientSetDoc, getDoc as clientGetDoc } from 'firebase/firestore';
import sharp from 'sharp';
import { verifyImage } from '../server/verification.ts';
import { commitVerifiedSubmission, commitPendingReview, type SubmissionInput } from '../server/submission.ts';
import { storeSanitizedUpload, loadMediaBytes, runMediaMaintenance, mediaBackend } from '../server/mediaStore.ts';
import { SANITIZER_VERSION } from '../server/photoPrivacy.ts';

const host = process.env.FIRESTORE_EMULATOR_HOST || '';
const safe = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host);

test('real local Firestore emulator: concurrent manual approvals and exact-image claims', { skip: !safe ? 'Start a loopback-only Firestore emulator first. No production access permitted.' : false }, async () => {
  const app = initializeApp({ projectId: 'demo-patchup-verification' }, `test-${randomUUID()}`);
  const db = getFirestore(app);
  const id = randomUUID().replaceAll('-', ''), uid = `u_${id}`, mediaId = `med_${id}`, submissionId = `sub_${id}`;
  process.env.PATCHUP_IMAGE_AI_ENABLED = 'false';
  process.env.PATCHUP_AUTO_ACCEPT = 'false';
  const fixture = fs.readFileSync(new URL('./fixtures/fixture-1.jpg', import.meta.url));

  try {
    await db.collection('users').doc(uid).set({ username: 'tester', displayName: 'Tester', distinctPotholeCount: 0, evidenceCount: 0, potholesCollectedCount: 0 });
    await db.collection('mediaObjects').doc(mediaId).set({ ownerId: uid, contentType: 'image/jpeg', data: fixture });
    const v = await verifyImage(db, { uid, mediaId, bytes: fixture, mime: 'image/jpeg', consent: false });
    const p: SubmissionInput = { uid, mediaId, submissionId, verificationId: v.verificationId, requestedAction: 'provisional_review', actionType: 'provisional_review', targetPotholeId: '', lat: 33.75, lng: -84.39, coordinateSource: 'manual_pin', formattedAddress: 'Example St', streetName: 'Example St', normalizedStreet: 'example st', neighborhood: '', city: 'Atlanta', state: 'GA', postalCode: '', placeId: '', jurisdiction: 'atldot', locationUserCorrected: false, notes: '', duplicateConfidence: 0, candidatePotholeIds: [] };
    const a = await commitVerifiedSubmission(db, p);
    assert.equal(a.duplicateStatus, 'pending_review');
    const outcomes = await Promise.all([
      commitPendingReview(db, { uid: 'admin', email: '' }, submissionId, 'confirm_distinct', '', 'review'),
      commitPendingReview(db, { uid: 'admin', email: '' }, submissionId, 'confirm_distinct', '', 'review')
    ]);
    assert.equal(outcomes.filter(x => !x.alreadyResolved).length, 1);
    assert.equal((await db.collection('users').doc(uid).get()).data()?.distinctPotholeCount, 1);
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});

test('real local Firestore emulator: security rules deny direct client media writes and cross-user reads', { skip: !safe ? 'Start a loopback-only Firestore emulator first.' : false }, async () => {
  const clientApp = initClientApp({ projectId: 'demo-patchup-verification', apiKey: 'fake-key' }, `client-${randomUUID()}`);
  const clientDb = getClientFirestore(clientApp);
  const [h, port] = host.split(':');
  connectFirestoreEmulator(clientDb, h, Number(port));

  try {
    // 1. Direct client write to mediaObjects denied
    await assert.rejects(
      clientSetDoc(clientDoc(clientDb, 'mediaObjects', 'med_direct_client_hack'), {
        mediaId: 'med_direct_client_hack',
        ownerId: 'attacker'
      }),
      (err: { code?: string }) => err.code === 'permission-denied'
    );

    // 2. Direct client write to server collections denied
    await assert.rejects(
      clientSetDoc(clientDoc(clientDb, 'imageVerifications', 'ver_fake'), { fake: true }),
      (err: { code?: string }) => err.code === 'permission-denied'
    );

    // 3. Raw cross-user activity feed read denied
    await assert.rejects(
      clientGetDoc(clientDoc(clientDb, 'activityFeed', 'evt_secret')),
      (err: { code?: string }) => err.code === 'permission-denied'
    );
  } finally {
    await deleteClientApp(clientApp);
  }
});

test('real local Firestore emulator: upload metadata removal, legacy photo fallback, and GCS fail-closed', { skip: !safe ? 'Start a loopback-only Firestore emulator first.' : false }, async () => {
  const app = initializeApp({ projectId: 'demo-patchup-verification' }, `test-${randomUUID()}`);
  const db = getFirestore(app);
  const id = randomUUID().replaceAll('-', '');
  const uid = `u_${id}`, mediaId = `med_${id}`, legacyId = `med_leg_${id}`;

  try {
    // 1. Create photo with embedded EXIF metadata
    const rawPhoto = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#336699' } })
      .withExif({ IFD0: { Artist: 'LEAKED_PRIVATE_IDENTITY', ImageDescription: 'LEAKED_GPS_33_75' } })
      .jpeg()
      .toBuffer();

    // 2. Store via server storeSanitizedUpload (Firestore backend)
    process.env.PATCHUP_MEDIA_STORAGE = 'firestore';
    const uploadRes = await storeSanitizedUpload(db, { uid, mediaId, bytes: rawPhoto, mime: 'image/jpeg' });
    assert.equal(uploadRes.contentType, 'image/jpeg');

    const storedDoc = (await db.collection('mediaObjects').doc(mediaId).get()).data()!;
    assert.equal(storedDoc.ownerId, uid);
    assert.equal(storedDoc.sanitizerVersion, SANITIZER_VERSION);
    assert.ok(storedDoc.thumbnailBytes <= 40000);
    assert.equal(storedDoc.data.includes(Buffer.from('LEAKED_PRIVATE_IDENTITY')), false);

    // 3. Load via loadMediaBytes: canonical
    const loaded = await loadMediaBytes(mediaId, storedDoc, 'evidence');
    assert.equal(loaded.contentType, 'image/jpeg');
    const loadedMeta = await sharp(loaded.buffer).metadata();
    assert.equal(loadedMeta.exif, undefined);

    // 4. Legacy photographs without sanitizerVersion dynamically sanitized on display
    await db.collection('mediaObjects').doc(legacyId).set({
      ownerId: uid,
      contentType: 'image/jpeg',
      data: rawPhoto,
      createdAt: FieldValue.serverTimestamp()
    });
    const legacyDoc = (await db.collection('mediaObjects').doc(legacyId).get()).data()!;
    const legacyLoaded = await loadMediaBytes(legacyId, legacyDoc, 'evidence', 'display');
    assert.equal(legacyLoaded.contentType, 'image/jpeg');
    assert.equal(legacyLoaded.buffer.includes(Buffer.from('LEAKED_PRIVATE_IDENTITY')), false);
    const legacyMeta = await sharp(legacyLoaded.buffer).metadata();
    assert.equal(legacyMeta.exif, undefined);

    // 5. Cloud Storage compatibility: fail closed when bucket unconfigured
    delete process.env.PATCHUP_MEDIA_BUCKET;
    process.env.PATCHUP_MEDIA_STORAGE = 'gcs';
    await assert.rejects(
      storeSanitizedUpload(db, { uid, mediaId: `med_gcs_${id}`, bytes: rawPhoto, mime: 'image/jpeg' }),
      /Private media bucket is not configured/
    );
    process.env.PATCHUP_MEDIA_STORAGE = 'firestore';
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});

test('real local Firestore emulator: migration dry-run and media maintenance', { skip: !safe ? 'Start a loopback-only Firestore emulator first.' : false }, async () => {
  const app = initializeApp({ projectId: 'demo-patchup-verification' }, `test-${randomUUID()}`);
  const db = getFirestore(app);
  const id = randomUUID().replaceAll('-', '');
  const uid = `u_${id}`;
  const now = Date.now();

  const rawBytes = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#444444' } }).jpeg().toBuffer();

  const acceptedMediaId = `med_acc_${id}`;
  const pendingMediaId = `med_pnd_${id}`;
  const expiredAbandonedId = `med_abn_${id}`;

  try {
    await db.collection('users').doc(uid).set({ username: `user_${id}`, displayName: 'Tester' });

    // Accepted pothole with media
    await db.collection('mediaObjects').doc(acceptedMediaId).set({
      ownerId: uid,
      contentType: 'image/jpeg',
      data: rawBytes,
      state: 'ready',
      cleanupAfter: Timestamp.fromMillis(now - 1000)
    });
    await db.collection('potholes').doc(`pot_${id}`).set({
      primaryMediaId: acceptedMediaId,
      primaryContributorUid: uid,
      status: 'accepted',
      verificationStatus: 'accepted'
    });

    // Pending review submission with media
    await db.collection('mediaObjects').doc(pendingMediaId).set({
      ownerId: uid,
      contentType: 'image/jpeg',
      data: rawBytes,
      state: 'ready'
    });
    await db.collection('submissions').doc(`sub_${id}`).set({
      mediaId: pendingMediaId,
      userId: uid,
      duplicateStatus: 'pending_review'
    });

    // Abandoned upload that expired
    await db.collection('mediaObjects').doc(expiredAbandonedId).set({
      ownerId: uid,
      contentType: 'image/jpeg',
      data: rawBytes,
      state: 'ready',
      cleanupAfter: Timestamp.fromMillis(now - 1000)
    });

    // Run media maintenance
    const maint = await runMediaMaintenance(db, now);
    assert.ok(maint.retired >= 1, 'Abandoned upload should be retired');
    assert.ok(maint.retained >= 1, 'Accepted pothole media should be retained');

    const abandonedAfter = await db.collection('mediaObjects').doc(expiredAbandonedId).get();
    assert.equal(abandonedAfter.exists, false, 'Expired abandoned media should be removed from mediaObjects');
    const retiredDoc = await db.collection('mediaRetired').doc(expiredAbandonedId).get();
    assert.equal(retiredDoc.exists, true, 'Retired tombstone should be recorded');

    const acceptedAfter = (await db.collection('mediaObjects').doc(acceptedMediaId).get()).data()!;
    assert.equal(acceptedAfter.cleanupAfter, undefined, 'Accepted media should have cleanupAfter cleared');
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});


test('real local Firestore emulator: stale admin claims and enrollment cannot grant client access', { skip: !safe ? 'Start a loopback-only Firestore emulator first.' : false }, async () => {
  const id = randomUUID().replaceAll('-', '');
  const uid = `former_${id}`;
  const app = initializeApp({ projectId: 'demo-patchup-verification' }, `stale-${id}`);
  const db = getFirestore(app);
  const clientApp = initClientApp({ projectId: 'demo-patchup-verification', apiKey: 'fake-key' }, `stale-client-${id}`);
  const clientDb = getClientFirestore(clientApp);
  const [h, port] = host.split(':');
  connectFirestoreEmulator(clientDb, h, Number(port), { mockUserToken: { sub: uid, email: 'former@example.test', email_verified: true, admin: true } });
  try {
    await db.collection('admins').doc(uid).set({ uid, email: 'former@example.test' });
    await db.collection('adminAudit').doc(id).set({ event: 'private' });
    await db.collection('reports').doc(id).set({ status: 'awaiting_admin_review' });
    await db.collection('submissions').doc(id).set({ userId: 'different-user' });
    await db.collection('submissions').doc(`own_${id}`).set({ userId: uid });
    for (const [collection, key] of [['admins', uid], ['adminAudit', id], ['reports', id], ['submissions', id]]) {
      await assert.rejects(clientGetDoc(clientDoc(clientDb, collection, key)), (err: { code?: string }) => err.code === 'permission-denied');
    }
    assert.equal((await clientGetDoc(clientDoc(clientDb, 'submissions', `own_${id}`))).exists(), true);
  } finally {
    await deleteClientApp(clientApp);
    await db.terminate();
    await deleteApp(app);
  }
});

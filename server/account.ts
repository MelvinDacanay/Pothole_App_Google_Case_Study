import { type Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

async function deleteSubcollectionDocs(
  serverDb: Firestore,
  colRef: FirebaseFirestore.CollectionReference
): Promise<number> {
  const snap = await colRef.limit(400).get();
  if (snap.empty) return 0;
  const batch = serverDb.batch();
  for (const docSnap of snap.docs) {
    batch.delete(docSnap.ref);
  }
  await batch.commit();
  return snap.size;
}

export async function deleteUserAccountAndPersonalData(params: {
  serverDb: Firestore;
  adminAuth: Auth;
  uid: string;
}): Promise<{
  deletedPersonalDocs: number;
  anonymizedPotholes: number;
  anonymizedSubmissions: number;
  authDeleted: boolean;
}> {
  const { serverDb, adminAuth, uid } = params;
  let deletedPersonalDocs = 0;

  // 1. Delete subcollections under user profile, notifications, achievements
  deletedPersonalDocs += await deleteSubcollectionDocs(
    serverDb,
    serverDb.collection('users').doc(uid).collection('storageChecks')
  );
  deletedPersonalDocs += await deleteSubcollectionDocs(
    serverDb,
    serverDb.collection('notifications').doc(uid).collection('items')
  );
  deletedPersonalDocs += await deleteSubcollectionDocs(
    serverDb,
    serverDb.collection('achievements').doc(uid).collection('badges')
  );

  // 2. Delete friendships involving uid
  const friendshipsSnap = await serverDb
    .collection('friendships')
    .where('participantUids', 'array-contains', uid)
    .limit(200)
    .get();
  if (!friendshipsSnap.empty) {
    const batch = serverDb.batch();
    for (const fDoc of friendshipsSnap.docs) {
      batch.delete(fDoc.ref);
      deletedPersonalDocs += 1;
    }
    await batch.commit();
  }

  // 3. Delete isolated private account, public profile, leaderboard entry, and minigame stats
  const directRefs = [
    serverDb.collection('users').doc(uid).collection('private').doc('account'),
    serverDb.collection('users').doc(uid),
    serverDb.collection('leaderboardStats').doc(uid),
    serverDb.collection('gameStats').doc(`${uid}_pothole_repair`),
    serverDb.collection('gameStats').doc(`${uid}_pothole_runner`),
  ];
  const directBatch = serverDb.batch();
  for (const ref of directRefs) {
    directBatch.delete(ref);
    deletedPersonalDocs += 1;
  }
  await directBatch.commit();

  // 4. Anonymize public-safe street/pothole records so civic corridor reports stay intact without retaining personal identity
  let anonymizedPotholes = 0;
  const potholesSnap = await serverDb
    .collection('potholes')
    .where('primaryContributorUid', '==', uid)
    .limit(300)
    .get();
  if (!potholesSnap.empty) {
    const batch = serverDb.batch();
    for (const pDoc of potholesSnap.docs) {
      batch.update(pDoc.ref, {
        primaryContributorUid: 'deleted_contributor',
        primaryContributorUsername: 'former_contributor',
        primaryContributorDisplayName: 'Former Contributor',
        updatedAt: FieldValue.serverTimestamp(),
      });
      anonymizedPotholes += 1;
    }
    await batch.commit();
  }

  let anonymizedSubmissions = 0;
  const submissionsSnap = await serverDb
    .collection('submissions')
    .where('userId', '==', uid)
    .limit(300)
    .get();
  if (!submissionsSnap.empty) {
    const batch = serverDb.batch();
    for (const sDoc of submissionsSnap.docs) {
      batch.update(sDoc.ref, {
        userId: 'deleted_contributor',
        username: 'former_contributor',
        displayName: 'Former Contributor',
        updatedAt: FieldValue.serverTimestamp(),
      });
      anonymizedSubmissions += 1;
    }
    await batch.commit();
  }

  // 5. Remove Firebase Authentication user
  let authDeleted = false;
  try {
    await adminAuth.deleteUser(uid);
    authDeleted = true;
  } catch {
    authDeleted = false;
  }

  return {
    deletedPersonalDocs,
    anonymizedPotholes,
    anonymizedSubmissions,
    authDeleted,
  };
}

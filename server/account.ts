import { retireMedia } from './mediaStore.ts';
import { type Auth } from 'firebase-admin/auth';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { MINIGAME_IDS } from './games.ts';

async function deleteSubcollectionDocs(
  serverDb: Firestore,
  colRef: FirebaseFirestore.CollectionReference
): Promise<number> {
  let count=0;
  for(;;){const snap=await colRef.limit(400).get();if(snap.empty)return count;const batch=serverDb.batch();for(const d of snap.docs)batch.delete(d.ref);await batch.commit();count+=snap.size;}

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
    serverDb.collection('users').doc(uid).collection('private').doc('consent'),
    serverDb.collection('users').doc(uid),
    serverDb.collection('leaderboardStats').doc(uid),
    ...MINIGAME_IDS.map((gameId) => serverDb.collection('gameStats').doc(`${uid}_${gameId}`)),
  ];
  const directBatch = serverDb.batch();
  for (const ref of directRefs) {
    directBatch.delete(ref);
    deletedPersonalDocs += 1;
  }
  await directBatch.commit();

  // 4. Anonymize public-safe street/pothole records so community corridor reports stay intact without retaining personal identity
  let anonymizedPotholes = 0;
  for(;;){const snap=await serverDb.collection('potholes').where('primaryContributorUid','==',uid).limit(300).get();if(snap.empty)break;const batch=serverDb.batch();for(const p of snap.docs){const d=p.data();batch.update(p.ref,{primaryContributorUid:'deleted_contributor',primaryContributorUsername:'former_contributor',primaryContributorDisplayName:'Former Patcher',primaryContributorPhotoURL:FieldValue.delete(),accuracyMeters:FieldValue.delete(),...(d.status==='provisional'?{status:'rejected',verificationStatus:'rejected'}:{}),updatedAt:FieldValue.serverTimestamp()});}await batch.commit();anonymizedPotholes+=snap.size;}
  let anonymizedSubmissions=0;
  for(;;){const snap=await serverDb.collection('submissions').where('userId','==',uid).limit(300).get();if(snap.empty)break;const batch=serverDb.batch();for(const d of snap.docs){batch.update(d.ref,{userId:'deleted_contributor',username:'former_contributor',displayName:'Former Patcher',notes:FieldValue.delete(),accuracyMeters:FieldValue.delete(),...(d.data().duplicateStatus==='pending_review'?{duplicateStatus:'rejected'}:{}),updatedAt:FieldValue.serverTimestamp()});}await batch.commit();anonymizedSubmissions+=snap.size;}

  // Verification observations, cache, and user-specific quota/effect records are private and removable.
  for(const collection of ['imageVerifications','imageAnalysisCache','verificationBudgets','mediaBudgets','roadLookups','contributionEffects']){
    for(;;){const snap=await serverDb.collection(collection).where('ownerId','==',uid).limit(300).get();if(snap.empty)break;const batch=serverDb.batch();for(const d of snap.docs)batch.delete(d.ref);await batch.commit();deletedPersonalDocs+=snap.size;}
  }
  // Approved community photos are retained, with owner IDs anonymized; private or abandoned media is retired.
  // A retired ID cannot be recreated by a client (see firestore.rules).
  for(;;){const media=await serverDb.collection('mediaObjects').where('ownerId','==',uid).limit(50).get();if(media.empty)break;
    for(const d of media.docs){await serverDb.runTransaction(async tx=>{
      const current=await tx.get(d.ref);if(!current.exists||current.data()?.ownerId!==uid)return;
      const [subs,pots]=await Promise.all([tx.get(serverDb.collection('submissions').where('mediaId','==',d.id)),tx.get(serverDb.collection('potholes').where('primaryMediaId','==',d.id))]);
      const accepted=(v:FirebaseFirestore.DocumentData)=>['accepted','reported','acknowledged','repaired'].includes(String(v.status));
      const retained=pots.docs.some(p=>accepted(p.data()))||subs.docs.some(s=>['distinct','evidence_added'].includes(String(s.data().duplicateStatus)));
      if(retained)tx.update(d.ref,{ownerId:'deleted_contributor'});
      else retireMedia(tx,serverDb,d.ref,current.data()!);
    });}
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

import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { haversineMeters, isValidCoordinatePair, isWithinAtlantaMetro, type JurisdictionType } from './geo.ts';
import { mediaBinding } from './mediaStore.ts';
import { authorizeVerification, autoAcceptEnabled, boundedInt, hashBytes, modelId, publicSummary, VALID_MS, type VerificationRecord } from './verificationPolicy.ts';
import { prepareContribution } from './contributions.ts';

export interface SubmissionInput {
  uid:string; submissionId:string; mediaId:string; verificationId:string; requestedAction:string; targetPotholeId:string;
  lat:number;lng:number;actionType:string;coordinateSource:string;accuracyMeters?:number;formattedAddress:string;
  streetName:string;normalizedStreet:string;neighborhood:string;city:string;state:string;postalCode:string;placeId:string;
  jurisdiction:JurisdictionType;locationUserCorrected:boolean;streetSource?:'city_centerline'|'user_observed'|'google_geocoding'|'legacy';notes:string;duplicateConfidence:number;candidatePotholeIds:string[];
}
// Caller authenticates and validates input; this function owns all database authorization and atomic mutations.
export async function commitVerifiedSubmission(serverDb:Firestore,p:SubmissionInput) {
  const {uid,submissionId, mediaId, verificationId, requestedAction, targetPotholeId, lat, lng, actionType, coordinateSource, accuracyMeters, formattedAddress, streetName, normalizedStreet, neighborhood, city, state, postalCode, placeId, jurisdiction, locationUserCorrected, notes, duplicateConfidence, candidatePotholeIds}=p;
  if(!isWithinAtlantaMetro(lat,lng)||!['new_pothole','add_evidence','provisional_review'].includes(actionType)||requestedAction!==actionType)throw new Error('Invalid submission');
  return serverDb.runTransaction(async (tx) => {
        const subRef = serverDb.collection('submissions').doc(submissionId);
        const existingSub = await tx.get(subRef);
        if (existingSub.exists) {
          const existingData = existingSub.data()!;
          if (existingData.userId !== uid || existingData.mediaId !== mediaId || existingData.verificationId !== verificationId || existingData.requestedAction !== requestedAction || (existingData.reviewTargetPotholeId || existingData.targetPotholeId || '') !== targetPotholeId || existingData.lat !== lat || existingData.lng !== lng) throw new Error('Submission ID already belongs to a different request.');
          return {
            idempotent: true,
            submissionId,
            potholeId: existingData.potholeId,
            duplicateStatus: existingData.duplicateStatus,
          };
        }

        const mediaRef = serverDb.collection('mediaObjects').doc(mediaId);
        const mediaSnap = await tx.get(mediaRef);
        if (!mediaSnap.exists) {
          throw new Error('Uploaded photo does not exist in /mediaObjects.');
        }
        if (mediaSnap.data()?.ownerId !== uid) {
          throw new Error('Media object ownership mismatch.');
        }

        const mediaData=mediaSnap.data()!;
        if(mediaId.startsWith('avt_'))throw new Error('Profile photos cannot be submitted.');
        const prepared=mediaBinding(mediaData);
        const day=new Date().toISOString().slice(0,10);
        const submitBudgetRef=serverDb.collection('verificationBudgets').doc(`sub_${hashBytes(uid)}_${day}`);
        const verificationRef=serverDb.collection('imageVerifications').doc(verificationId);
        const claimRef=serverDb.collection('imageClaims').doc(prepared.contentHash);
        const sourceHash=typeof mediaData.sourceContentHash==='string'&&/^[a-f0-9]{64}$/.test(mediaData.sourceContentHash)&&mediaData.sourceContentHash!==prepared.contentHash?mediaData.sourceContentHash:null;
        const sourceRef=sourceHash?serverDb.collection('imageClaims').doc(sourceHash):null;
        const [verificationSnap,claimSnap,submitBudgetSnap,sourceClaim]=await Promise.all([tx.get(verificationRef),tx.get(claimRef),tx.get(submitBudgetRef),sourceRef?tx.get(sourceRef):Promise.resolve(null)]);
        if(Number(submitBudgetSnap.data()?.count||0)>=boundedInt(process.env.PATCHUP_SUBMISSION_USER_DAILY_LIMIT,25,1000)) throw new Error('Daily photo submission limit reached.');
        if(!verificationSnap.exists) throw new Error('Photo verification not found.');
        const verification=verificationSnap.data() as VerificationRecord;
        authorizeVerification(verification,{uid:uid,mediaId,imageHash:prepared.imageHash,contentHash:prepared.contentHash,now:Date.now(),model:modelId(),manual:actionType==='provisional_review',autoEnabled:autoAcceptEnabled()});
        if(claimSnap.exists||sourceClaim?.exists) throw new Error('An identical photo has already been submitted. Take a new photo.');
        const aiStatus=verification.verificationState==='completed'?'completed':'unavailable';
        const aiSeverityLabel='unclassified';
        const aiIsRoadDefect=verification.classificationDecision==='verified' && autoAcceptEnabled();
        const aiSummary=publicSummary(verification.observation);
        const imageReviewRequired=!aiIsRoadDefect;
        const persistClaim=()=>{
          tx.update(mediaRef,{cleanupAfter:FieldValue.delete()});
          tx.update(verificationRef,{consumedSubmissionId:submissionId,updatedAt:FieldValue.serverTimestamp()});
          tx.set(submitBudgetRef,{ownerId:uid,count:FieldValue.increment(1),expiresAt:Timestamp.fromMillis(Date.now()+2*VALID_MS)},{merge:true});
          tx.create(claimRef,{submissionId,mediaId,imageHash:prepared.imageHash,createdAt:FieldValue.serverTimestamp()});
          if(sourceRef)tx.create(sourceRef,{submissionId,mediaId,imageHash:prepared.imageHash,createdAt:FieldValue.serverTimestamp()});
        };
        const userRef = serverDb.collection('users').doc(uid);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) {
          throw new Error('Patcher profile missing. Please sign out and sign back in.');
        }
        const userData = userSnap.data()!;
        const username = String(userData.username || 'atlanta_user').slice(0, 32);
        const displayName = String(userData.displayName || 'Patcher').slice(0, 64);
        const contributorPhotoURL =
          typeof userData.photoURL === 'string' && userData.photoURL.length <= 512
            ? userData.photoURL
            : undefined;

        const photoUrl = `/api/media/${mediaId}`;
        const provenance={streetSource:p.streetSource||'legacy'};

        if (actionType === 'add_evidence') {
          const targetRef = serverDb.collection('potholes').doc(targetPotholeId);
          const targetSnap = await tx.get(targetRef);
          if (!targetSnap.exists || !['accepted','reported','acknowledged'].includes(String(targetSnap.data()?.status)) || !isValidCoordinatePair(Number(targetSnap.data()?.lat),Number(targetSnap.data()?.lng)) || haversineMeters(lat,lng,Number(targetSnap.data()?.lat),Number(targetSnap.data()?.lng)) > 25) {
            throw new Error('Target canonical pothole record was not found.');
          }

          // Anti-farming guard: check recent evidence submissions by this user on the same pothole
          const priorEvidenceSnap = await tx.get(
            serverDb
              .collection('submissions')
              .where('userId', '==', uid)
              .where('potholeId', '==', targetPotholeId)
              .limit(5)
          );
          if (priorEvidenceSnap.size >= 2) {
            throw new Error('Evidence limit reached: you can attach up to 2 evidence photos per pothole.');
          }

          const credit=await prepareContribution(serverDb,tx,{submissionId,uid:uid,user:userData,potholeId:targetPotholeId,streetName,neighborhood,distinct:false});
          persistClaim();
          credit();
          tx.set(subRef, {
            verificationId, requestedAction, targetPotholeId, imageReviewRequired,
            submissionId,
            userId: uid,
            username,
            displayName,
            potholeId: targetPotholeId,
            candidatePotholeIds: [targetPotholeId],
            actionType: 'add_evidence',
            duplicateStatus: 'evidence_added',
            duplicateConfidence,
            mediaId,
            photoUrl,
            lat,
            lng,
            coordinateSource,
            ...provenance,
            ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
            formattedAddress,
            streetName,
            normalizedStreet,
            locationUserCorrected,
            ...(notes ? { notes } : {}),
            aiClassificationStatus: aiStatus,
            aiIsRoadDefect,
            aiSeverityLabel,
            ...(aiSummary ? { aiSummary } : {}),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Increment ONLY evidence counts — NEVER distinctPotholeCount!
          tx.update(targetRef, {
            evidenceCount: FieldValue.increment(1),
            submissionCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });



          return {
            idempotent: false,
            submissionId,
            potholeId: targetPotholeId,
            duplicateStatus: 'evidence_added',
            username,
            displayName,
          };
        }

        // Either 'new_pothole' or 'provisional_review'
        const isProvisional = actionType === 'provisional_review';
        const potholeId = `pot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const potholeRef = serverDb.collection('potholes').doc(potholeId);

        const credit=isProvisional?null:await prepareContribution(serverDb,tx,{submissionId,uid:uid,user:userData,potholeId,streetName,neighborhood,distinct:true});
        persistClaim();
        credit?.();
        tx.set(potholeRef, {
          potholeId,
          lat,
          lng,
          coordinateSource,
          ...provenance,
          ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
          formattedAddress,
          streetName,
          normalizedStreet,
          ...(neighborhood ? { neighborhood } : {}),
          city,
          state,
          ...(postalCode ? { postalCode } : {}),
          ...(placeId ? { placeId } : {}),
          jurisdiction,
          locationUserCorrected,
          status: isProvisional ? 'provisional' : 'accepted',
          verificationStatus: isProvisional ? 'needs_review' : 'accepted',
          severityLabel: aiSeverityLabel,
          primaryContributorUid: uid,
          primaryContributorUsername: username,
          primaryContributorDisplayName: displayName,
          ...(contributorPhotoURL ? { primaryContributorPhotoURL: contributorPhotoURL } : {}),
          primaryPhotoUrl: photoUrl,
          primaryMediaId: mediaId,
          evidenceCount: isProvisional ? 0 : 1,
          submissionCount: 1,
          ...(aiSummary ? { aiReviewSummary: aiSummary } : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(subRef, {
          verificationId, requestedAction, reviewTargetPotholeId:targetPotholeId, imageReviewRequired,
          submissionId,
          userId: uid,
          username,
          displayName,
          potholeId,
          candidatePotholeIds,
          actionType,
          duplicateStatus: isProvisional ? 'pending_review' : 'distinct',
          duplicateConfidence,
          mediaId,
          photoUrl,
          lat,
          lng,
          coordinateSource,
          ...provenance,
          ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
          formattedAddress,
          streetName,
          normalizedStreet,
          locationUserCorrected,
          ...(notes ? { notes } : {}),
          aiClassificationStatus: aiStatus,
          aiIsRoadDefect,
          aiSeverityLabel,
          ...(aiSummary ? { aiSummary } : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          idempotent: false,
          submissionId,
          potholeId,
          duplicateStatus: isProvisional ? 'pending_review' : 'distinct',
          username,
          displayName,
        };
      });
}

// Only the authenticated administrator route calls this function.
export async function commitPendingReview(serverDb:Firestore,actor:{uid:string;email:string},submissionId:string,resolution:'confirm_distinct'|'merge_evidence'|'reject',targetPotholeId:string,reason:string) {
  return serverDb.runTransaction(async (tx) => {
        const subRef = serverDb.collection('submissions').doc(submissionId);
        const subSnap = await tx.get(subRef);
        if (!subSnap.exists) throw new Error('Submission not found.');

        const subData = subSnap.data()!;
        if (subData.duplicateStatus !== 'pending_review') {
          return {
            alreadyResolved: true,
            duplicateStatus: subData.duplicateStatus,
            potholeId: subData.potholeId,
          };
        }

        const provisionalPotholeRef = serverDb.collection('potholes').doc(String(subData.potholeId));
        if (resolution==='reject') {
          const [pot,media]=await Promise.all([tx.get(provisionalPotholeRef),tx.get(serverDb.collection('mediaObjects').doc(String(subData.mediaId)))]);
          if(!pot.exists||pot.data()?.status!=='provisional') throw new Error('Review is no longer pending.');
          const audit=serverDb.collection('adminAudit').doc();
          tx.update(provisionalPotholeRef,{status:'rejected',verificationStatus:'rejected',updatedAt:FieldValue.serverTimestamp()});
          tx.update(subRef,{duplicateStatus:'rejected',updatedAt:FieldValue.serverTimestamp()});
          if(media.exists)tx.update(serverDb.collection('mediaObjects').doc(String(subData.mediaId)),{cleanupAfter:Timestamp.fromMillis(Date.now()+7*VALID_MS)});
          tx.create(audit,{eventId:audit.id,actorUid:actor.uid,actorEmail:String(actor.email||''),action:'submission_review',targetType:'pothole',targetId:subData.potholeId,reason:reason.slice(0,400),afterSummary:'reject',createdAt:FieldValue.serverTimestamp()});
          return {alreadyResolved:false,duplicateStatus:'rejected',potholeId:subData.potholeId};
        }
        const contributorRef = serverDb.collection('users').doc(String(subData.userId));
        const [contributorSnap, provisionalSnap, mediaSnap] = await Promise.all([tx.get(contributorRef),tx.get(provisionalPotholeRef),tx.get(serverDb.collection('mediaObjects').doc(String(subData.mediaId)))]);
        if(!provisionalSnap.exists || provisionalSnap.data()?.status!=='provisional' || !mediaSnap.exists || mediaSnap.data()?.ownerId!==subData.userId) throw new Error('Pending photo or pothole is no longer available.');
        const reviewImage=mediaBinding(mediaSnap.data()!);
        if(subData.imageHash && reviewImage.imageHash!==subData.imageHash) throw new Error('Pending photo changed.');
        const claimRef=serverDb.collection('imageClaims').doc(reviewImage.contentHash);
        const claimSnap=await tx.get(claimRef);
        if(claimSnap.exists && (claimSnap.data()?.submissionId!==submissionId || claimSnap.data()?.mediaId!==subData.mediaId || claimSnap.data()?.imageHash!==reviewImage.imageHash)) throw new Error('Photo claim does not match the pending submission.');
        if(subData.verificationId&&!claimSnap.exists) throw new Error('Pending photo claim is missing.');
        const auditRef=serverDb.collection('adminAudit').doc();
        const writeReview=()=>{if(!claimSnap.exists) tx.create(claimRef,{submissionId,mediaId:subData.mediaId,imageHash:reviewImage.imageHash,createdAt:FieldValue.serverTimestamp()}); tx.set(auditRef,{eventId:auditRef.id,actorUid:actor.uid,actorEmail:String(actor.email||''),action:'submission_review',targetType:'pothole',targetId:subData.potholeId,reason:reason.slice(0,400),afterSummary:resolution,createdAt:FieldValue.serverTimestamp()});};
        if (!contributorSnap.exists) {
          throw new Error('Patcher profile not found.');
        }
        const contributorData = contributorSnap.data()!;

        if (resolution === 'confirm_distinct') {
          const credit=await prepareContribution(serverDb,tx,{submissionId,uid:String(subData.userId),user:contributorData,potholeId:String(subData.potholeId),streetName:String(subData.streetName||'Atlanta Street'),distinct:true});
          writeReview();
          credit();
          tx.update(provisionalPotholeRef, {
            status: 'accepted',
            verificationStatus: 'accepted',
            evidenceCount:1,
            updatedAt: FieldValue.serverTimestamp(),
          });
          tx.update(subRef, {
            duplicateStatus: 'distinct',
            updatedAt: FieldValue.serverTimestamp(),
          });

          return {
            alreadyResolved: false,
            duplicateStatus: 'distinct',
            potholeId: subData.potholeId,
            contributorUid: String(subData.userId),
            username: String(subData.username || 'atlanta_user'),
            displayName: String(subData.displayName || 'Patcher'),
            streetName: String(subData.streetName || 'Atlanta Street'),
          };
        }

        // merge_evidence
        const targetRef = serverDb.collection('potholes').doc(targetPotholeId);
        const targetSnap = await tx.get(targetRef);
        if (!targetSnap.exists || !['accepted','reported','acknowledged'].includes(String(targetSnap.data()?.status)) || targetPotholeId===subData.potholeId || !isValidCoordinatePair(Number(subData.lat),Number(subData.lng)) || !isValidCoordinatePair(Number(targetSnap.data()?.lat),Number(targetSnap.data()?.lng)) || haversineMeters(Number(subData.lat),Number(subData.lng),Number(targetSnap.data()?.lat),Number(targetSnap.data()?.lng))>25) {
          throw new Error('Accepted nearby target pothole not found for evidence merge.');
        }
        const prior=await tx.get(serverDb.collection('submissions').where('userId','==',subData.userId).where('potholeId','==',targetPotholeId).limit(5));
        if(prior.size>=2) throw new Error('Evidence limit reached.');
        const credit=await prepareContribution(serverDb,tx,{submissionId,uid:String(subData.userId),user:contributorData,potholeId:targetPotholeId,streetName:String(subData.streetName||'Atlanta Street'),distinct:false});
        writeReview();
        credit();

        tx.update(provisionalPotholeRef, {
          status: 'rejected',
          verificationStatus: 'rejected',
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(targetRef, {
          evidenceCount: FieldValue.increment(1),
          submissionCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(subRef, {
          potholeId: targetPotholeId,
          duplicateStatus: 'evidence_added',
          updatedAt: FieldValue.serverTimestamp(),
        });


        return {
          alreadyResolved: false,
          duplicateStatus: 'evidence_added',
          potholeId: targetPotholeId,
          contributorUid: String(subData.userId),
          username: String(subData.username || 'atlanta_user'),
          displayName: String(subData.displayName || 'Patcher'),
          streetName: String(subData.streetName || 'Atlanta Street'),
        };
      });
}

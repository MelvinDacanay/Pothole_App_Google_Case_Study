import { hashBytes } from './verificationPolicy.ts';
import { FieldValue, type Firestore, type Transaction, type DocumentData } from 'firebase-admin/firestore';
import { getCurrentWeekKey, getCurrentMonthKey, evaluateUserAchievements, createNotification } from './social.ts';
import { evaluateSegmentMembershipAndThreshold } from './segments.ts';

export function collectionStatsForApprovedCapture(user: DocumentData, now=new Date()) {
  const today=now.toISOString().slice(0,10), previous=new Date(now);previous.setUTCDate(previous.getUTCDate()-1);
  const last=String(user.lastCollectedDate||''), streak=Math.max(0,Number(user.dailyStreak||0));
  return {potholesCollectedCount:FieldValue.increment(1),dailyStreak:last===today?Math.max(1,streak):last===previous.toISOString().slice(0,10)?Math.max(1,streak+1):1,lastCollectedDate:today};
}
export async function prepareContribution(db:Firestore,tx:Transaction,p:{submissionId:string;uid:string;user:DocumentData;potholeId:string;streetName:string;neighborhood?:string;distinct:boolean}) {
  // Caller must run this during the read phase, and apply the returned closure during the write phase.
  const statsRef=db.collection('leaderboardStats').doc(p.uid), effectRef=db.collection('contributionEffects').doc(p.submissionId);
  const [statsSnap,effectSnap]=await Promise.all([tx.get(statsRef),tx.get(effectRef)]);
  if(effectSnap.exists) throw new Error('Contribution has already been credited.');
  const old=statsSnap.data()||{}, now=new Date(),week=getCurrentWeekKey(now),month=getCurrentMonthKey(now),delta=p.distinct?1:0;
  const username=String(p.user.username||'atlanta_user').slice(0,32),displayName=String(p.user.displayName||'Patcher').slice(0,64);
  const cleanStreet=p.streetName.replace(/^\d+\s+/,'').trim().slice(0,128)||'Atlanta Street';
  const total=Number(p.user.distinctPotholeCount||0)+delta;
  return ()=>{
    tx.update(db.collection('users').doc(p.uid),{distinctPotholeCount:FieldValue.increment(delta),evidenceCount:FieldValue.increment(1),...collectionStatsForApprovedCapture(p.user,now),updatedAt:FieldValue.serverTimestamp()});
    tx.set(statsRef,{uid:p.uid,username,displayName,...(p.user.photoURL?{photoURL:String(p.user.photoURL).slice(0,512)}:{}),showOnLeaderboard:!!p.user.showOnLeaderboard,shareNeighborhood:!!p.user.shareNeighborhood,neighborhood:p.user.shareNeighborhood?String(p.user.homeNeighborhood||p.neighborhood||'').slice(0,64):'',overallDistinctCount:total,overallEvidenceCount:Number(p.user.evidenceCount||0)+1,weekKey:week,monthKey:month,weeklyDistinctCount:(old.weekKey===week?Number(old.weeklyDistinctCount||0):0)+delta,weeklyEvidenceCount:(old.weekKey===week?Number(old.weeklyEvidenceCount||0):0)+1,monthlyDistinctCount:(old.monthKey===month?Number(old.monthlyDistinctCount||0):0)+delta,monthlyEvidenceCount:(old.monthKey===month?Number(old.monthlyEvidenceCount||0):0)+1,updatedAt:FieldValue.serverTimestamp()},{merge:true});
    const eventId=`contrib_${hashBytes(p.submissionId)}`;
    tx.create(db.collection('activityFeed').doc(eventId),{eventId,actorUid:p.uid,actorUsername:username,actorDisplayName:displayName,eventType:p.distinct?'new_pothole':'evidence_added',summary:(p.distinct?`@${username} documented a distinct pothole on ${cleanStreet}`:`@${username} added supporting photo evidence on ${cleanStreet}`).slice(0,200),streetName:cleanStreet,...(p.neighborhood?{neighborhood:p.neighborhood.slice(0,64)}:{}),potholeId:p.potholeId,visibility:'public',createdAt:FieldValue.serverTimestamp()});
    tx.create(effectRef,{ownerId:p.uid,submissionId:p.submissionId,potholeId:p.potholeId,distinct:p.distinct,totalDistinct:total,status:'pending',createdAt:FieldValue.serverTimestamp()});
  };
}
// Secondary effects are durable and retryable. Core counts, leaderboard and contribution feed are already committed atomically.
export async function finishContribution(db:Firestore,submissionId:string) {
  const ref=db.collection('contributionEffects').doc(submissionId), snap=await ref.get(),e=snap.data();
  if(!e||e.status==='completed') return null;
  const [sub,pot]=await Promise.all([db.collection('submissions').doc(submissionId).get(),db.collection('potholes').doc(String(e.potholeId)).get()]);
  if(!['distinct','evidence_added'].includes(String(sub.data()?.duplicateStatus))||!['accepted','reported','acknowledged','repaired'].includes(String(pot.data()?.status))) {await ref.update({status:'cancelled'});return null;}
  if(e.status==='cancelled') return null;
  const segment=e.distinct?await evaluateSegmentMembershipAndThreshold(db,String(e.potholeId)):null;
  await evaluateUserAchievements(db,String(e.ownerId),true);
  if(e.distinct&&[5,15,30,75].includes(Number(e.totalDistinct))) await createNotification(db,{uid:String(e.ownerId),notificationId:`milestone_${submissionId}`.slice(0,128),type:'leaderboard_milestone',title:`${e.totalDistinct} Distinct Atlanta Potholes`,body:`You have documented ${e.totalDistinct} accepted distinct potholes.`,relatedId:String(e.potholeId)});
  await ref.update({status:'completed',completedAt:FieldValue.serverTimestamp()});return segment;
}

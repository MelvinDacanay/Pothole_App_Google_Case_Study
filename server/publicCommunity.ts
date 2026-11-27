import { hashBytes } from './verificationPolicy.ts';
const safeId=/^[A-Za-z0-9_-]{1,128}$/;
const text=(v:unknown,max=128)=>typeof v==='string'?v.slice(0,max):'';
export function publicPothole(id:string,p:Record<string,any>){
 const media=text(p.primaryMediaId);const street=text(p.streetName).replace(/^\d{1,6}\s+/, '');
 return {potholeId:id,lat:p.lat,lng:p.lng,streetName:street,formattedAddress:street,normalizedStreet:text(p.normalizedStreet),city:'Atlanta',state:'GA',jurisdiction:p.jurisdiction,status:p.status,verificationStatus:p.verificationStatus,severityLabel:p.severityLabel,primaryMediaId:media,primaryPhotoUrl:safeId.test(media)?`/api/media/${media}`:'',evidenceCount:Number(p.evidenceCount||1),submissionCount:Number(p.submissionCount||1),primaryContributorUid:'',primaryContributorUsername:'community',primaryContributorDisplayName:'Community Patcher',coordinateSource:'manual_pin',locationUserCorrected:false};
}
export function publicEvidence(id:string,p:Record<string,any>){const media=text(p.mediaId);return {submissionId:id,duplicateStatus:p.duplicateStatus,mediaId:media,photoUrl:safeId.test(media)?`/api/media/${media}`:'',username:'community',displayName:'Community Patcher'};}
export function publicActivity(id:string,p:Record<string,any>){const type=text(p.eventType);const labels:Record<string,string>={new_pothole:'A Patcher documented a pothole.',evidence_added:'A Patcher added a photo.',badge_unlocked:'A Patcher earned an achievement.',confirmed_repair:'A pothole repair was confirmed.'};return {eventId:hashBytes(id),eventType:type,summary:labels[type]||'Community activity',visibility:'public',actorUid:'',actorUsername:'community',actorDisplayName:'Community Patcher'};}

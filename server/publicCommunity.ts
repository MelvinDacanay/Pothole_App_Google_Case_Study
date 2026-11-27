import { isIndependentRecord } from './locationPolicy.ts';
import { isWithinAtlantaMetro } from './geo.ts';
import { hashBytes } from './verificationPolicy.ts';
const safeId=/^[A-Za-z0-9_-]{1,128}$/;
const text=(v:unknown,max=128)=>typeof v==='string'?v.slice(0,max):'';
const username=(v:unknown)=>typeof v==='string'&&/^[a-z0-9_]{3,32}$/.test(v)?v:'community';
const displayName=(v:unknown)=>text(v,64).trim()||'Community Patcher';
const source=(v:unknown)=>['gps_verified','exif_extracted','manual_pin'].includes(String(v));
export function canDisplayPothole(p:Record<string,any>|undefined):boolean {
 return !!p && p.verificationStatus==='accepted' && ['accepted','reported','acknowledged','repaired'].includes(String(p.status)) && source(p.coordinateSource) && typeof p.lat==='number' && typeof p.lng==='number' && Number.isFinite(p.lat) && Number.isFinite(p.lng) && isWithinAtlantaMetro(p.lat,p.lng);
}
export function publicPothole(id:string,p:Record<string,any>){
 const media=text(p.primaryMediaId);const independent=isIndependentRecord(p);const street=independent?text(p.streetName).replace(/^\d{1,6}\s+/, ''):'Location awaiting street verification';
 const avatar=text(p.primaryContributorPhotoURL,512);
 return {potholeId:id,lat:p.lat,lng:p.lng,streetName:street,formattedAddress:street,normalizedStreet:independent?text(p.normalizedStreet):'',city:'Atlanta',state:'GA',jurisdiction:independent&&['atldot','gdot'].includes(p.jurisdiction)?p.jurisdiction:'unknown',status:'accepted',verificationStatus:'accepted',severityLabel:p.severityLabel,primaryMediaId:media,primaryPhotoUrl:safeId.test(media)?`/api/media/${media}`:'',evidenceCount:Number(p.evidenceCount||1),submissionCount:Number(p.submissionCount||1),primaryContributorUid:'',primaryContributorUsername:username(p.primaryContributorUsername),primaryContributorDisplayName:displayName(p.primaryContributorDisplayName),...(/^\/api\/media\/avt_[A-Za-z0-9_-]+$/.test(avatar)?{primaryContributorPhotoURL:avatar}:{}),coordinateSource:source(p.coordinateSource)?p.coordinateSource:'manual_pin',locationUserCorrected:false};
}
export function publicEvidence(id:string,p:Record<string,any>){const media=text(p.mediaId);return {submissionId:id,duplicateStatus:p.duplicateStatus,mediaId:media,photoUrl:safeId.test(media)?`/api/media/${media}`:'',username:username(p.username),displayName:displayName(p.displayName)};}
export function isPublicActivity(p:Record<string,any>):boolean{return p.visibility==='public'&&['new_pothole','evidence_added','badge_unlocked'].includes(String(p.eventType));}
export function publicActivity(id:string,p:Record<string,any>,visiblePothole?:Record<string,any>){
 const type=text(p.eventType),user=username(p.actorUsername);const labels:Record<string,string>={new_pothole:'documented a pothole.',evidence_added:'added a supporting photo.',badge_unlocked:'earned an achievement.'};
 const potId=text(p.potholeId);const link=(type==='new_pothole'||type==='evidence_added')&&safeId.test(potId)&&canDisplayPothole(visiblePothole);
 return {eventId:hashBytes(id),eventType:type,summary:`@${user} ${labels[type]||'shared community activity.'}`,visibility:'public',actorUid:'',actorUsername:user,actorDisplayName:displayName(p.actorDisplayName),...(link?{potholeId:potId}:{})};
}

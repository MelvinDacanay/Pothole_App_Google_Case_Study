import { hasRedaction, redactWithGoogle, redactionFields, type PhotoRedactor } from './photoRedaction.ts';
import { getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { FieldValue, Timestamp, type Firestore, type DocumentData } from 'firebase-admin/firestore';
import { extractBytesBuffer, prepareImage } from './imageBytes.ts';
import { sanitizePhoto, SANITIZER_VERSION, PHOTO_PRIVACY_VERSION, THUMBNAIL_MAX_BYTES } from './photoPrivacy.ts';
import { boundedInt, hashBytes, MAX_IMAGE_BYTES } from './verificationPolicy.ts';

export const MEDIA_ID = /^(?:med|avt)_[A-Za-z0-9_-]{1,120}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const DAY = 86_400_000;
export type MediaVariant = 'evidence'|'thumb';
export type MediaData = DocumentData;
export function mediaBackend(): 'firestore'|'gcs' {
  const value=process.env.PATCHUP_MEDIA_STORAGE||'firestore';
  if(value!=='firestore'&&value!=='gcs') throw new Error('Media storage is not configured.');
  return value;
}
function bucket() {
  const name=process.env.PATCHUP_MEDIA_BUCKET?.trim();
  const app=getApps()[0];
  if(!name || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(name)||!app)throw new Error('Private media bucket is not configured.');
  return getStorage(app).bucket(name);
}
export function objectPath(mediaId:string,hash:string,variant:MediaVariant) {
  if(!SAFE_ID.test(mediaId)||!HASH.test(hash))throw new Error('Invalid stored media reference.');
  return `patchup/media/v1/${mediaId}/${hash}/${variant}.jpg`;
}
const canonical=(m:MediaData)=>m.sanitizerVersion===SANITIZER_VERSION&&m.state==='ready';
export function isReadableMedia(m:MediaData|undefined):m is MediaData {
  return !!m&&typeof m.ownerId==='string'&&!!m.ownerId&&(!m.state||m.state==='ready')&&['image/jpeg','image/png','image/webp'].includes(m.contentType);
}
// Use only immutable, server-authored hash metadata inside Firestore transactions. No external
// network calls occur inside a submission transaction. Legacy byte records keep their old bindings.
export function mediaBinding(m:MediaData) {
  if(!isReadableMedia(m))throw new Error('Photo is not ready.');
  if(canonical(m)){
    if(!HASH.test(String(m.imageHash))||m.contentHash!==m.imageHash)throw new Error('Invalid photo binding.');
    if(m.storageBackend==='firestore') {
      const data=extractBytesBuffer(m.data);
      if(!data||hashBytes(data)!==m.imageHash)throw new Error('Photo integrity check failed.');
    } else if(m.storageBackend!=='gcs')throw new Error('Invalid photo storage.');
    return {imageHash:m.imageHash as string,contentHash:m.contentHash as string};
  }
  const data=extractBytesBuffer(m.data);if(!data)throw new Error('Invalid photo bytes.');
  return prepareImage(data,String(m.contentType));
}
function validateStored(bytes:Buffer,m:MediaData,variant:MediaVariant) {
  const expected=variant==='thumb'?m.thumbnailHash:m.imageHash;
  const size=variant==='thumb'?m.thumbnailBytes:m.sizeBytes;
  const limit=variant==='thumb'?THUMBNAIL_MAX_BYTES:MAX_IMAGE_BYTES;
  if(!Number.isInteger(size)||size<1||size>limit||bytes.length!==size||!HASH.test(String(expected))||hashBytes(bytes)!==expected)throw new Error('Stored photo integrity check failed.');
  const prepared=prepareImage(bytes,'image/jpeg');
  if(prepared.imageHash!==prepared.contentHash)throw new Error('Unexpected stored photo metadata.');
  return bytes;
}
async function fetchObject(mediaId:string,m:MediaData,variant:MediaVariant) {
  const b=bucket();if(m.bucketName!==b.name)throw new Error('Media bucket changed; migrate before switching buckets.');
  const generation=String(variant==='thumb'?m.thumbnailGeneration:m.generation);
  if(!/^\d+$/.test(generation))throw new Error('Invalid stored photo generation.');
  const file=b.file(objectPath(mediaId,m.imageHash,variant),{generation});
  // Bound reads before allocating a buffer; immutable generation and expected size are required.
  const [metadata]=await file.getMetadata();
  const size=Number(variant==='thumb'?m.thumbnailBytes:m.sizeBytes);
  const limit=variant==='thumb'?THUMBNAIL_MAX_BYTES:MAX_IMAGE_BYTES;
  if(metadata.generation!==generation||Number(metadata.size)!==size||!Number.isInteger(size)||size<1||size>limit)throw new Error('Stored photo size changed.');
  const [bytes]=await file.download({validation:'crc32c'});
  return validateStored(bytes,m,variant);
}
export async function loadMediaBytes(mediaId:string,m:MediaData,variant:MediaVariant='evidence',purpose:'display'|'analysis'='display') {
  if(!isReadableMedia(m))throw new Error('Photo not found.');
  if(canonical(m)) {
    const bytes=m.storageBackend==='gcs'?await fetchObject(mediaId,m,variant):m.storageBackend==='firestore'?validateStored(extractBytesBuffer(variant==='thumb'?m.thumbnailData:m.data)||Buffer.alloc(0),m,variant):null;
    if(!bytes)throw new Error('Invalid photo storage.');
    return {buffer:bytes,contentType:'image/jpeg',ownerId:String(m.ownerId)};
  }
  // Legacy raw bytes are available only to the trusted verification path (which sanitizes again
  // at the provider boundary); the display path always emits a fresh, metadata-free JPEG.
  const bytes=extractBytesBuffer(m.data);if(!bytes)throw new Error('Photo unavailable.');
  if(purpose==='analysis'&&variant==='evidence'){prepareImage(bytes,m.contentType);return {buffer:bytes,contentType:String(m.contentType),ownerId:String(m.ownerId)};}
  const clean=await sanitizePhoto(bytes,m.contentType);return {buffer:variant==='thumb'?clean.thumbnail:clean.bytes,contentType:clean.mime,ownerId:String(m.ownerId)};
}
async function putObject(mediaId:string,imageHash:string,variant:MediaVariant,bytes:Buffer) {
  const b=bucket(),file=b.file(objectPath(mediaId,imageHash,variant));
  try {await file.save(bytes,{resumable:false,validation:'crc32c',preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:'image/jpeg',cacheControl:'private, no-store'}});}
  catch(err){if(Number((err as {code?:unknown})?.code)!==412)throw err;}
  const [meta]=await file.getMetadata();
  if(!meta.generation||Number(meta.size)!==bytes.length)throw new Error('Unable to verify saved photo.');
  // Check retries/collisions against actual bytes before publishing a pointer.
  const immutable=b.file(file.name,{generation:meta.generation});const [saved]=await immutable.download({validation:'crc32c'});
  if(hashBytes(saved)!==hashBytes(bytes))throw new Error('Stored photo hash mismatch.');
  return String(meta.generation);
}
export async function saveCloudPair(mediaId:string,clean:Awaited<ReturnType<typeof sanitizePhoto>>) {
  const generation=await putObject(mediaId,clean.imageHash,'evidence',clean.bytes);
  const thumbnailGeneration=await putObject(mediaId,clean.imageHash,'thumb',clean.thumbnail);
  return {bucketName:bucket().name,generation,thumbnailGeneration};
}
function uploadResult(mediaId:string,m:MediaData) {return {storagePath:`mediaObjects/${mediaId}`,downloadUrl:`/api/media/${mediaId}`,contentType:m.contentType,sizeBytes:m.sizeBytes};}
export function mediaFields(clean:Awaited<ReturnType<typeof sanitizePhoto>>) {
  return {contentType:clean.mime,width:clean.width,height:clean.height,sizeBytes:clean.bytes.length,thumbnailBytes:clean.thumbnail.length,imageHash:clean.imageHash,contentHash:clean.contentHash,thumbnailHash:clean.thumbnailHash,sanitizerVersion:SANITIZER_VERSION};
}
// Server-only upload. Ready uploads are idempotent; unfinished/concurrent redaction attempts may consume additional DLP quota.
export async function storeSanitizedUpload(db:Firestore,p:{uid:string;mediaId:string;bytes:Buffer;mime:string}, redact:PhotoRedactor=redactWithGoogle) {
  if(!MEDIA_ID.test(p.mediaId))throw new Error('Invalid photo ID.');
  const requestHash=hashBytes(p.bytes), ref=db.collection('mediaObjects').doc(p.mediaId), now=Date.now();
  const previous=(await ref.get()).data();
  if(previous){if(previous.ownerId!==p.uid||previous.uploadRequestHash!==requestHash)throw new Error('Photo ID already used.');if(p.mediaId.startsWith('med_')&&!hasRedaction(previous))throw new Error('Select the photo again for privacy protection.');if(canonical(previous))return uploadResult(p.mediaId,previous);}
  const isPothole=p.mediaId.startsWith('med_');
  const sanitized=await sanitizePhoto(p.bytes,p.mime);
  const clean=isPothole?await redact(db,p.uid,sanitized):sanitized, fields=mediaFields(clean);
  const storageBackend=previous?.storageBackend||mediaBackend();
  if(storageBackend!=='gcs'&&storageBackend!=='firestore')throw new Error('Invalid storage configuration.');
  if(storageBackend==='gcs')bucket(); // fail before reservation if no bucket name
  const day=new Date(now).toISOString().slice(0,10),month=day.slice(0,7),size=clean.bytes.length+clean.thumbnail.length;
  const quotaRefs=[db.collection('mediaBudgets').doc(`user_${hashBytes(p.uid)}_${day}`),db.collection('mediaBudgets').doc(`day_${day}`),db.collection('mediaBudgets').doc(`month_${month}`),db.collection('mediaBudgets').doc(`allocated_${storageBackend}`)];
  const caps=[boundedInt(process.env.PATCHUP_UPLOAD_USER_DAILY_LIMIT,10,1000),boundedInt(process.env.PATCHUP_UPLOAD_DAILY_LIMIT,100,10000),boundedInt(process.env.PATCHUP_UPLOAD_MONTHLY_LIMIT,1000,100000),boundedInt(process.env.PATCHUP_MEDIA_MAX_NEW_BYTES,storageBackend==='gcs'?3_000_000_000:250_000_000,4_000_000_000)];
  const record={...fields,...(isPothole?redactionFields(clean.imageHash):{}),mediaId:p.mediaId,ownerId:p.uid,privacyVersion:PHOTO_PRIVACY_VERSION,uploadRequestHash:requestHash,sourceContentHash:prepareImage(p.bytes,p.mime).contentHash,storageBackend,createdAt:FieldValue.serverTimestamp(),cleanupAfter:Timestamp.fromMillis(now+DAY)};
  const reservation=await db.runTransaction(async tx=>{
    const [old,retired,...q]=await Promise.all([tx.get(ref),tx.get(db.collection('mediaRetired').doc(p.mediaId)),...quotaRefs.map(r=>tx.get(r))]);
    if(retired.exists)throw new Error('Photo expired. Select it again.');
    if(old.exists){const m=old.data()!;if(isPothole&&!hasRedaction(m))throw new Error('Select the photo again for privacy protection.');if(m.ownerId!==p.uid||m.uploadRequestHash!==requestHash||m.imageHash!==clean.imageHash||m.storageBackend!==storageBackend)throw new Error('Photo ID already used.');if(canonical(m))return {done:true,m};if(m.state!=='pending'||Number(m.cleanupAfter?.toMillis?.()||0)<=now)throw new Error('Photo upload expired.');return {done:false,m};}
    if(q.some((v,i)=>Number(v.data()?.count||0)+(i===3?size:1)>caps[i]))throw new Error('Photo storage or upload allowance reached. Try again later.');
    quotaRefs.forEach((r,i)=>tx.set(r,{count:FieldValue.increment(i===3?size:1),...(i===0?{ownerId:p.uid}:{}),...(i<3?{expiresAt:Timestamp.fromMillis(now+(i===2?62:2)*DAY)}:{})},{merge:true}));
    if(storageBackend==='firestore'){const m={...record,state:'ready',data:clean.bytes,thumbnailData:clean.thumbnail};tx.create(ref,m);return {done:true,m};}
    const m={...record,state:'pending',bucketName:bucket().name};tx.create(ref,m);return {done:false,m};
  });
  if(reservation.done)return uploadResult(p.mediaId,reservation.m);
  const objects=await saveCloudPair(p.mediaId,clean);
  await db.runTransaction(async tx=>{
    const [current,retired]=await Promise.all([tx.get(ref),tx.get(db.collection('mediaRetired').doc(p.mediaId))]);const m=current.data();
    if(retired.exists||!m||m.ownerId!==p.uid||m.imageHash!==clean.imageHash||m.uploadRequestHash!==requestHash)throw new Error('Photo upload expired.');
    if(!canonical(m))tx.update(ref,{...objects,state:'ready'});
  });
  return uploadResult(p.mediaId,record);
}
// Persist object cleanup work in the same transaction as removal of the Firestore record.
export function retireMedia(tx:FirebaseFirestore.Transaction,db:Firestore,ref:FirebaseFirestore.DocumentReference,m:MediaData) {
  tx.set(db.collection('mediaRetired').doc(ref.id),{retiredAt:FieldValue.serverTimestamp(),...(m.storageBackend==='gcs'?{objectCleanup:true,bucketName:m.bucketName,imageHash:m.imageHash}: {})});
  tx.delete(ref);
}
async function clearRetiredObject(mediaId:string,m:MediaData) {
  const b=bucket();if(m.bucketName!==b.name)throw new Error('Wrong media bucket for cleanup.');
  for(const variant of ['evidence','thumb'] as const){const f=b.file(objectPath(mediaId,m.imageHash,variant));try{const [metadata]=await f.getMetadata();if(!metadata.generation)throw new Error('Missing generation.');await f.delete({ifGenerationMatch:metadata.generation});}catch(e){if(Number((e as {code?:unknown})?.code)!==404)throw e;}}
}
export async function runMediaMaintenance(db:Firestore,now=Date.now(),max=20) {
  const expired=await db.collection('mediaObjects').where('cleanupAfter','<=',Timestamp.fromMillis(now)).limit(max).get();let retired=0,retained=0,deletedObjects=0,failures=0;
  for(const d of expired.docs){try{const action=await db.runTransaction(async tx=>{
    const current=await tx.get(d.ref);const m=current.data();if(!m||Number(m.cleanupAfter?.toMillis?.()||Infinity)>now)return 'skip';
    const [subs,pots,owner]=await Promise.all([tx.get(db.collection('submissions').where('mediaId','==',d.id)),tx.get(db.collection('potholes').where('primaryMediaId','==',d.id)),tx.get(db.collection('users').doc(String(m.ownerId)))]);
    const keep=subs.docs.some(s=>['distinct','evidence_added','pending_review'].includes(String(s.data().duplicateStatus)))||pots.docs.some(s=>['accepted','reported','acknowledged','repaired','provisional'].includes(String(s.data().status)))||owner.data()?.photoURL===`/api/media/${d.id}`;
    if(keep){if(!d.id.startsWith('avt_'))tx.update(d.ref,{cleanupAfter:FieldValue.delete()});else tx.update(d.ref,{cleanupAfter:Timestamp.fromMillis(now+7*DAY)});return 'keep';}
    retireMedia(tx,db,d.ref,m);return 'retire';
  });if(action==='retire')retired++;if(action==='keep')retained++;}catch{failures++;}}
  const pending=await db.collection('mediaRetired').where('objectCleanup','==',true).limit(max).get();
  for(const d of pending.docs){try{await clearRetiredObject(d.id,d.data());await d.ref.update({objectCleanup:false,bucketName:FieldValue.delete(),imageHash:FieldValue.delete()});deletedObjects++;}catch{failures++;}}
  // Cache/quotas are disposable after expiry; never delete contribution claims or accepted records.
  let expiredPrivate=0;
  for(const col of ['imageAnalysisCache','verificationBudgets','mediaBudgets','geocodeCache','roadLookups']){try{const s=await db.collection(col).where('expiresAt','<=',Timestamp.fromMillis(now)).limit(max).get();if(!s.empty){const b=db.batch();s.docs.forEach(d=>b.delete(d.ref));await b.commit();expiredPrivate+=s.size;}}catch{failures++;}}
  return {retired,retained,deletedObjects,expiredPrivate,failures};
}

import type { Firestore } from 'firebase-admin/firestore';
import { sanitizePhoto } from './photoPrivacy.ts';
import { hashBytes, MAX_IMAGE_BYTES } from './verificationPolicy.ts';

export const REDACTION_VERSION = 'dlp-face-plate-v1';
export const REDACTION_TYPES = ['OBJECT_TYPE/PERSON/FACE', 'OBJECT_TYPE/LICENSE_PLATE'] as const;
type CleanPhoto = Awaited<ReturnType<typeof sanitizePhoto>>;
export type PhotoRedactor = (db: Firestore, uid: string, clean: CleanPhoto) => Promise<CleanPhoto>;
export function redactionEnabled(env = process.env) {
  return Boolean(env.K_SERVICE) && !env.FIRESTORE_EMULATOR_HOST;
}
export function hasRedaction(m: Record<string, unknown> | undefined, hash?: string): boolean {
  return !!m && m.redactionVersion === REDACTION_VERSION && typeof m.redactedImageHash === 'string' && /^[a-f0-9]{64}$/.test(m.redactedImageHash) && m.redactedImageHash === (hash ?? m.imageHash);
}
export function redactionFields(hash: string) { return {redactionVersion: REDACTION_VERSION, redactedImageHash: hash}; }
export function redactionWindows(uid: string, bytes: number, now: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_IMAGE_BYTES) throw new Error('Invalid redaction input.');
  const iso = new Date(now).toISOString(), minute = Math.floor(now/60000), user = hashBytes(uid);
  return [
    {id:`minute_${minute}`, max:10, cost:1},
    {id:`day_${iso.slice(0,10)}`, max:100, cost:1},
    {id:`month_${iso.slice(0,7)}`, max:1000, cost:1},
    {id:`user_${user}_${iso.slice(0,10)}`, max:10, cost:1},
    {id:`bytes_${iso.slice(0,7)}`, max:400_000_000, cost:bytes},
  ];
}
export async function reserveRedaction(db: Firestore, uid: string, bytes: number, now = Date.now()) {
  const limits = redactionWindows(uid, bytes, now);
  const refs = limits.map(w=>db.collection('redactionBudgets').doc(w.id));
  return db.runTransaction(async tx=>{
    const docs = await Promise.all(refs.map(r=>tx.get(r)));
    const counts = docs.map(d=>d.exists ? d.data()?.count : 0);
    if(counts.some((n,i)=>typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n+limits[i].cost>limits[i].max)) return false;
    refs.forEach((r,i)=>tx.set(r,{count:Number(counts[i])+limits[i].cost,expiresAt:new Date(now+62*86400000)}));
    return true;
  });
}
export function redactionRequest(clean: CleanPhoto) {
  const infoTypes = REDACTION_TYPES.map(name=>({name}));
  return {byteItem:{type:'IMAGE_JPEG',data:clean.bytes.toString('base64')},inspectConfig:{infoTypes,minLikelihood:'POSSIBLE'},imageRedactionConfigs:infoTypes.map(infoType=>({infoType})),includeFindings:false};
}
export async function redactWithGoogle(db: Firestore, uid: string, clean: CleanPhoto, fetcher: typeof fetch = fetch): Promise<CleanPhoto> {
  if(!redactionEnabled()) throw new Error('Photo privacy protection unavailable.');
  // Only the attached runtime identity is used; server startup verifies it.
  const tokenRes=await fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(4000)});
  if(!tokenRes.ok) throw new Error('Photo privacy protection unavailable.');
  const token=(await tokenRes.json()).access_token;
  if(typeof token!=='string'||!token) throw new Error('Photo privacy protection unavailable.');
  if(!await reserveRedaction(db,uid,clean.bytes.length)) throw new Error('Photo privacy allowance reached. Try again later.');
  // No retry, no raw-photo persistence, no findings, no user ID/location sent to DLP.
  const result=await fetcher('https://dlp.googleapis.com/v2/projects/patchup-fff96/locations/us/image:redact',{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-Goog-User-Project':'patchup-fff96','Content-Type':'application/json'},body:JSON.stringify(redactionRequest(clean)),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!result.ok) throw new Error('Photo privacy protection unavailable.');
  // Bound streamed response before parsing (provider JPEG can be larger than input).
  const reader=result.body?.getReader(); if(!reader) throw new Error('Missing redacted image.');
  const parts: Uint8Array[]=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_000_000)throw new Error('Redacted image too large.');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const raw=JSON.parse(Buffer.concat(parts).toString('utf8'))?.redactedImage;
  if(typeof raw!=='string'||!raw||!(/^[A-Za-z0-9+/]+={0,2}$/).test(raw))throw new Error('Missing redacted image.');
  const bytes=Buffer.from(raw,'base64');
  if(bytes.toString('base64')!==raw||bytes.length>MAX_IMAGE_BYTES)throw new Error('Invalid redacted image.');
  const redacted=await sanitizePhoto(bytes,'image/jpeg');
  if(redacted.width!==clean.width||redacted.height!==clean.height)throw new Error('Unexpected redacted image dimensions.');
  return redacted;
}

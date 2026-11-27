import 'dotenv/config';
import fs from 'node:fs/promises';
import { initializeApp,cert,applicationDefault } from 'firebase-admin/app';
import { getFirestore,FieldValue,Timestamp } from 'firebase-admin/firestore';
import { extractBytesBuffer,prepareImage } from '../server/imageBytes.ts';
import { sanitizePhoto,SANITIZER_VERSION } from '../server/photoPrivacy.ts';
import { mediaFields,saveCloudPair,loadMediaBytes,runMediaMaintenance } from '../server/mediaStore.ts';
import { hashBytes } from '../server/verificationPolicy.ts';
import { credentialMode, verifyCloudRunIdentity } from '../server/runtimeAuth.ts';
const args=process.argv.slice(2),val=(k:string)=>args.includes(k)?args[args.indexOf(k)+1]:undefined;
const config=JSON.parse(await fs.readFile(new URL('../firebase-applet-config.json',import.meta.url),'utf8'));
if(val('--project')!==config.projectId||val('--database')!==(config.firestoreDatabaseId||'(default)'))throw new Error('Explicit matching --project and --database required.');
const apply=args.includes('--apply'),target=val('--target')||'firestore',limit=Number(val('--limit')||25),after=val('--after');
if(!['firestore','gcs','prune','maintenance'].includes(target)||!Number.isInteger(limit)||limit<1||limit>50)throw new Error('Invalid target or limit.');
if(apply&&!args.includes('--maintenance-window'))throw new Error('Pause uploads/reviews/account deletion and explicitly pass --maintenance-window.');
const mode=credentialMode(process.env);
await verifyCloudRunIdentity(config.projectId);
const parsed=mode==='service_account'?JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!):null;
if(parsed&&parsed.project_id!==config.projectId)throw new Error('Firebase credential project mismatch.');
const credential=parsed?cert(parsed):applicationDefault();
const app=initializeApp({projectId:config.projectId,credential}),db=getFirestore(app,config.firestoreDatabaseId||'(default)');
if(target==='maintenance'){if(!apply)throw new Error('Cleanup requires --apply.');console.log(await runMediaMaintenance(db,Date.now(),limit));process.exit(0);}
let q:FirebaseFirestore.Query=db.collection('mediaObjects').orderBy('__name__').limit(limit);if(after)q=q.startAfter(after);
const snap=await q.get();let migrated=0,skipped=0,failed=0;
for(const d of snap.docs){try{
 const m=d.data(); if(m.state&&m.state!=='ready'){skipped++;continue;}
 const [subs,pots,owner]=await Promise.all([db.collection('submissions').where('mediaId','==',d.id).get(),db.collection('potholes').where('primaryMediaId','==',d.id).get(),db.collection('users').doc(String(m.ownerId)).get()]);
 if(subs.docs.some(s=>s.data().duplicateStatus==='pending_review')||pots.docs.some(p=>p.data().status==='provisional')){skipped++;continue;}
 const retained=subs.docs.some(s=>['distinct','evidence_added'].includes(s.data().duplicateStatus))||pots.docs.some(p=>['accepted','reported','acknowledged','repaired'].includes(p.data().status))||owner.data()?.photoURL===`/api/media/${d.id}`;
 if(!retained){if(apply)await d.ref.update({cleanupAfter:Timestamp.fromMillis(Date.now()+7*86400000)});skipped++;continue;}
 if(target==='prune'){if(m.storageBackend!=='gcs'||m.sanitizerVersion!==SANITIZER_VERSION){skipped++;continue;}await loadMediaBytes(d.id,m);await loadMediaBytes(d.id,m,'thumb');if(apply)await d.ref.update({data:FieldValue.delete(),thumbnailData:FieldValue.delete()});migrated++;continue;}
 if(m.storageBackend===target&&m.sanitizerVersion===SANITIZER_VERSION){skipped++;continue;}
 const old=extractBytesBuffer(m.data);const source=m.sanitizerVersion===SANITIZER_VERSION?await loadMediaBytes(d.id,m,'evidence','analysis'):old?{buffer:old,contentType:String(m.contentType)}:null;if(!source)throw new Error('Missing legacy bytes');
 const clean=m.sanitizerVersion===SANITIZER_VERSION?{bytes:source.buffer,thumbnail:(await loadMediaBytes(d.id,m,'thumb')).buffer,mime:'image/jpeg' as const,width:m.width,height:m.height,imageHash:m.imageHash,contentHash:m.contentHash,thumbnailHash:m.thumbnailHash}:await sanitizePhoto(source.buffer,source.contentType);
 if(!apply){migrated++;continue;}
 const originalHash=m.sourceContentHash||prepareImage(source.buffer,source.contentType).contentHash;
 const cloud=target==='gcs'?await saveCloudPair(d.id,clean):{};
 await db.runTransaction(async tx=>{const current=await tx.get(d.ref);if(!current.exists||!current.updateTime?.isEqual(d.updateTime))throw new Error('Photo changed during migration');const oldClaim=await tx.get(db.collection('imageClaims').doc(originalHash));const newClaim=await tx.get(db.collection('imageClaims').doc(clean.contentHash));if(newClaim.exists&&newClaim.data()?.mediaId!==d.id)throw new Error('Existing image claim conflict');if(oldClaim.exists&&!newClaim.exists)tx.create(newClaim.ref,{...oldClaim.data(),imageHash:clean.imageHash});tx.update(d.ref,{...mediaFields(clean),...cloud,storageBackend:target,state:'ready',sourceContentHash:originalHash,data:clean.bytes,thumbnailData:clean.thumbnail,cleanupAfter:d.id.startsWith('avt_')?Timestamp.fromMillis(Date.now()+7*86400000):FieldValue.delete()});});migrated++;
 }catch{failed++;console.error('Migration skipped an invalid or changed record:',d.id);}}
console.log({apply,target,eligibleOrMigrated:migrated,skipped,failed,nextCursor:snap.docs.at(-1)?.id||null});if(failed)process.exitCode=1;

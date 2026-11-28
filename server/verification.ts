import { aiBudgetWindows, budgetAvailable, APPROVED_GEMINI_MODEL } from './aiBudget.ts';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { geminiClassifier, type ImageClassifier, type ProviderResult } from './gemini.ts';
import { prepareImage } from './imageBytes.ts';
import { autoAcceptEnabled, classifyObservation, hashBytes, modelId, PROMPT_VERSION, SCHEMA_VERSION, publicSummary, releaseId, VALID_MS, validateObservation, type VerificationRecord, type Failure } from './verificationPolicy.ts';

export { authorizeVerification } from './verificationPolicy.ts';
export { prepareImage } from './imageBytes.ts';
export function publicVerification(v: VerificationRecord) {
  const decision = v.classificationDecision === 'verified' && !autoAcceptEnabled(v.model) ? 'needs_review' : v.classificationDecision;
  return { verificationId:v.verificationId, mediaId:v.mediaId, verificationState:v.verificationState, classificationDecision:decision,
    status:v.verificationState === 'completed'?'completed':'unavailable', available:v.verificationState==='completed', model:v.model,
    isRoadDefect:decision==='verified', severityLabel:'unclassified', confidence:0,
    summary:v.failureCategory==='quota'?'Photo verification quota reached. Try again later or request manual review.':v.classificationDecision==='verified'&&decision==='needs_review'?'A possible pothole was detected. Automatic acceptance is disabled; send for review.':publicSummary(v.observation),
    duplicateLikelihood:'not_compared', ...(v.failureCategory?{error:v.failureCategory}:{}), expiresAtMs:v.expiresAtMs };
}

type CacheRecord = { state:'pending'|'completed'|'unavailable'; lease:string; leaseUntilMs:number; result:ProviderResult|null; expiresAtMs:number; retryAfterMs:number };
export async function verifyImage(db: Firestore, p: {uid:string; mediaId:string; bytes:Buffer; mime:string; consent:boolean;redactedImageHash?:string}, provider: ImageClassifier = geminiClassifier): Promise<VerificationRecord> {
  const prepared=prepareImage(p.bytes,p.mime), now=Date.now(), model=modelId();
  const baseKey=hashBytes(JSON.stringify([p.uid,prepared.contentHash,releaseId(model)]));
  const cacheRef=db.collection('imageAnalysisCache').doc(baseKey);
  const verificationId='ver_'+hashBytes(JSON.stringify([p.uid,p.mediaId,prepared.imageHash,releaseId(model)]));
  const ref=db.collection('imageVerifications').doc(verificationId);
  const lease=randomUUID();
  const limits=aiBudgetWindows(p.uid,now);
  const budgetRefs=limits.map(l=>db.collection('verificationBudgets').doc(l.id));
  const circuitRef=db.collection('verificationBudgets').doc('circuit');
  const makeRecord=(result:ProviderResult, stamp=Date.now()): VerificationRecord=>{
    let checked=result;
    if(result.ok) {try {checked={...result,observation:validateObservation(result.observation)};}catch{checked={ok:false,failure:'invalid_response'};}}
    return {verificationId,mediaId:p.mediaId,ownerId:p.uid,imageHash:prepared.imageHash,contentHash:prepared.contentHash,model,promptVersion:PROMPT_VERSION,schemaVersion:SCHEMA_VERSION,provider:'gemini',verificationState:checked.ok?'completed':'unavailable',classificationDecision:checked.ok?classifyObservation(checked.observation):null,observation:checked.ok?checked.observation:null,failureCategory:checked.ok===true?null:checked.failure,createdAtMs:stamp,expiresAtMs:stamp+VALID_MS,consumedSubmissionId:null};
  };
  const persist=(tx:FirebaseFirestore.Transaction,v:VerificationRecord)=>tx.set(ref,{...v,updatedAt:FieldValue.serverTimestamp(),expiresAt:Timestamp.fromMillis(v.expiresAtMs)});
  const reserved=await db.runTransaction(async tx=>{
    const [old,cache,claim,...budgets]=await Promise.all([tx.get(ref),tx.get(cacheRef),tx.get(db.collection('imageClaims').doc(prepared.contentHash)),...budgetRefs.map(r=>tx.get(r)),tx.get(circuitRef)]);
    if(claim.exists) throw new Error('This photo was already submitted.');
    const existing=old.data() as VerificationRecord|undefined;
    if(existing?.consumedSubmissionId) throw new Error('This photo was already submitted.');
    if(existing?.verificationState==='pending'&&now-existing.createdAtMs<60_000) return {kind:'busy' as const};
    if(process.env.PATCHUP_IMAGE_AI_ENABLED!=='true'||!p.consent||model!==APPROVED_GEMINI_MODEL||p.redactedImageHash!==prepared.imageHash) {const v=makeRecord({ok:false,failure:'disabled'},now);persist(tx,v);return {kind:'done' as const,v};}
    const c=cache.data() as CacheRecord|undefined;
    if(c?.state==='pending'&&c.leaseUntilMs>now) return {kind:'busy' as const};
    if(c?.result && ((c.state==='completed'&&c.expiresAtMs>now)||(c.state==='unavailable'&&c.retryAfterMs>now))) {
      const v=makeRecord(c.result,now); if(c.state==='completed') v.expiresAtMs=Math.min(v.expiresAtMs,c.expiresAtMs); persist(tx,v); return {kind:'done' as const,v};
    }
    const circuit=budgets[limits.length].data();
    if(Number(circuit?.openUntilMs||0)>now || limits.some((l,i)=>!budgetAvailable(budgets[i].exists?budgets[i].data()?.count:0,l.max))) {
      const v=makeRecord({ok:false,failure:'quota'},now);persist(tx,v);return {kind:'done' as const,v};
    }
    // Read phase above; reserve all attempts durably before making an external call.
    limits.forEach((l,i)=>tx.set(budgetRefs[i],{count:FieldValue.increment(1),expiresAt:Timestamp.fromMillis(l.expires),...(l.ownerId?{ownerId:l.ownerId}:{})},{merge:true}));
    tx.set(cacheRef,{ownerId:p.uid,state:'pending',lease,leaseUntilMs:now+60_000,result:null,expiresAtMs:now+VALID_MS,retryAfterMs:0,expiresAt:Timestamp.fromMillis(now+VALID_MS)});
    const pending:VerificationRecord={...makeRecord({ok:false,failure:'busy'},now),verificationState:'pending',failureCategory:null};persist(tx,pending);
    return {kind:'reserved' as const};
  });
  if(reserved.kind==='done') return reserved.v;
  if(reserved.kind==='busy') throw new Error('An image check is already running. Retry shortly.');
  let result:ProviderResult;
  try {result=await provider.classify({bytes:prepared.bytes,mime:prepared.mime,model,redactedImageHash:p.redactedImageHash});if(result.ok) result={...result,observation:validateObservation(result.observation)};} catch {result={ok:false,failure:'invalid_response'};}
  const done=Date.now(), v=makeRecord(result,done);
  return db.runTransaction(async tx=>{
    const [cache,old,circuit]=await Promise.all([tx.get(cacheRef),tx.get(ref),tx.get(circuitRef)]);
    if(cache.data()?.lease!==lease || old.data()?.consumedSubmissionId || old.data()?.verificationState!=='pending') throw new Error('Image check superseded. Retry shortly.');
    const failures=result.ok?0:Number(circuit.data()?.failures||0)+1;
    const shouldOpen=result.ok===false&&(result.failure==='quota'||failures>=3);
    tx.set(circuitRef,{failures,openUntilMs:shouldOpen?done+60_000:0},{merge:true});
    tx.set(cacheRef,{ownerId:p.uid,state:result.ok?'completed':'unavailable',lease,leaseUntilMs:0,result,expiresAtMs:done+VALID_MS,retryAfterMs:done+30_000,expiresAt:Timestamp.fromMillis(done+VALID_MS)});
    persist(tx,v);
    return v;
  });
}

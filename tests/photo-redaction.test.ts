import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { Firestore } from 'firebase-admin/firestore';
import { sanitizePhoto } from '../server/photoPrivacy.ts';
import { hasRedaction, redactionFields, redactionEnabled, redactionWindows, reserveRedaction, redactWithGoogle, redactionRequest, REDACTION_TYPES } from '../server/photoRedaction.ts';
import { geminiClassifier } from '../server/gemini.ts';
import { storeSanitizedUpload } from '../server/mediaStore.ts';

const uid='test-user';
function fakeDb(initial:Record<string,number>={}) {
 const counts=new Map(Object.entries(initial));
 const db={collection:()=>({doc:(id:string)=>({id,get:async()=>({data:()=>undefined})})}),runTransaction:async(fn:(tx:any)=>Promise<any>)=>fn({get:async(r:{id:string})=>({exists:counts.has(r.id),data:()=>({count:counts.get(r.id)})}),set:(r:{id:string},v:{count:number})=>counts.set(r.id,v.count)})} as unknown as Firestore;
 return {db,counts};
}
async function photo(color:string){return sanitizePhoto(await sharp({create:{width:400,height:300,channels:3,background:color}}).jpeg().toBuffer(),'image/jpeg');}
test('redaction is mandatory on Cloud Run even with an old false flag; emulator cannot call live service',()=>{
 assert.equal(redactionEnabled({K_SERVICE:'patchup'}),true);
 assert.equal(redactionEnabled({K_SERVICE:'patchup',PATCHUP_PHOTO_REDACTION_ENABLED:'false'}),true);
 assert.equal(redactionEnabled({K_SERVICE:'patchup',FIRESTORE_EMULATOR_HOST:'localhost:8080'}),false);
 assert.equal(redactionEnabled({}),false);
});
test('redaction proof is bound to exact image bytes and version',async()=>{
 const a=await photo('red'), b=await photo('black');
 assert.equal(hasRedaction({...redactionFields(a.imageHash),imageHash:a.imageHash}),true);
 assert.equal(hasRedaction(redactionFields(a.imageHash),b.imageHash),false);
 assert.equal(hasRedaction({imageHash:a.imageHash}),false);
});
test('request contains face and license plate detectors, no findings or account/location metadata',async()=>{
 const clean=await photo('red'); const req=redactionRequest(clean);
 assert.deepEqual(req.inspectConfig.infoTypes.map(x=>x.name),[...REDACTION_TYPES]);
 assert.deepEqual([...REDACTION_TYPES],['OBJECT_TYPE/PERSON/FACE','OBJECT_TYPE/LICENSE_PLATE']);
 assert.deepEqual(req.imageRedactionConfigs.map(x=>x.infoType.name),[...REDACTION_TYPES]);
 assert.equal(req.includeFindings,false);
 assert.equal(req.byteItem.data,clean.bytes.toString('base64'));
 assert.deepEqual(Object.keys(req).sort(),['byteItem','imageRedactionConfigs','includeFindings','inspectConfig']);
});
test('quota exhaustion refuses provider attempts; counts and bytes reserved together',async()=>{
 const now=Date.UTC(2026,10,27), windows=redactionWindows(uid,100,now);
 const first=fakeDb();assert.equal(await reserveRedaction(first.db,uid,100,now),true);
 for(const w of windows)assert.equal(first.counts.get(w.id),w.cost);
 for(const w of windows){const f=fakeDb({[w.id]:w.max});assert.equal(await reserveRedaction(f.db,uid,100,now),false);assert.equal(f.counts.size,1);}
});
test('mocked DLP output replaces original pixels; malformed response and HTTP failures block upload',async()=>{
 const clean=await photo('red'), masked=await photo('black');
 const old=process.env.K_SERVICE, emu=process.env.FIRESTORE_EMULATOR_HOST;
 process.env.K_SERVICE='test';delete process.env.FIRESTORE_EMULATOR_HOST;
 try {
  let calls=0;
  const fetcher=(payload:unknown,status=200)=>async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
   calls++;if(String(input).startsWith('http://metadata.google.internal/'))return Response.json({access_token:'test-only'});
   assert.equal(String(input),'https://dlp.googleapis.com/v2/projects/patchup-fff96/locations/us/image:redact');
   assert.equal(init?.method,'POST');return Response.json(payload,{status});
  };
  const result=await redactWithGoogle(fakeDb().db,uid,clean,fetcher({redactedImage:masked.bytes.toString('base64')}));
  assert.notEqual(result.imageHash,clean.imageHash);assert.equal(result.width,clean.width);assert.equal(calls,2);
  const pixel=await sharp(result.thumbnail).raw().toBuffer();assert.ok(pixel.every(v=>v<10));
  await assert.rejects(redactWithGoogle(fakeDb().db,uid,clean,fetcher({},503)));
  await assert.rejects(redactWithGoogle(fakeDb().db,uid,clean,fetcher({redactedImage:'bad'})));
 }finally{if(old===undefined)delete process.env.K_SERVICE;else process.env.K_SERVICE=old;if(emu===undefined)delete process.env.FIRESTORE_EMULATOR_HOST;else process.env.FIRESTORE_EMULATOR_HOST=emu;}
});
test('failed redaction stops storage and unproven bytes are rejected at Gemini boundary',async()=>{
 const clean=await photo('red');const f=fakeDb();
 await assert.rejects(storeSanitizedUpload(f.db,{uid,mediaId:'med_test',bytes:clean.bytes,mime:'image/jpeg'},async()=>{throw new Error('redaction unavailable');}),/redaction unavailable/);
 assert.equal(f.counts.size,0);
 assert.deepEqual(await geminiClassifier.classify({bytes:clean.bytes,mime:'image/jpeg',model:'gemini-3.5-flash-lite'}),{ok:false,failure:'disabled'});
});

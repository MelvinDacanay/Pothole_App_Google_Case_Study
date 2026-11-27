import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {sanitizePhoto,geminiInlinePhoto,decodeUpload} from '../server/photoPrivacy.ts';
import {prepareImage} from '../server/imageBytes.ts';
import {publicActivity,publicEvidence,publicPothole} from '../server/publicCommunity.ts';
import {cleanObservedStreet,matchCityRoad} from '../server/roadLocation.ts';
import {mediaBinding,mediaFields} from '../server/mediaStore.ts';
for(const format of ['jpeg','png','webp'] as const)test(`pixel re-encode removes embedded metadata: ${format}`,async()=>{
 const input=await sharp({create:{width:640,height:480,channels:3,background:'#555555'}}).withExif({IFD0:{Artist:'PRIVATE_PERSON_123',ImageDescription:'PRIVATE_GPS_123'}}).toFormat(format).toBuffer();
 const clean=await sanitizePhoto(input,`image/${format}`);assert.equal(clean.mime,'image/jpeg');assert.equal(clean.width,640);assert.equal(clean.height,480);assert.ok(clean.thumbnail.length<=40000);assert.equal((await sharp(clean.thumbnail).metadata()).width,320);
 const inline=await geminiInlinePhoto(input,`image/${format}`);assert.deepEqual(Object.keys(inline).sort(),['data','mimeType']);const bytes=Buffer.from(inline.data,'base64');assert.equal(bytes.includes(Buffer.from('PRIVATE_PERSON_123')),false);const meta=await sharp(bytes).metadata();assert.equal(meta.exif,undefined);assert.equal(meta.xmp,undefined);assert.equal(prepareImage(bytes,'image/jpeg').imageHash,prepareImage(bytes,'image/jpeg').contentHash);
 assert.equal(mediaBinding({...mediaFields(clean),state:'ready',ownerId:'owner',storageBackend:'firestore',data:clean.bytes}).imageHash,clean.imageHash);
});
test('invalid image and noncanonical base64 fail closed',async()=>{await assert.rejects(sanitizePhoto(Buffer.from('bad'),'image/jpeg'));assert.throws(()=>decodeUpload('YWJj===='));assert.throws(()=>decodeUpload('not a base64'));});
test('private contributor fields do not reach public projections',()=>{const p={primaryContributorUid:'secret-uid',userId:'secret-uid',actorUid:'secret-uid',notes:'secret-note',accuracyMeters:12,primaryMediaId:'med_test',mediaId:'med_test',streetName:'Main St',lat:33.75,lng:-84.39,summary:'secret-note',eventType:'new_pothole'};for(const result of [publicPothole('p',p),publicEvidence('s',p),publicActivity('e',p)]){const out=JSON.stringify(result);assert.doesNotMatch(out,/secret-uid|secret-note|accuracyMeters/);}});
test('street labels reject home address and private contact details',()=>{assert.equal(cleanObservedStreet('Peachtree St NE'),'Peachtree St NE');assert.equal(cleanObservedStreet('123 Main St'),'');assert.equal(cleanObservedStreet('person@example.com'),'');assert.equal(matchCityRoad([],33.75,-84.39),null);});
import { buildGeminiPhotoRequest, CLASSIFICATION_PROMPT } from '../server/gemini.ts';
test('actual Gemini request builder receives only sanitized pixels and the fixed prompt',async()=>{
 const raw=await sharp({create:{width:500,height:500,channels:3,background:'#444444'}}).jpeg().toBuffer();
 // Real EXIF GPS IFD pointer, latitude (33,45,0) N and longitude (84,23,0) W.
 const t=Buffer.alloc(128);t.write('II');t.writeUInt16LE(42,2);t.writeUInt32LE(8,4);t.writeUInt16LE(1,8);t.writeUInt16LE(0x8825,10);t.writeUInt16LE(4,12);t.writeUInt32LE(1,14);t.writeUInt32LE(26,18);
 t.writeUInt16LE(4,26);for(const [i,tag,type,count,value] of [[0,1,2,2,78],[1,2,5,3,80],[2,3,2,2,87],[3,4,5,3,104]]){const p=28+i*12;t.writeUInt16LE(tag,p);t.writeUInt16LE(type,p+2);t.writeUInt32LE(count,p+4);t.writeUInt32LE(value,p+8);}
 [33,45,0,84,23,0].forEach((v,i)=>{t.writeUInt32LE(v,80+i*8);t.writeUInt32LE(1,84+i*8);});
 const metadata=Buffer.concat([Buffer.from('Exif\0\0'),t]);const app=Buffer.alloc(4);app[0]=255;app[1]=225;app.writeUInt16BE(metadata.length+2,2);
 const xmp=Buffer.from('http://ns.adobe.com/xap/1.0/\0PRIVATE_GPS_33_75');const xm=Buffer.alloc(4);xm[0]=255;xm[1]=225;xm.writeUInt16BE(xmp.length+2,2);
 const input=Buffer.concat([raw.subarray(0,2),app,metadata,xm,xmp,raw.subarray(2)]);
 const req=await buildGeminiPhotoRequest(input,'image/jpeg','test-model');assert.deepEqual(Object.keys(req.contents).sort(),['parts']);assert.equal(req.contents.parts.length,2);assert.equal(req.contents.parts[1].text,CLASSIFICATION_PROMPT);const bytes=Buffer.from(req.contents.parts[0].inlineData!.data,'base64');assert.equal((await sharp(bytes).metadata()).exif,undefined);assert.equal(bytes.includes(xmp),false);assert.equal(bytes.includes(metadata),false);await assert.rejects(sanitizePhoto(Buffer.concat([raw,Buffer.from('trailing private data')]),'image/jpeg'));
});

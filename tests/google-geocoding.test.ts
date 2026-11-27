import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleGeocodingEnabled, parseGoogleStreet, quotaWindows } from '../server/googleGeocoding.ts';
const c=(type:string,longText:string,shortText=longText)=>({types:[type],longText,shortText});
const r=(street:string)=>({types:['street_address'],formattedAddress:`100 ${street}, Atlanta, GA`,placeId:'example',addressComponents:[c('route',street),c('country','United States','US'),c('administrative_area_level_1','Georgia','GA'),c('locality','Atlanta')]});
test('v4 parses a Georgia road and address',()=>{const result=parseGoogleStreet({results:[r('Peachtree St NE')]});assert.equal(result?.streetName,'Peachtree St NE');assert.equal(result?.formattedAddress,'100 Peachtree St NE, Atlanta, GA');});
test('conflicting roads and missing results do not invent a street',()=>{assert.equal(parseGoogleStreet({results:[r('Peachtree St NE'),r('Spring St NW')]}),null);assert.equal(parseGoogleStreet({results:[]}),null);assert.equal(parseGoogleStreet({results:[null]}),null);});
test('live calls require explicit permission and Cloud Run',()=>{assert.equal(googleGeocodingEnabled({}),false);const env={K_SERVICE:'patchup',PATCHUP_GOOGLE_GEOCODING_ENABLED:'true',PATCHUP_GOOGLE_GEOCODING_PREVIEW_APPROVED:'true'};assert.equal(googleGeocodingEnabled(env),true);assert.equal(googleGeocodingEnabled({...env,FIRESTORE_EMULATOR_HOST:'localhost'}),false);});
test('global quotas are shared and user quotas isolated',()=>{const now=Date.UTC(2026,10,27,12,0);const a=quotaWindows('a',now),b=quotaWindows('b',now);assert.deepEqual(a.slice(0,3),b.slice(0,3));assert.notEqual(a[3].id,b[3].id);assert.deepEqual(a.map(x=>x.max),[100,3000,20,5,25]);});

test('provider attempts reserve all counters before the only Google request; quota fails closed', async()=>{
  const {lookupGoogleStreet}=await import('../server/googleGeocoding.ts');
  const keys=['K_SERVICE','PATCHUP_GOOGLE_GEOCODING_ENABLED','PATCHUP_GOOGLE_GEOCODING_PREVIEW_APPROVED','FIRESTORE_EMULATOR_HOST'] as const;
  const old=keys.map(k=>process.env[k]);
  process.env.K_SERVICE='patchup';process.env.PATCHUP_GOOGLE_GEOCODING_ENABLED='true';process.env.PATCHUP_GOOGLE_GEOCODING_PREVIEW_APPROVED='true';delete process.env.FIRESTORE_EMULATOR_HOST;
  try {
    let count=0,sets=0,calls=0;
    const db={collection:()=>({doc:(id:string)=>id}),runTransaction:async(fn:(tx:unknown)=>Promise<boolean>)=>fn({get:async()=>({exists:true,data:()=>({count})}),set:()=>{sets++;}})};
    const fakeFetch=async (input:RequestInfo|URL,init?:RequestInit)=>{
      const url=String(input);
      if(url.startsWith('http://metadata.google.internal/'))return new Response(JSON.stringify({access_token:'test-token'}));
      calls++;assert.equal(sets,5);assert.match(url,/^https:\/\/geocode\.googleapis\.com\/v4\/geocode\/location\//);assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test-token');assert.equal(new Headers(init?.headers).get('X-Goog-Api-Key'),null);
      return new Response(JSON.stringify({results:[r('Peachtree St NE')]}));
    };
    const result=await lookupGoogleStreet(db as never,'u',33.75,-84.39,'test-project',fakeFetch);assert.equal(result.status,'ok');assert.equal(calls,1);
    count=100;const blocked=await lookupGoogleStreet(db as never,'u',33.75,-84.39,'test-project',fakeFetch);assert.equal(blocked.status,'quota');assert.equal(calls,1);
  }finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});

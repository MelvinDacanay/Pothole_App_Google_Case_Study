// Read-only inventory; does not declare compliance, log addresses, or mutate records.
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isIndependentRecord } from '../server/locationPolicy.ts';
const args=process.argv.slice(2), val=(k:string)=>args.includes(k)?args[args.indexOf(k)+1]:undefined;
const project=val('--project'),database=val('--database');
if(project!=='patchup-fff96'||database!=='(default)'||!args.includes('--read-only'))throw new Error('Explicit --project patchup-fff96 --database "(default)" --read-only required.');
const app=initializeApp({projectId:project,credential:applicationDefault()});
const db=getFirestore(app,database);
for(const name of ['potholes','submissions','roadLookups','geocodeCache','streetSegments','reports','activityFeed','adminAudit','notifications']){
 let total=0,independent=0,google=0,unknown=0;let after:string|undefined;
 for(;;){const base=db.collection(name).orderBy('__name__').limit(100);const snap=await(after?base.startAfter(after):base).get();if(snap.empty)break;
  for(const d of snap.docs){total++;const data=d.data();if(isIndependentRecord(data))independent++;else if(data.streetSource==='google_geocoding')google++;else unknown++;}after=snap.docs[snap.docs.length-1].id;if(snap.size<100)break;
 }
 console.log(JSON.stringify({collection:name,total,independentVersion:independent,explicitGoogleSource:google,unknownOrDerived:unknown}));
}
console.log('Inventory only. Review nested collections, prior exports, actual provenance, backups, logs and all legacy environments separately. Never enable reporting solely from these counts.');

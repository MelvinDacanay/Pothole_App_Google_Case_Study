import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { geminiClassifier } from '../server/gemini.ts';
import { sanitizePhoto } from '../server/photoPrivacy.ts';
import { prepareImage } from '../server/imageBytes.ts';
import { classifyObservation, modelId, releaseId, boundedInt } from '../server/verificationPolicy.ts';

type Label='pothole'|'not_pothole'|'unclear';
type Row={id:string;file:string;label:Label;group:string;split:'dev'|'holdout';stratum:string};
const args=process.argv.slice(2), value=(name:string)=>args[args.indexOf(name)+1];
if(!args.includes('--confirm-pre-redacted-non-sensitive')||!args.includes('--allow-live')||!args.includes('--manifest')||!args.includes('--output')) throw new Error('Usage: npm run benchmark -- --allow-live --confirm-pre-redacted-non-sensitive --manifest path/to/manifest.json --output results.json [--split dev|holdout] [--limit 50]. Sends approved non-sensitive test photographs to Gemini.');
if(!process.env.GEMINI_API_KEY||process.env.GEMINI_API_KEY==='MY_GEMINI_API_KEY') throw new Error('Configure GEMINI_API_KEY locally.');
const manifest=path.resolve(value('--manifest')), out=path.resolve(value('--output')), split=args.includes('--split')?value('--split'):'dev';
if(!['dev','holdout'].includes(split))throw new Error('Invalid split.');
const dimension=args.includes('--dimension')?Number(value('--dimension')):960;if(![560,960,1280].includes(dimension))throw new Error('Invalid benchmark resolution.');
if(process.env.PATCHUP_GEMINI_DATA_MODE!=='paid')throw new Error('Confirm paid Gemini mode for benchmark.');
const rows=JSON.parse(await fs.readFile(manifest,'utf8')) as Row[];
if(!Array.isArray(rows)||rows.length===0)throw new Error('Manifest must be a nonempty array.');
const ids=new Set<string>(), groups=new Map<string,string>(), content=new Map<string,string>();
const model=modelId(), limit=args.includes('--limit')?boundedInt(value('--limit'),0,5000):5000;
if(limit<1)throw new Error('Invalid limit.');
const data:Array<{row:Row;image:ReturnType<typeof prepareImage>}>=[];
for(const row of rows){
 if(!row||typeof row.id!=='string'||typeof row.file!=='string'||typeof row.group!=='string'||!row.group||typeof row.stratum!=='string'||!row.stratum||!['pothole','not_pothole','unclear'].includes(row.label)||!['dev','holdout'].includes(row.split)||ids.has(row.id))throw new Error('Invalid/duplicate manifest row.');
 ids.add(row.id);const groupSplit=groups.get(row.group);if(groupSplit&&groupSplit!==row.split)throw new Error('Related image group crosses splits.');groups.set(row.group,row.split);
 const file=path.resolve(path.dirname(manifest),row.file);const ext=path.extname(file).toLowerCase(),mime=ext==='.jpg'||ext==='.jpeg'?'image/jpeg':ext==='.png'?'image/png':ext==='.webp'?'image/webp':'';
 const image=prepareImage(await fs.readFile(file),mime);if(content.has(image.contentHash))throw new Error('Duplicate normalized photo: '+row.id);content.set(image.contentHash,row.split);if(row.split===split)data.push({row,image});
}
if(!data.length)throw new Error('No photos for selected split.');
const delay=boundedInt(process.env.BENCHMARK_DELAY_MS,6500,60000);const results:Array<{id:string;label:Label;stratum:string;decision:string;category:string|null;latencyMs:number;inputTokens:number|null;outputTokens:number|null;failure:string|null}>=[];
for(const {row,image} of data.slice(0,limit)){
 const start=performance.now();const clean=await sanitizePhoto(image.bytes,image.mime,dimension);const r=await geminiClassifier.classify({bytes:clean.bytes,mime:clean.mime,model,redactedImageHash:clean.imageHash});const latencyMs=Math.round(performance.now()-start);
 results.push({id:row.id,label:row.label,stratum:row.stratum,decision:r.ok?classifyObservation(r.observation):'unavailable',category:r.ok?r.observation.category:null,latencyMs,inputTokens:r.ok?r.inputTokens:null,outputTokens:r.ok?r.outputTokens:null,failure:r.ok===false?r.failure:null});
 if(r.ok===false&&['quota','unconfigured'].includes(r.failure))break;
 if(results.length<Math.min(data.length,limit)&&delay)await new Promise(r=>setTimeout(r,delay));
}
const pos=results.filter(r=>r.label==='pothole'),neg=results.filter(r=>r.label==='not_pothole'),amb=results.filter(r=>r.label==='unclear');
const tp=pos.filter(r=>r.decision==='verified').length,fp=neg.filter(r=>r.decision==='verified').length,ambAccepted=amb.filter(r=>r.decision==='verified').length;
const ratio=(a:number,b:number)=>b?a/b:null,precision=ratio(tp,tp+fp+ambAccepted),recall=ratio(tp,pos.length),falseAcceptRate=ratio(fp,neg.length),availability=ratio(results.filter(r=>r.decision!=='unavailable').length,results.length),reviewRate=ratio(results.filter(r=>r.decision==='needs_review').length,results.length);
const latency=results.map(r=>r.latencyMs).sort((a,b)=>a-b),percentile=(p:number)=>latency.length?latency[Math.max(0,Math.ceil(latency.length*p)-1)]:null;
const passed=dimension===960&&split==='holdout'&&results.length===data.length&&results.length>=500&&pos.length>=200&&neg.length>=200&&precision!==null&&precision>=.95&&recall!==null&&recall>=.95&&falseAcceptRate!==null&&falseAcceptRate<=.05&&ambAccepted===0&&availability!==null&&availability>=.99;
const byStratum=Object.fromEntries([...new Set(results.map(r=>r.stratum))].map(s=>{const a=results.filter(r=>r.stratum===s);return [s,{n:a.length,verified:a.filter(r=>r.decision==='verified').length,falseAccept:a.filter(r=>r.label!=='pothole'&&r.decision==='verified').length,missedPothole:a.filter(r=>r.label==='pothole'&&r.decision!=='verified').length,review:a.filter(r=>r.decision==='needs_review').length,unavailable:a.filter(r=>r.decision==='unavailable').length}];}));
const report={dimension,model,releaseVersion:releaseId(model),split,requested:data.length,tested:results.length,positives:pos.length,negatives:neg.length,ambiguous:amb.length,tp,fp,ambAccepted,precision,recall,falseAcceptRate,availability,reviewRate,p50Ms:percentile(.5),p95Ms:percentile(.95),reportedInputTokens:results.reduce((n,r)=>n+(r.inputTokens??0),0),reportedOutputTokens:results.reduce((n,r)=>n+(r.outputTokens??0),0),usageMissing:results.filter(r=>r.inputTokens===null||r.outputTokens===null).length,byStratum,passedProposedGate:passed,approvalVersionCandidate:passed?releaseId(model):null,results};
await fs.writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...report,results:undefined},null,2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { aiBudgetWindows, budgetAvailable, hardLimit } from '../server/aiBudget.ts';
import { SharedReadCache } from '../server/sharedReadCache.ts';
test('AI ceilings cannot be raised and invalid settings fail closed',()=>{
  assert.equal(hardLimit('999',100),100);assert.equal(hardLimit('0',100),0);assert.equal(hardLimit('bad',100),0);
  const w=aiBudgetWindows('a',Date.UTC(2026,10,27),{});
  assert.deepEqual(w.map(x=>x.max),[100,25,3000,10,3]);
  const other=aiBudgetWindows('b',Date.UTC(2026,10,27),{});
  assert.equal(w[0].id,other[0].id);assert.notEqual(w[4].id,other[4].id);
  assert.equal(budgetAvailable(2,3),true);for(const v of [3,-1,NaN,'1',undefined])assert.equal(budgetAvailable(v,3),false);
});
test('public reads coalesce, expire, and retry after failure',async()=>{
  let now=0,calls=0;const c=new SharedReadCache<number>(30,2,()=>now);
  const load=async()=>++calls;
  assert.deepEqual(await Promise.all([c.get('a',load),c.get('a',load)]),[1,1]);
  assert.equal(await c.get('a',load),1);now=31;assert.equal(await c.get('a',load),2);
  await assert.rejects(c.get('b',async()=>{throw Error('offline')}));assert.equal(await c.get('b',load),3);
});

test('production container pins and packages independent road data without server secrets',()=>{
  const read=(name:string)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
  const docker=read('Dockerfile'), ignore=read('.dockerignore'), env=read('.env.example'), service=read('deploy/cloud-run.service.yaml');
  assert.match(docker,/RUN sha256sum -c data\/tiger-roads\.sha256/);
  assert.match(docker,/COPY --from=build --chown=node:node \/app\/data\/tiger-roads\.json \.\/data\/tiger-roads\.json/);
  assert.match(docker,/ENV PATCHUP_TIGER_ROADS_FILE=\/app\/data\/tiger-roads\.json/);
  assert.match(ignore,/!data\/tiger-roads\.json/);
  assert.match(ignore,/!data\/tiger-roads\.sha256/);
  const sourceIgnore=read('.gcloudignore');
  assert.match(sourceIgnore,/!data\/tiger-roads\.json/);
  assert.match(sourceIgnore,/!data\/tiger-roads\.sha256/);
  assert.doesNotMatch(sourceIgnore,/^#!include:/m);
  assert.match(read('data/tiger-roads.sha256'),/^[a-f0-9]{64}  data\/tiger-roads\.json\n$/);
  assert.doesNotMatch(docker,/GEMINI_API_KEY|GOOGLE_MAPS_SERVER_API_KEY|FIREBASE_SERVICE_ACCOUNT_JSON/);
  for(const name of ['PATCHUP_IMAGE_AI_ENABLED','PATCHUP_AUTO_ACCEPT','PATCHUP_GOOGLE_GEOCODING_ENABLED','PATCHUP_GOOGLE_GEOCODING_PREVIEW_APPROVED','PATCHUP_CITY_ROADS_ENABLED','PATCHUP_CITY_ROADS_REUSE_APPROVED','PATCHUP_LOCATION_HISTORY_AUDITED','PATCHUP_MEDIA_MAINTENANCE_ENABLED']){
    assert.ok(env.includes(name+'=false'), name);
    assert.match(service,new RegExp('name: '+name+'\\s+value: [\"\']false[\"\']'));
  }
  assert.match(service,/secretKeyRef:\s+name: patchup-gemini-api-key\s+key: '1'/);
  assert.doesNotMatch(service,/GOOGLE_MAPS_SERVER_API_KEY|GMAIL_|PATCHUP_EMAIL_SENDING_ENABLED|FIREBASE_SERVICE_ACCOUNT_JSON/);
  assert.equal(existsSync(new URL('../src/views/CommunityReportsView.tsx',import.meta.url)),false);
});

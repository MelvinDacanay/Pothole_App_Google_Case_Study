import test from 'node:test';
import assert from 'node:assert/strict';
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

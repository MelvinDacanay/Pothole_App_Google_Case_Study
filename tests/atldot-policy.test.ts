import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservation, publicSummary, validateObservation, releaseId, autoAcceptEnabled, CATEGORIES } from '../server/verificationPolicy.ts';
test('ATLDOT categories, quality and cavity decision matrix',()=>{
 for(const category of CATEGORIES) for(const quality of ['usable','limited'] as const) for(const visibleCavity of [true,false]) {
 const o=validateObservation({category,quality,visibleCavity});
 const expected=quality==='limited'||category==='unclear'?'needs_review':category==='pothole'?(visibleCavity?'verified':'needs_review'):category==='cave_in'||category==='utility_defect'?'not_pothole':visibleCavity?'needs_review':'not_pothole';
 assert.equal(classifyObservation(o),expected); assert.ok(publicSummary(o));
 }
});
test('new release does not inherit previous benchmark approval',()=>{
 const old={...process.env}; try {process.env.GEMINI_MODEL='gemini-3.5-flash-lite';process.env.PATCHUP_IMAGE_AI_ENABLED='true';process.env.PATCHUP_AUTO_ACCEPT='true';process.env.PATCHUP_BENCHMARK_APPROVED_VERSION='gemini-3.5-flash-lite|pothole-visual-v2|2';assert.equal(autoAcceptEnabled(),false);assert.equal(releaseId(),'gemini-3.5-flash-lite|atldot-pothole-v3-pixel-v1|3');} finally {for(const k of ['GEMINI_MODEL','PATCHUP_IMAGE_AI_ENABLED','PATCHUP_AUTO_ACCEPT','PATCHUP_BENCHMARK_APPROVED_VERSION']) {if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}
});

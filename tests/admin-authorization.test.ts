import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth, DecodedIdToken, UserRecord } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { authorizeAdmin, getAllowedAdminEmails, isAllowedAdminAccount, isAllowedAdminToken, revokeLegacyAdmin, reconcileAdminDirectory } from '../server/adminAuthorization.ts';
import { credentialMode, verifyCloudRunIdentity } from '../server/runtimeAuth.ts';

const allowed = 'admin@example.test';
const token = (email: string, extra = {}) => ({ uid: 'uid1', email, email_verified: true, ...extra } as DecodedIdToken);
const account = (email: string, extra = {}) => ({ uid: 'uid1', email, emailVerified: true, disabled: false, ...extra } as UserRecord);
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function withAllowlist(value: string, fn: () => Promise<void> | void) {
  return async () => {
    const prior = process.env.PATCHUP_ADMIN_EMAILS;
    process.env.PATCHUP_ADMIN_EMAILS = value;
    try { await fn(); }
    finally { if (prior === undefined) delete process.env.PATCHUP_ADMIN_EMAILS; else process.env.PATCHUP_ADMIN_EMAILS = prior; }
  };
}

test('allowlist normalizes email and denies absent, unverified and disabled identities', withAllowlist('  ADMIN@EXAMPLE.TEST, , admin@example.test ', () => {
  assert.deepEqual([...getAllowedAdminEmails()], [allowed]);
  assert.equal(isAllowedAdminToken(token(allowed)), true);
  assert.equal(isAllowedAdminToken(token(allowed, { email_verified: false })), false);
  assert.equal(isAllowedAdminToken(token('other@example.test', { admin: true })), false);
  assert.equal(isAllowedAdminAccount(account(allowed, { disabled: true })), false);
  assert.equal(isAllowedAdminAccount(account(allowed, { emailVerified: false })), false);
  assert.equal(isAllowedAdminToken(token(allowed), new Set()), false);
}));

test('current account and token must both match; a claim cannot grant privileges', withAllowlist(allowed, async () => {
  let current = account(allowed);
  let reads = 0;
  const auth = { getUser: async () => { reads++; return current; } };
  assert.equal(await authorizeAdmin(auth, token(allowed)), true);
  assert.equal(await authorizeAdmin(auth, token('removed@example.test', { admin: true })), false);
  assert.equal(reads, 1);
  current = account('changed@example.test');
  assert.equal(await authorizeAdmin(auth, token(allowed, { admin: true })), false);
  current = account(allowed, { disabled: true });
  assert.equal(await authorizeAdmin(auth, token(allowed)), false);
  current = account(allowed, { emailVerified: false });
  assert.equal(await authorizeAdmin(auth, token(allowed)), false);
  await assert.rejects(authorizeAdmin({ getUser: async () => { throw new Error('Unavailable'); } }, token(allowed)));
}));

function fixture(email: string, claims: Record<string, unknown>, exists: boolean) {
  let record = exists;
  let current = account(email, { customClaims: claims });
  const operations: string[] = [];
  const ref = { get: async () => ({ exists: record }), delete: async () => { operations.push('delete'); record = false; } };
  const db = { collection: () => ({ doc: () => ref, get: async () => ({ docs: record ? [{ id: 'uid1' }] : [] }) }) } as unknown as Firestore;
  const auth = {
    getUser: async () => current,
    revokeRefreshTokens: async () => { operations.push('revoke'); },
    setCustomUserClaims: async (_uid: string, next: Record<string, unknown>) => { operations.push('claims'); current = account(email, { customClaims: next }); },
  } as unknown as Auth;
  return { db, auth, operations, get current() { return current; }, get record() { return record; } };
}

test('removed admin directory and claim are revoked without losing other claims', withAllowlist(allowed, async () => {
  const f = fixture('removed@example.test', { admin: true, otherRole: 'member' }, true);
  await reconcileAdminDirectory(f.auth, f.db);
  assert.equal(f.record, false);
  assert.deepEqual(f.current.customClaims, { otherRole: 'member' });
  assert.deepEqual(f.operations, ['revoke', 'claims', 'delete']);
  await revokeLegacyAdmin(f.auth, f.db, 'uid1');
  assert.equal(f.operations.length, 3);
}));

test('claim-only former admin is cleaned on bootstrap; eligible and ordinary users are unchanged', withAllowlist(allowed, async () => {
  const stale = fixture('removed@example.test', { admin: true }, false);
  await revokeLegacyAdmin(stale.auth, stale.db, 'uid1');
  assert.deepEqual(stale.operations, ['revoke', 'claims']);
  const eligible = fixture(allowed, { admin: true, otherRole: true }, true);
  await revokeLegacyAdmin(eligible.auth, eligible.db, 'uid1');
  assert.deepEqual(eligible.operations, []);
  const ordinary = fixture('ordinary@example.test', { otherRole: true }, false);
  await revokeLegacyAdmin(ordinary.auth, ordinary.db, 'uid1');
  assert.deepEqual(ordinary.operations, []);
}));

test('missing allowlist denies authority without mutating shared development data', async () => {
  const prior = process.env.PATCHUP_ADMIN_EMAILS;
  delete process.env.PATCHUP_ADMIN_EMAILS;
  try {
    const f = fixture(allowed, { admin: true }, true);
    assert.equal(await authorizeAdmin(f.auth, token(allowed)), false);
    await reconcileAdminDirectory(f.auth, f.db);
    await revokeLegacyAdmin(f.auth, f.db, 'uid1');
    assert.deepEqual(f.operations, []);
  } finally { if (prior !== undefined) process.env.PATCHUP_ADMIN_EMAILS = prior; }
});

test('Cloud Run always uses ADC and rejects credentials and emulators; development remains compatible', () => {
  assert.equal(credentialMode({ K_SERVICE: 'patchup' }), 'adc');
  assert.equal(credentialMode({ CLOUD_RUN_JOB: 'maintenance' }), 'adc');
  for (const key of ['FIREBASE_SERVICE_ACCOUNT_JSON', 'GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'STORAGE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCE_METADATA_ROOT']) {
    assert.throws(() => credentialMode({ K_SERVICE: 'patchup', [key]: 'configured' }), /Cloud Run rejects/);
  }
  assert.equal(credentialMode({ NODE_ENV: 'production', FIREBASE_SERVICE_ACCOUNT_JSON: '{}' }), 'service_account');
  assert.equal(credentialMode({ PATCHUP_USE_ADC: 'true' }), 'adc');
  assert.equal(credentialMode({ GOOGLE_APPLICATION_CREDENTIALS: '/local/path' }), 'adc');
  assert.equal(credentialMode({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), 'adc');
  assert.equal(credentialMode({}), 'unconfigured');
});

test('Cloud Run verifies the attached service account and rejects local ADC files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'patchup-adc-'));
  const env = { K_SERVICE: 'patchup', HOME: home };
  const correct: typeof fetch = async (url, options) => {
    assert.equal(url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email');
    assert.equal(new Headers(options?.headers).get('Metadata-Flavor'), 'Google');
    return new Response('patchup-backend@patchup-fff96.iam.gserviceaccount.com');
  };
  try {
    await verifyCloudRunIdentity('patchup-fff96', env, correct);
    await assert.rejects(verifyCloudRunIdentity('patchup-fff96', env, async () => new Response('default-compute@example.test')), /dedicated PatchUp/);
    await assert.rejects(verifyCloudRunIdentity('patchup-fff96', env, async () => new Response('', { status: 503 })), /dedicated PatchUp/);
    const config = join(home, '.config', 'gcloud');
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'application_default_credentials.json'), '{}');
    await assert.rejects(verifyCloudRunIdentity('patchup-fff96', env, correct), /local ADC files/);
    await verifyCloudRunIdentity('patchup-fff96', {}, async () => { throw new Error('must not query metadata in development'); });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('authorization boundaries do not trust cached claims or Firestore enrollment', () => {
  const server = read('server.ts');
  assert.doesNotMatch(server, /decoded\.admin/);
  assert.match(server, /verifyIdToken\(token, checkRevoked\)/);
  const guard = server.slice(server.indexOf('async function requireAdmin('), server.indexOf('async function startServer()'));
  assert.match(guard, /verifyBearerToken\(req, res, true, true\)/);
  assert.match(guard, /authorizeAdmin\(/);
  const media = server.slice(server.indexOf("app.get('/api/media/:mediaId'"), server.indexOf('// Phase 3 Social'));
  assert.match(media, /authorizeAdmin\(/);
  const rules = read('firestore.rules');
  assert.doesNotMatch(rules, /request\.auth\.token\.admin|isAdmin\(/);
  assert.match(rules, /match \/admins\/\{uid\} \{\s*allow read, write: if false;/);
  const frontend = read('src/context/AuthContext.tsx');
  assert.doesNotMatch(frontend, /claims\.admin|PATCHUP_ADMIN_EMAILS/);
  assert.match(frontend, /\/api\/admin\/bootstrap/);
  assert.match(frontend, /\/api\/auth\/session/);
});

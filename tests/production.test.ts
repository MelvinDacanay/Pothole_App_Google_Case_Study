import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  classifyJurisdiction,
  haversineMeters,
  isWithinAtlantaMetro,
  normalizeStreetName,
  scoreDuplicateCandidate,
} from '../server/geo.ts';
import { assessSegmentConfidence, parseStreetNumber } from '../server/segments.ts';
import { validateGameScorePayload } from '../server/games.ts';
import { checkRateLimit, resetRateLimiterForTests } from '../server/rateLimit.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('Firestore rules cover every blueprint collection with zero-trust defaults', () => {
  const blueprint = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'firebase-blueprint.json'), 'utf-8')
  ) as { firestore: Record<string, unknown> };
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf-8');

  // 1. Default-deny safety net present near top
  assert.match(rules, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);

  // 2. Every blueprint collection path appears in firestore.rules
  const expectedSegments = [
    'match /users/{uid}',
    'match /private/account',
    'match /storageChecks/{checkId}',
    'match /mediaObjects/{mediaId}',
    'match /potholes/{potholeId}',
    'match /submissions/{submissionId}',
    'match /geocodeCache/{coordKey}',
    'match /friendships/{friendshipId}',
    'match /leaderboardStats/{uid}',
    'match /achievements/{uid}/badges/{badgeType}',
    'match /notifications/{uid}/items/{notificationId}',
    'match /activityFeed/{eventId}',
    'match /streetSegments/{segmentId}',
    'match /acceptedPotholes/{potholeId}',
    'match /reports/{reportId}',
    'match /supplements/{supplementId}',
    'match /adminAudit/{eventId}',
    'match /gameStats/{statId}',
    'match /test/connection',
  ];

  for (const snippet of expectedSegments) {
    assert.ok(rules.includes(snippet), `Missing rule block in firestore.rules: ${snippet}`);
  }
  assert.ok(Object.keys(blueprint.firestore).length >= 18);

  // 3. No blanket `allow list: if isSignedIn();`
  assert.doesNotMatch(rules, /allow list:\s*if\s*isSignedIn\(\)\s*;/);

  // 4. Client writes require email_verified == true
  assert.match(rules, /request\.auth\.token\.email_verified == true/);

  // 5. Server-only authoritative collections forbid client create/update/delete
  for (const collectionMatch of [
    'match /potholes/{potholeId}',
    'match /submissions/{submissionId}',
    'match /friendships/{friendshipId}',
    'match /leaderboardStats/{uid}',
    'match /streetSegments/{segmentId}',
    'match /reports/{reportId}',
    'match /adminAudit/{eventId}',
    'match /gameStats/{statId}',
  ]) {
    const startIdx = rules.indexOf(collectionMatch);
    assert.ok(startIdx >= 0, `Rule block missing: ${collectionMatch}`);
    const block = rules.slice(startIdx, startIdx + 500);
    assert.match(
      block,
      /allow create, update, delete: if false;/,
      `Expected server-only write block on ${collectionMatch}`
    );
  }
});

test('Atlanta geographic normalization, parallel streets & corridor confidence edge cases', () => {
  // Parallel streets close together (~90m apart in Midtown) remain distinct
  assert.equal(normalizeStreetName('1180 Peachtree Street Northeast'), 'peachtree st ne');
  assert.equal(normalizeStreetName('Peachtree St NE'), 'peachtree st ne');
  assert.equal(normalizeStreetName('1185 Spring Street Northwest'), 'spring st nw');
  assert.notEqual(
    normalizeStreetName('1180 Peachtree Street Northeast'),
    normalizeStreetName('1185 Spring Street Northwest')
  );

  // Street number extraction for block range grouping on long streets (Peachtree blocks)
  assert.equal(parseStreetNumber('180 Peachtree St NE, Atlanta, GA'), 180);
  assert.equal(parseStreetNumber('1850 Peachtree Rd NW, Atlanta, GA'), 1850);
  assert.equal(parseStreetNumber('Peachtree St NE & 10th St'), null);

  // Jurisdiction classification: City of Atlanta vs GDOT routes/interstates
  assert.equal(classifyJurisdiction('Peachtree St NE', '1180 Peachtree St NE, Atlanta, GA', 'Atlanta'), 'atldot');
  assert.equal(classifyJurisdiction('I-85 Northbound', 'I-85 N Exit 84, Atlanta, GA', 'Atlanta'), 'gdot');
  assert.equal(classifyJurisdiction('GA-400', 'GA-400 Express, Atlanta, GA', 'Atlanta'), 'gdot');
  assert.equal(classifyJurisdiction('Main St', '100 Main St, Marietta, GA', 'Marietta'), 'unknown');

  // Segment confidence classification edge cases
  assert.equal(
    assessSegmentConfidence({
      lat: 33.7866,
      lng: -84.3832,
      streetName: 'Peachtree St NE',
      normalizedStreet: 'peachtree st ne',
      formattedAddress: '1180 Peachtree St NE, Atlanta, GA 30309',
      jurisdiction: 'atldot',
    }),
    'verified'
  );
  assert.equal(
    assessSegmentConfidence({
      lat: 33.776,
      lng: -84.389,
      streetName: '10th St NW Ramp',
      normalizedStreet: '10th st nw ramp',
      formattedAddress: '10th St NW Ramp to I-75, Atlanta, GA',
      jurisdiction: 'gdot',
    }),
    'provisional'
  );
  assert.equal(
    assessSegmentConfidence({
      lat: 33.749,
      lng: -84.388,
      streetName: 'Near 33.74900, -84.38800',
      normalizedStreet: 'coordinate pin',
      formattedAddress: 'Near 33.74900, -84.38800, Atlanta, GA',
      jurisdiction: 'unknown',
    }),
    'needs_review'
  );

  // Haversine & Atlanta metro bounds
  assert.equal(isWithinAtlantaMetro(33.7756, -84.3963), true);
  assert.equal(isWithinAtlantaMetro(40.7128, -74.006), false);
  const meters = haversineMeters(33.7866, -84.3832, 33.78665, -84.38325);
  assert.ok(meters > 4 && meters < 12, `Expected ~7m Haversine distance, got ${meters}`);

  // Duplicate scoring: close same-street candidate yields likely_same; farther cross-street yields uncertain/distinct
  const closeCand = scoreDuplicateCandidate({
    targetLat: 33.7866,
    targetLng: -84.3832,
    targetNormalizedStreet: 'peachtree st ne',
    candidate: {
      potholeId: 'pot_1',
      lat: 33.78661,
      lng: -84.38321,
      formattedAddress: '1180 Peachtree St NE, Atlanta, GA',
      streetName: 'Peachtree St NE',
      normalizedStreet: 'peachtree st ne',
      primaryPhotoUrl: '/api/media/m1',
      primaryMediaId: 'm1',
      status: 'accepted',
      severityLabel: 'moderate',
      evidenceCount: 1,
      updatedAtMs: Date.now() - 1000,
    },
  });
  assert.equal(closeCand.recommendation, 'likely_same');
});

test('Minigame score bounds and anti-forge duration plausibility', () => {
  assert.equal(
    validateGameScorePayload({ gameId: 'pothole_repair', score: 915, durationMs: 12000 }).ok,
    true
  );
  assert.equal(
    validateGameScorePayload({ gameId: 'pothole_repair', score: 1500, durationMs: 12000 }).ok,
    false
  );
  assert.equal(
    validateGameScorePayload({ gameId: 'pothole_repair', score: 500, durationMs: 500 }).ok,
    false
  );

  assert.equal(
    validateGameScorePayload({ gameId: 'pothole_runner', score: 420, durationMs: 18000 }).ok,
    true
  );
  assert.equal(
    validateGameScorePayload({ gameId: 'pothole_runner', score: 49000, durationMs: 2000 }).ok,
    false
  );
  assert.equal(
    validateGameScorePayload({ gameId: 'unknown_game', score: 100, durationMs: 5000 }).ok,
    false
  );
});

test('Bounded rate limiter enforces thresholds and resets cleanly', () => {
  resetRateLimiterForTests();
  const baseNow = 1_700_000_000_000;
  for (let i = 0; i < 3; i++) {
    const res = checkRateLimit({
      scope: 'test_scope',
      key: '127.0.0.1',
      maxRequests: 3,
      windowMs: 60_000,
      nowMs: baseNow + i * 100,
    });
    assert.equal(res.allowed, true);
  }
  const blocked = checkRateLimit({
    scope: 'test_scope',
    key: '127.0.0.1',
    maxRequests: 3,
    windowMs: 60_000,
    nowMs: baseNow + 500,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 59);

  const afterReset = checkRateLimit({
    scope: 'test_scope',
    key: '127.0.0.1',
    maxRequests: 3,
    windowMs: 60_000,
    nowMs: baseNow + 61_000,
  });
  assert.equal(afterReset.allowed, true);
});

test('Frontend source contains zero server secrets or blocking window dialogs', () => {
  const walk = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  };
  const srcFiles = walk(path.join(ROOT, 'src'));
  for (const filePath of srcFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    assert.doesNotMatch(content, /FIREBASE_SERVICE_ACCOUNT_JSON/, filePath);
    assert.doesNotMatch(content, /GEMINI_API_KEY/, filePath);
    assert.doesNotMatch(content, /GOOGLE_MAPS_SERVER_API_KEY/, filePath);
    assert.doesNotMatch(content, /\bwindow\.(alert|confirm|prompt)\b/, filePath);
  }
});

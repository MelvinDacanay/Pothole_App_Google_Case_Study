import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { initializeApp, cert, getApps, type App as AdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth, type DecodedIdToken } from 'firebase-admin/auth';
import {
  FieldValue,
  getFirestore as getAdminFirestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import {
  classifyJurisdiction,
  haversineMeters,
  isValidCoordinatePair,
  isWithinAtlantaMetro,
  MapsQuotaError,
  normalizeStreetName,
  reverseGeocodeCoords,
  scoreDuplicateCandidate,
} from './server/geo.ts';
import {
  analyzePotholeImageWithGemini,
  getConfiguredGeminiModel,
} from './server/gemini.ts';
import {
  createNotification,
  evaluateUserAchievements,
  getCurrentMonthKey,
  getCurrentWeekKey,
  makeFriendshipId,
  recordContributionSocialImpact,
  syncUserLeaderboardProfile,
} from './server/social.ts';
import {
  adminMergeSegments,
  adminReassignPotholeSegment,
  adminReviewPothole,
  adminSplitSegment,
  adminTransitionReportStatus,
  backfillAcceptedPotholeSegments,
  evaluateSegmentMembershipAndThreshold,
  writeAdminAudit,
  type AdminActor,
  type ReportStatus,
  type SegmentConfidence,
} from './server/segments.ts';
import {
  getUserGameStats,
  recordValidatedGameScore,
  validateGameScorePayload,
} from './server/games.ts';
import { createRateLimiter } from './server/rateLimit.ts';
import { deleteUserAccountAndPersonalData } from './server/account.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const ALLOWED_MEDIA_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_COORD_SOURCES = new Set(['gps_verified', 'exif_extracted', 'manual_pin']);
const ALLOWED_SEVERITIES = new Set(['low', 'moderate', 'severe', 'unclassified']);

interface FirebaseClientConfig {
  projectId: string;
  apiKey?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
}

function loadFirebaseConfig(): FirebaseClientConfig | null {
  const configPath = path.resolve(__dirname, 'firebase-applet-config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as FirebaseClientConfig;
  } catch (err) {
    console.error('Failed to parse firebase-applet-config.json:', err);
    return null;
  }
}

const firebaseConfig = loadFirebaseConfig();

let adminApp: AdminApp | null = null;
let adminSdkMode: 'service_account' | 'adc_or_project' | 'unconfigured' = 'unconfigured';

if (firebaseConfig) {
  try {
    if (getApps().length > 0) {
      adminApp = getApps()[0] ?? null;
      adminSdkMode = 'adc_or_project';
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      adminApp = initializeApp({
        credential: cert(parsed),
        projectId: firebaseConfig.projectId,
      });
      adminSdkMode = 'service_account';
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      adminApp = initializeApp({
        projectId: firebaseConfig.projectId,
      });
      adminSdkMode = 'adc_or_project';
    } else {
      console.warn(
        'PatchUp: Firebase Admin SDK skipped for local dev (set FIREBASE_SERVICE_ACCOUNT_JSON in .env or run gcloud auth application-default login). Frontend will still load; /api routes needing Firestore return 503.'
      );
      adminApp = null;
      adminSdkMode = 'unconfigured';
    }
  } catch (err) {
    console.warn('Firebase Admin SDK initialization deferred:', err);
    adminApp = null;
    adminSdkMode = 'unconfigured';
  }
}

export function getServerFirestore() {
  if (!adminApp || !firebaseConfig) return null;
  return firebaseConfig.firestoreDatabaseId
    ? getAdminFirestore(adminApp, firebaseConfig.firestoreDatabaseId)
    : getAdminFirestore(adminApp);
}

let adminFirestoreReady = false;
async function probeAdminFirestore() {
  const serverDb = getServerFirestore();
  if (!serverDb) {
    adminFirestoreReady = false;
    return;
  }
  try {
    await serverDb.collection('test').doc('connection').get();
    adminFirestoreReady = true;
  } catch (err) {
    adminFirestoreReady = false;
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('default credentials') || message.includes('NO_ADC_FOUND')) {
      console.warn('PatchUp: Firestore probe skipped — no Google Application Default Credentials.');
    }
  }
}

function resolveBrowserMapsApiKey(): string {
  return (
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.MAPS_API_KEY ||
    ''
  );
}

function resolveServerMapsApiKey(): string {
  return (
    process.env.GOOGLE_MAPS_SERVER_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.MAPS_API_KEY ||
    ''
  );
}

interface MediaPayload {
  contentType: string;
  buffer: Buffer;
  ownerId?: string;
}

function extractBytesBuffer(rawBytes: unknown): Buffer | null {
  if (Buffer.isBuffer(rawBytes)) return rawBytes;
  if (rawBytes instanceof Uint8Array) return Buffer.from(rawBytes);
  if (
    rawBytes &&
    typeof rawBytes === 'object' &&
    'toUint8Array' in rawBytes &&
    typeof (rawBytes as { toUint8Array: () => Uint8Array }).toUint8Array === 'function'
  ) {
    return Buffer.from((rawBytes as { toUint8Array: () => Uint8Array }).toUint8Array());
  }
  return null;
}

async function fetchMediaViaAdminSdk(mediaId: string): Promise<MediaPayload | null> {
  const serverDb = getServerFirestore();
  if (!serverDb) return null;
  const snap = await serverDb.collection('mediaObjects').doc(mediaId).get();
  if (!snap.exists) return null;

  const docData = snap.data();
  if (!docData) return null;

  const contentType = typeof docData.contentType === 'string' ? docData.contentType : '';
  if (!ALLOWED_MEDIA_CONTENT_TYPES.has(contentType)) {
    throw new Error('Unsupported media contentType stored in mediaObjects');
  }

  const buffer = extractBytesBuffer(docData.data);
  if (!buffer || buffer.length === 0) {
    throw new Error('Empty binary media payload');
  }

  return {
    contentType,
    buffer,
    ownerId: typeof docData.ownerId === 'string' ? docData.ownerId : undefined,
  };
}

async function fetchMediaViaFirestoreRest(mediaId: string): Promise<MediaPayload | null> {
  if (!firebaseConfig) {
    throw new Error('Firebase configuration is unavailable');
  }
  const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
  const baseUrl =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}` +
    `/databases/${encodeURIComponent(databaseId)}/documents/mediaObjects/${encodeURIComponent(mediaId)}`;
  const url = firebaseConfig.apiKey
    ? `${baseUrl}?key=${encodeURIComponent(firebaseConfig.apiKey)}`
    : baseUrl;

  const resp = await fetch(url);
  if (resp.status === 404) {
    return null;
  }
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firestore REST error (${resp.status}): ${errText}`);
  }

  const json = (await resp.json()) as {
    fields?: {
      contentType?: { stringValue?: string };
      ownerId?: { stringValue?: string };
      data?: { bytesValue?: string };
    };
  };

  const contentType = json.fields?.contentType?.stringValue ?? '';
  const bytesBase64 = json.fields?.data?.bytesValue ?? '';

  if (!ALLOWED_MEDIA_CONTENT_TYPES.has(contentType) || !bytesBase64) {
    throw new Error('Invalid media document structure');
  }

  const buffer = Buffer.from(bytesBase64, 'base64');
  if (buffer.length === 0) {
    throw new Error('Decoded binary media payload is empty');
  }

  return {
    contentType,
    buffer,
    ownerId: json.fields?.ownerId?.stringValue,
  };
}

async function verifyBearerToken(
  req: express.Request,
  res: express.Response,
  requireVerifiedEmail = true
): Promise<DecodedIdToken | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required (missing Bearer token).' });
    return null;
  }
  if (!adminApp) {
    res.status(503).json({ error: 'Firebase Admin SDK is not initialized.' });
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const decoded = await getAdminAuth(adminApp).verifyIdToken(token);
    if (requireVerifiedEmail && !decoded.email_verified) {
      res.status(403).json({ error: 'Verified email required to submit road-condition records.' });
      return null;
    }
    return decoded;
  } catch (err) {
    res.status(401).json({
      error: 'Unable to verify Firebase ID token',
      detail: err instanceof Error ? err.message : 'Verification failed',
    });
    return null;
  }
}

async function requireAdmin(
  req: express.Request,
  res: express.Response
): Promise<{ decoded: DecodedIdToken; actor: AdminActor } | null> {
  const decoded = await verifyBearerToken(req, res, true);
  if (!decoded) return null;

  const serverDb = getServerFirestore();
  if (!serverDb || !adminFirestoreReady) {
    res.status(503).json({ error: 'Server Firestore database unavailable.' });
    return null;
  }

  let hasAdminDoc = false;
  try {
    const adminSnap = await serverDb.collection('admins').doc(decoded.uid).get();
    hasAdminDoc = adminSnap.exists;
  } catch {
    hasAdminDoc = false;
  }

  if (!decoded.admin && !hasAdminDoc) {
    res.status(403).json({ error: 'Admin privileges required for civic oversight actions.' });
    return null;
  }

  return {
    decoded,
    actor: {
      uid: decoded.uid,
      email: String(decoded.email || ''),
    },
  };
}

function getAllowedAdminEmails(): Set<string> {
  const configured =
    process.env.PATCHUP_ADMIN_EMAILS ||
    [
      'devkotaarya@gmail.com',
      'pandeysaksham450@gmail.com',
      'amariyahcg@gmail.com',
      'birukgebru23@gmail.com',
      'carolinesalinas09@gmail.com',
      'melvindacanay05@gmail.com',
    ].join(',');
  return new Set(
    configured
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function startServer() {
  await probeAdminFirestore();
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // Bounded rate limiters for expensive & mutating endpoints
  app.use(
    '/api/geocode/reverse',
    createRateLimiter({ scope: 'geocode', maxRequests: 35, windowMs: 60_000 })
  );
  app.use(
    '/api/potholes/analyze',
    createRateLimiter({ scope: 'gemini_analyze', maxRequests: 15, windowMs: 60_000 })
  );
  app.use(
    '/api/potholes/submit',
    createRateLimiter({ scope: 'pothole_submit', maxRequests: 20, windowMs: 60_000 })
  );
  app.use(
    '/api/friends/request',
    createRateLimiter({ scope: 'friend_req', maxRequests: 25, windowMs: 60_000 })
  );
  app.use(
    '/api/games/score',
    createRateLimiter({ scope: 'game_score', maxRequests: 30, windowMs: 60_000 })
  );
  app.use(
    '/api/account',
    createRateLimiter({ scope: 'account', maxRequests: 10, windowMs: 60_000 })
  );
  app.use(
    '/api/admin',
    createRateLimiter({ scope: 'admin', maxRequests: 80, windowMs: 60_000 })
  );

  app.get('/api/health', (_req, res) => {
    const mapsBrowserKey = resolveBrowserMapsApiKey();
    res.json({
      ok: true,
      service: 'patchup-server',
      phase: 6,
      firebaseConfigured: Boolean(firebaseConfig),
      firebaseProjectId: firebaseConfig?.projectId ?? null,
      firestoreDatabaseId: firebaseConfig?.firestoreDatabaseId ?? null,
      firebaseStorageEnabled: false,
      mediaStoreMode: 'firestore_isolated_mediaObjects_spark_free',
      mapsConfigured: Boolean(mapsBrowserKey),
      adminSdkMode,
      adminAuthVerifyReady: Boolean(adminApp),
      adminFirestoreReady,
      rateLimitingEnabled: true,
      securityHeadersEnabled: true,
      accountDeletionEnabled: true,
      geminiConfigured: Boolean(
        process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ),
      geminiModel: getConfiguredGeminiModel(),
    });
  });

  app.get('/api/maps/config', (_req, res) => {
    const apiKey = resolveBrowserMapsApiKey();
    res.json({
      configured: Boolean(apiKey),
      apiKey,
      mapId: process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID',
    });
  });

  app.get('/api/auth/session', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;
    res.json({
      uid: decoded.uid,
      emailVerified: Boolean(decoded.email_verified),
      admin: Boolean(decoded.admin),
    });
  });

  app.post('/api/geocode/reverse', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!isValidCoordinatePair(lat, lng)) {
      res.status(400).json({ error: 'Invalid latitude or longitude coordinates.' });
      return;
    }

    try {
      const serverDb = adminFirestoreReady ? getServerFirestore() : null;
      const result = await reverseGeocodeCoords({
        lat,
        lng,
        apiKey: resolveServerMapsApiKey(),
        firestoreDb: serverDb,
      });
      res.json({
        ...result,
        inAtlantaMetro: isWithinAtlantaMetro(lat, lng),
      });
    } catch (err) {
      if (err instanceof MapsQuotaError) {
        res.status(429).json({
          error: err.message,
          quotaExceeded: true,
        });
        return;
      }
      res.status(502).json({
        error: 'Reverse geocoding failed.',
        detail: err instanceof Error ? err.message : 'Unexpected error',
      });
    }
  });

  app.post('/api/potholes/candidates', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const rawStreet = typeof req.body?.streetName === 'string' ? req.body.streetName : '';
    const targetNormalizedStreet = normalizeStreetName(rawStreet);

    if (!isValidCoordinatePair(lat, lng)) {
      res.status(400).json({ error: 'Valid coordinates are required for candidate search.' });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore connection unavailable.' });
      return;
    }

    try {
      // 25-meter search window (~0.00025 deg latitude; prefilter slightly wider ~0.0005 deg)
      const latDelta = 0.0005;
      const snap = await serverDb
        .collection('potholes')
        .where('lat', '>=', lat - latDelta)
        .where('lat', '<=', lat + latDelta)
        .limit(80)
        .get();

      const candidates = snap.docs
        .map((d) => {
          const data = d.data();
          const pLat = Number(data.lat);
          const pLng = Number(data.lng);
          const dist = haversineMeters(lat, lng, pLat, pLng);
          if (dist > 25 || data.status === 'rejected') return null;

          const updatedAt = data.updatedAt as Timestamp | undefined;
          return scoreDuplicateCandidate({
            targetLat: lat,
            targetLng: lng,
            targetNormalizedStreet,
            candidate: {
              potholeId: String(data.potholeId || d.id),
              lat: pLat,
              lng: pLng,
              formattedAddress: String(data.formattedAddress || ''),
              streetName: String(data.streetName || ''),
              normalizedStreet: String(data.normalizedStreet || ''),
              primaryPhotoUrl: String(data.primaryPhotoUrl || ''),
              primaryMediaId: String(data.primaryMediaId || ''),
              status: String(data.status || 'accepted'),
              severityLabel: String(data.severityLabel || 'unclassified'),
              evidenceCount: Number(data.evidenceCount || 1),
              updatedAtMs: updatedAt ? updatedAt.toMillis() : undefined,
            },
          });
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((a, b) => b.confidence - a.confidence || a.distanceMeters - b.distanceMeters)
        .slice(0, 5);

      res.json({
        searchRadiusMeters: 25,
        candidates,
      });
    } catch (err) {
      res.status(500).json({
        error: 'Failed to search nearby pothole candidates.',
        detail: err instanceof Error ? err.message : 'Query failure',
      });
    }
  });

  app.post('/api/potholes/analyze', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const mediaId = typeof req.body?.mediaId === 'string' ? req.body.mediaId.trim() : '';
    const candidateMediaId =
      typeof req.body?.candidateMediaId === 'string' ? req.body.candidateMediaId.trim() : '';
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 240) : undefined;

    if (!SAFE_ID_REGEX.test(mediaId)) {
      res.status(400).json({ error: 'Invalid mediaId.' });
      return;
    }

    try {
      const media = await fetchMediaViaAdminSdk(mediaId);
      if (!media) {
        res.status(404).json({ error: 'Uploaded media object not found.' });
        return;
      }
      if (media.ownerId && media.ownerId !== decoded.uid) {
        res.status(403).json({ error: 'You do not own this uploaded media object.' });
        return;
      }

      let candidateMedia: MediaPayload | null = null;
      if (candidateMediaId && SAFE_ID_REGEX.test(candidateMediaId)) {
        candidateMedia = await fetchMediaViaAdminSdk(candidateMediaId).catch(() => null);
      }

      const analysis = await analyzePotholeImageWithGemini({
        mediaBuffer: media.buffer,
        mimeType: media.contentType,
        candidateBuffer: candidateMedia?.buffer ?? null,
        candidateMimeType: candidateMedia?.contentType ?? null,
        notes,
      });

      res.json(analysis);
    } catch (err) {
      res.json({
        available: false,
        status: 'unavailable',
        model: getConfiguredGeminiModel(),
        isRoadDefect: true,
        severityLabel: 'unclassified',
        confidence: 0,
        summary: 'Optional image analysis unavailable; capture continues normally.',
        error: err instanceof Error ? err.message : 'Analysis error',
      });
    }
  });

  app.post('/api/potholes/submit', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    const body = req.body ?? {};
    const submissionId =
      typeof body.submissionId === 'string' && SAFE_ID_REGEX.test(body.submissionId)
        ? body.submissionId
        : `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() : '';
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const coordinateSource =
      typeof body.coordinateSource === 'string' ? body.coordinateSource : '';
    const accuracyMeters =
      typeof body.accuracyMeters === 'number' && Number.isFinite(body.accuracyMeters)
        ? Math.max(0, Math.round(body.accuracyMeters))
        : undefined;
    const actionType =
      typeof body.actionType === 'string' ? body.actionType : 'new_pothole';
    const targetPotholeId =
      typeof body.targetPotholeId === 'string' && SAFE_ID_REGEX.test(body.targetPotholeId)
        ? body.targetPotholeId
        : '';
    const candidatePotholeIds = Array.isArray(body.candidatePotholeIds)
      ? body.candidatePotholeIds
          .filter((id: unknown): id is string => typeof id === 'string' && SAFE_ID_REGEX.test(id))
          .slice(0, 5)
      : [];

    const formattedAddress = String(body.formattedAddress || `${lat.toFixed(5)}, ${lng.toFixed(5)}, Atlanta, GA`)
      .trim()
      .slice(0, 256);
    const streetName = String(body.streetName || formattedAddress.split(',')[0] || 'Unverified Street')
      .trim()
      .slice(0, 128);
    const normalizedStreet = normalizeStreetName(streetName) || 'unverified street';
    const neighborhood = typeof body.neighborhood === 'string' ? body.neighborhood.trim().slice(0, 128) : '';
    const city = typeof body.city === 'string' && body.city.trim() ? body.city.trim().slice(0, 64) : 'Atlanta';
    const state = typeof body.state === 'string' && body.state.trim() ? body.state.trim().slice(0, 32) : 'GA';
    const postalCode = typeof body.postalCode === 'string' ? body.postalCode.trim().slice(0, 20) : '';
    const placeId = typeof body.placeId === 'string' ? body.placeId.trim().slice(0, 128) : '';
    const jurisdiction = classifyJurisdiction(streetName, formattedAddress, city);
    const locationUserCorrected = Boolean(body.locationUserCorrected);
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 400) : '';
    const duplicateConfidence = Number.isFinite(Number(body.duplicateConfidence))
      ? Math.min(1, Math.max(0, Number(body.duplicateConfidence)))
      : 0;

    const aiStatus =
      body.aiClassificationStatus === 'completed' || body.aiClassificationStatus === 'unavailable'
        ? body.aiClassificationStatus
        : 'skipped';
    const aiSeverityLabel = ALLOWED_SEVERITIES.has(String(body.aiSeverityLabel))
      ? String(body.aiSeverityLabel)
      : 'unclassified';
    const aiIsRoadDefect = typeof body.aiIsRoadDefect === 'boolean' ? body.aiIsRoadDefect : true;
    const aiSummary = typeof body.aiSummary === 'string' ? body.aiSummary.trim().slice(0, 300) : '';

    if (!SAFE_ID_REGEX.test(mediaId)) {
      res.status(400).json({ error: 'Valid mediaId is required.' });
      return;
    }
    if (!isValidCoordinatePair(lat, lng)) {
      res.status(400).json({ error: 'Valid latitude and longitude coordinates are required.' });
      return;
    }
    if (!ALLOWED_COORD_SOURCES.has(coordinateSource)) {
      res.status(400).json({ error: 'Invalid coordinateSource.' });
      return;
    }
    if (!['new_pothole', 'add_evidence', 'provisional_review'].includes(actionType)) {
      res.status(400).json({ error: 'Invalid submission actionType.' });
      return;
    }
    if (actionType === 'add_evidence' && !targetPotholeId) {
      res.status(400).json({ error: 'targetPotholeId is required when adding evidence.' });
      return;
    }

    try {
      const txResult = await serverDb.runTransaction(async (tx) => {
        const subRef = serverDb.collection('submissions').doc(submissionId);
        const existingSub = await tx.get(subRef);
        if (existingSub.exists) {
          const existingData = existingSub.data()!;
          return {
            idempotent: true,
            submissionId,
            potholeId: existingData.potholeId,
            duplicateStatus: existingData.duplicateStatus,
          };
        }

        const mediaRef = serverDb.collection('mediaObjects').doc(mediaId);
        const mediaSnap = await tx.get(mediaRef);
        if (!mediaSnap.exists) {
          throw new Error('Uploaded photo does not exist in /mediaObjects.');
        }
        if (mediaSnap.data()?.ownerId !== decoded.uid) {
          throw new Error('Media object ownership mismatch.');
        }

        const userRef = serverDb.collection('users').doc(decoded.uid);
        const userSnap = await tx.get(userRef);
        if (!userSnap.exists) {
          throw new Error('Contributor profile missing. Please sign out and sign back in.');
        }
        const userData = userSnap.data()!;
        const username = String(userData.username || 'atlanta_user').slice(0, 32);
        const displayName = String(userData.displayName || 'Contributor').slice(0, 64);

        const photoUrl = `/api/media/${mediaId}`;

        if (actionType === 'add_evidence') {
          const targetRef = serverDb.collection('potholes').doc(targetPotholeId);
          const targetSnap = await tx.get(targetRef);
          if (!targetSnap.exists || targetSnap.data()?.status === 'rejected') {
            throw new Error('Target canonical pothole record was not found.');
          }

          // Anti-farming guard: check recent evidence submissions by this user on the same pothole
          const priorEvidenceSnap = await tx.get(
            serverDb
              .collection('submissions')
              .where('userId', '==', decoded.uid)
              .where('potholeId', '==', targetPotholeId)
              .limit(5)
          );
          if (priorEvidenceSnap.size >= 2) {
            throw new Error('Evidence limit reached: you can attach up to 2 evidence photos per pothole.');
          }

          tx.set(subRef, {
            submissionId,
            userId: decoded.uid,
            username,
            displayName,
            potholeId: targetPotholeId,
            candidatePotholeIds: [targetPotholeId],
            actionType: 'add_evidence',
            duplicateStatus: 'evidence_added',
            duplicateConfidence,
            mediaId,
            photoUrl,
            lat,
            lng,
            coordinateSource,
            ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
            formattedAddress,
            streetName,
            normalizedStreet,
            locationUserCorrected,
            ...(notes ? { notes } : {}),
            aiClassificationStatus: aiStatus,
            aiIsRoadDefect,
            aiSeverityLabel,
            ...(aiSummary ? { aiSummary } : {}),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Increment ONLY evidence counts — NEVER distinctPotholeCount!
          tx.update(targetRef, {
            evidenceCount: FieldValue.increment(1),
            submissionCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });

          tx.update(userRef, {
            evidenceCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });

          return {
            idempotent: false,
            submissionId,
            potholeId: targetPotholeId,
            duplicateStatus: 'evidence_added',
            username,
            displayName,
          };
        }

        // Either 'new_pothole' or 'provisional_review'
        const isProvisional = actionType === 'provisional_review';
        const potholeId = `pot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const potholeRef = serverDb.collection('potholes').doc(potholeId);

        tx.set(potholeRef, {
          potholeId,
          lat,
          lng,
          coordinateSource,
          ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
          formattedAddress,
          streetName,
          normalizedStreet,
          ...(neighborhood ? { neighborhood } : {}),
          city,
          state,
          ...(postalCode ? { postalCode } : {}),
          ...(placeId ? { placeId } : {}),
          jurisdiction,
          locationUserCorrected,
          status: isProvisional ? 'provisional' : 'accepted',
          verificationStatus: isProvisional ? 'needs_review' : 'accepted',
          severityLabel: aiSeverityLabel,
          primaryContributorUid: decoded.uid,
          primaryContributorUsername: username,
          primaryContributorDisplayName: displayName,
          primaryPhotoUrl: photoUrl,
          primaryMediaId: mediaId,
          evidenceCount: 1,
          submissionCount: 1,
          ...(aiSummary ? { aiReviewSummary: aiSummary } : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(subRef, {
          submissionId,
          userId: decoded.uid,
          username,
          displayName,
          potholeId,
          candidatePotholeIds,
          actionType,
          duplicateStatus: isProvisional ? 'pending_review' : 'distinct',
          duplicateConfidence,
          mediaId,
          photoUrl,
          lat,
          lng,
          coordinateSource,
          ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
          formattedAddress,
          streetName,
          normalizedStreet,
          locationUserCorrected,
          ...(notes ? { notes } : {}),
          aiClassificationStatus: aiStatus,
          aiIsRoadDefect,
          aiSeverityLabel,
          ...(aiSummary ? { aiSummary } : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        // Provisional submissions awaiting duplicate review NEVER inflate distinctPotholeCount
        if (!isProvisional) {
          tx.update(userRef, {
            distinctPotholeCount: FieldValue.increment(1),
            evidenceCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        return {
          idempotent: false,
          submissionId,
          potholeId,
          duplicateStatus: isProvisional ? 'pending_review' : 'distinct',
          username,
          displayName,
        };
      });

      let segmentResult: {
        segmentId: string;
        cycleNumber: number;
        currentCycleDistinctCount: number;
        reportId: string | null;
        reportCreated: boolean;
      } | null = null;

      if (!txResult.idempotent && txResult.duplicateStatus !== 'pending_review') {
        const isEvidence = txResult.duplicateStatus === 'evidence_added';
        if (!isEvidence) {
          segmentResult = await evaluateSegmentMembershipAndThreshold(
            serverDb,
            String(txResult.potholeId)
          ).catch((err) => {
            console.warn('Non-fatal segment evaluation failure:', err);
            return null;
          });
        }
        await recordContributionSocialImpact(serverDb, {
          uid: decoded.uid,
          username: String((txResult as { username?: string }).username || 'atlanta_user'),
          displayName: String((txResult as { displayName?: string }).displayName || 'Contributor'),
          potholeId: String(txResult.potholeId),
          streetName,
          neighborhood,
          distinctDelta: isEvidence ? 0 : 1,
          evidenceDelta: 1,
          eventType: isEvidence ? 'evidence_added' : 'new_pothole',
        }).catch((err) => {
          console.warn('Non-fatal social impact update failure:', err);
        });
      }

      res.status(201).json({
        ok: true,
        idempotent: txResult.idempotent,
        submissionId: txResult.submissionId,
        potholeId: txResult.potholeId,
        duplicateStatus: txResult.duplicateStatus,
        ...(segmentResult ? { segment: segmentResult } : {}),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to submit pothole record.',
      });
    }
  });

  app.post('/api/submissions/:submissionId/resolve', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const { submissionId } = req.params;
    if (!SAFE_ID_REGEX.test(submissionId)) {
      res.status(400).json({ error: 'Invalid submissionId.' });
      return;
    }

    const resolution = req.body?.resolution;
    const targetPotholeId =
      typeof req.body?.targetPotholeId === 'string' && SAFE_ID_REGEX.test(req.body.targetPotholeId)
        ? req.body.targetPotholeId
        : '';

    if (resolution !== 'confirm_distinct' && resolution !== 'merge_evidence') {
      res.status(400).json({ error: 'Resolution must be confirm_distinct or merge_evidence.' });
      return;
    }
    if (resolution === 'merge_evidence' && !targetPotholeId) {
      res.status(400).json({ error: 'targetPotholeId is required to merge as evidence.' });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const adminDoc = await serverDb.collection('admins').doc(decoded.uid).get();
      const isCallerAdmin = Boolean(decoded.admin || adminDoc.exists);

      const outcome = await serverDb.runTransaction(async (tx) => {
        const subRef = serverDb.collection('submissions').doc(submissionId);
        const subSnap = await tx.get(subRef);
        if (!subSnap.exists) throw new Error('Submission not found.');

        const subData = subSnap.data()!;
        if (subData.userId !== decoded.uid && !isCallerAdmin) {
          throw new Error('You are not authorized to resolve this duplicate review.');
        }
        if (subData.duplicateStatus !== 'pending_review') {
          return {
            alreadyResolved: true,
            duplicateStatus: subData.duplicateStatus,
            potholeId: subData.potholeId,
          };
        }

        const provisionalPotholeRef = serverDb.collection('potholes').doc(String(subData.potholeId));
        const contributorRef = serverDb.collection('users').doc(String(subData.userId));

        if (resolution === 'confirm_distinct') {
          tx.update(provisionalPotholeRef, {
            status: 'accepted',
            verificationStatus: 'accepted',
            updatedAt: FieldValue.serverTimestamp(),
          });
          tx.update(subRef, {
            duplicateStatus: 'distinct',
            updatedAt: FieldValue.serverTimestamp(),
          });
          tx.update(contributorRef, {
            distinctPotholeCount: FieldValue.increment(1),
            evidenceCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return {
            alreadyResolved: false,
            duplicateStatus: 'distinct',
            potholeId: subData.potholeId,
            contributorUid: String(subData.userId),
            username: String(subData.username || 'atlanta_user'),
            displayName: String(subData.displayName || 'Contributor'),
            streetName: String(subData.streetName || 'Atlanta Street'),
          };
        }

        // merge_evidence
        const targetRef = serverDb.collection('potholes').doc(targetPotholeId);
        const targetSnap = await tx.get(targetRef);
        if (!targetSnap.exists || targetSnap.data()?.status === 'rejected') {
          throw new Error('Target pothole not found for evidence merge.');
        }

        tx.update(provisionalPotholeRef, {
          status: 'rejected',
          verificationStatus: 'rejected',
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(targetRef, {
          evidenceCount: FieldValue.increment(1),
          submissionCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(subRef, {
          potholeId: targetPotholeId,
          duplicateStatus: 'evidence_added',
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.update(contributorRef, {
          evidenceCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          alreadyResolved: false,
          duplicateStatus: 'evidence_added',
          potholeId: targetPotholeId,
          contributorUid: String(subData.userId),
          username: String(subData.username || 'atlanta_user'),
          displayName: String(subData.displayName || 'Contributor'),
          streetName: String(subData.streetName || 'Atlanta Street'),
        };
      });

      if (!outcome.alreadyResolved) {
        const isDistinct = outcome.duplicateStatus === 'distinct';
        if (isDistinct) {
          await evaluateSegmentMembershipAndThreshold(
            serverDb,
            String(outcome.potholeId)
          ).catch((err) => {
            console.warn('Non-fatal segment evaluation on resolve:', err);
          });
        }
        const contribUid = String(
          (outcome as { contributorUid?: string }).contributorUid || decoded.uid
        );
        await recordContributionSocialImpact(serverDb, {
          uid: contribUid,
          username: String((outcome as { username?: string }).username || 'atlanta_user'),
          displayName: String((outcome as { displayName?: string }).displayName || 'Contributor'),
          potholeId: String(outcome.potholeId),
          streetName: String((outcome as { streetName?: string }).streetName || 'Atlanta Street'),
          distinctDelta: isDistinct ? 1 : 0,
          evidenceDelta: 1,
          eventType: isDistinct ? 'new_pothole' : 'evidence_added',
        }).catch((err) => {
          console.warn('Non-fatal social impact resolution update failure:', err);
        });
      }

      res.json({
        ok: true,
        alreadyResolved: outcome.alreadyResolved,
        duplicateStatus: outcome.duplicateStatus,
        potholeId: outcome.potholeId,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to resolve submission.',
      });
    }
  });

  app.get('/api/potholes/:potholeId/submissions', async (req, res) => {
    const { potholeId } = req.params;
    if (!SAFE_ID_REGEX.test(potholeId)) {
      res.status(400).json({ error: 'Invalid potholeId.' });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const snap = await serverDb
        .collection('submissions')
        .where('potholeId', '==', potholeId)
        .limit(30)
        .get();

      const items = snap.docs
        .map((d) => d.data())
        .filter((s) => s.duplicateStatus === 'distinct' || s.duplicateStatus === 'evidence_added')
        .sort((a, b) => {
          const aMs = (a.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          const bMs = (b.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          return bMs - aMs;
        });

      res.json({ items });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load pothole evidence records.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  // --- Phase 4: per-user official ATL311 / GDOT case tracking ---
  // Records a user's effort to get THEIR captured pothole fixed through an
  // official channel. All writes go through the Admin SDK here (Firestore rules
  // deny client writes). The official agency case number lives only in
  // externalCaseRef and is set solely from a value the user manually confirms —
  // never fabricated, never auto-advanced.
  app.post('/api/cases/log', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    const body = req.body ?? {};
    const potholeId = typeof body.potholeId === 'string' ? body.potholeId.trim() : '';
    if (!SAFE_ID_REGEX.test(potholeId)) {
      res.status(400).json({ error: 'Valid potholeId is required.' });
      return;
    }

    const ALLOWED_CHANNELS = new Set(['atl311', 'gdot', 'email', 'other']);
    const ALLOWED_METHODS = new Set(['official_portal', 'phone', 'email']);
    const ALLOWED_CASE_STATUSES = new Set([
      'drafted',
      'submitted_unconfirmed',
      'case_logged',
      'acknowledged',
      'resolved',
      'reopened',
    ]);

    const channel = ALLOWED_CHANNELS.has(String(body.channel)) ? String(body.channel) : '';
    const reportMethod = ALLOWED_METHODS.has(String(body.reportMethod))
      ? String(body.reportMethod)
      : '';
    const externalCaseRef =
      typeof body.externalCaseRef === 'string'
        ? body.externalCaseRef.replace(/[^\w\s#/\-.]/g, '').trim().slice(0, 64)
        : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 400) : '';
    let requestedStatus = ALLOWED_CASE_STATUSES.has(String(body.status))
      ? String(body.status)
      : '';
    // A confirmed external case number always implies at least "case_logged".
    if (externalCaseRef && (!requestedStatus || requestedStatus === 'drafted' || requestedStatus === 'submitted_unconfirmed')) {
      requestedStatus = 'case_logged';
    }

    try {
      const potholeSnap = await serverDb.collection('potholes').doc(potholeId).get();
      if (!potholeSnap.exists) {
        res.status(404).json({ error: 'Pothole record not found.' });
        return;
      }
      const pothole = potholeSnap.data()!;
      if (pothole.primaryContributorUid !== decoded.uid) {
        res.status(403).json({
          error: 'You can only track official cases for potholes you reported.',
        });
        return;
      }

      const existingSnap = await serverDb
        .collection('potholeCases')
        .where('userId', '==', decoded.uid)
        .where('potholeId', '==', potholeId)
        .limit(1)
        .get();

      const nowMillis = Date.now();
      const event = {
        type: externalCaseRef
          ? 'case_ref_logged'
          : requestedStatus === 'submitted_unconfirmed'
            ? 'marked_submitted'
            : 'draft_saved',
        ...(notes ? { note: notes } : {}),
        ...(externalCaseRef ? { externalCaseRef } : {}),
        atMillis: nowMillis,
      };

      if (existingSnap.empty) {
        const caseId = `cas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const status = requestedStatus || 'drafted';
        const caseDoc: Record<string, unknown> = {
          caseId,
          userId: decoded.uid,
          potholeId,
          streetName: String(pothole.streetName || 'Unverified Street'),
          formattedAddress: String(pothole.formattedAddress || ''),
          lat: Number(pothole.lat),
          lng: Number(pothole.lng),
          jurisdiction: String(pothole.jurisdiction || 'unknown'),
          channel: channel || (pothole.jurisdiction === 'gdot' ? 'gdot' : 'atl311'),
          ...(reportMethod ? { reportMethod } : {}),
          status,
          ...(externalCaseRef ? { externalCaseRef } : {}),
          ...(pothole.primaryPhotoUrl ? { primaryPhotoUrl: String(pothole.primaryPhotoUrl) } : {}),
          ...(pothole.primaryMediaId ? { primaryMediaId: String(pothole.primaryMediaId) } : {}),
          ...(notes ? { notes } : {}),
          events: [event],
          ...(status === 'submitted_unconfirmed' || status === 'case_logged'
            ? { submittedAt: FieldValue.serverTimestamp() }
            : {}),
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        };
        await serverDb.collection('potholeCases').doc(caseId).set(caseDoc);
        res.status(201).json({ ok: true, caseId });
        return;
      }

      const existingDoc = existingSnap.docs[0];
      const existing = existingDoc.data();
      const prevStatus = String(existing.status || 'drafted');
      // Never regress a case to an earlier stage via a stray request.
      const STAGE: Record<string, number> = {
        drafted: 0,
        submitted_unconfirmed: 1,
        case_logged: 2,
        acknowledged: 3,
        resolved: 4,
        reopened: 1,
      };
      const nextStatus =
        requestedStatus && STAGE[requestedStatus] >= STAGE[prevStatus] ? requestedStatus : prevStatus;

      const update: Record<string, unknown> = {
        status: nextStatus,
        events: FieldValue.arrayUnion(event),
        updatedAt: FieldValue.serverTimestamp(),
        ...(channel ? { channel } : {}),
        ...(reportMethod ? { reportMethod } : {}),
        ...(externalCaseRef ? { externalCaseRef } : {}),
        ...(notes ? { notes } : {}),
      };
      if (
        !existing.submittedAt &&
        (nextStatus === 'submitted_unconfirmed' || nextStatus === 'case_logged')
      ) {
        update.submittedAt = FieldValue.serverTimestamp();
      }
      await existingDoc.ref.update(update);
      res.json({ ok: true, caseId: String(existing.caseId || existingDoc.id) });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to log official case.',
        detail: err instanceof Error ? err.message : 'Case write failed',
      });
    }
  });

  app.get('/api/cases/mine', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const snap = await serverDb
        .collection('potholeCases')
        .where('userId', '==', decoded.uid)
        .limit(100)
        .get();

      const cases = snap.docs.map((d) => d.data());

      // Enrich with the live pothole status so "My Cases" reflects reality
      // (e.g. an admin-confirmed repair) without duplicating it onto the case.
      const potholeIds = Array.from(
        new Set(cases.map((c) => String(c.potholeId)).filter(Boolean))
      );
      const statusByPothole = new Map<string, string>();
      if (potholeIds.length > 0) {
        const refs = potholeIds.map((id) => serverDb.collection('potholes').doc(id));
        const potholeSnaps = await serverDb.getAll(...refs);
        for (const ps of potholeSnaps) {
          if (ps.exists) statusByPothole.set(ps.id, String(ps.data()?.status || ''));
        }
      }

      const enriched = cases
        .map((c): Record<string, unknown> => ({
          ...c,
          potholeStatus: statusByPothole.get(String(c.potholeId)) || undefined,
        }))
        .sort((a, b) => {
          const aMs = (a.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          const bMs = (b.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          return bMs - aMs;
        });

      res.json({ cases: enriched });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load your cases.',
        detail: err instanceof Error ? err.message : 'Case query failed',
      });
    }
  });

  app.get('/api/media/:mediaId', async (req, res) => {
    const { mediaId } = req.params;
    if (!SAFE_ID_REGEX.test(mediaId)) {
      res.status(400).json({ error: 'Invalid media ID format' });
      return;
    }

    try {
      let media: MediaPayload | null = null;
      if (adminFirestoreReady) {
        try {
          media = await fetchMediaViaAdminSdk(mediaId);
        } catch {
          media = await fetchMediaViaFirestoreRest(mediaId);
        }
      } else {
        media = await fetchMediaViaFirestoreRest(mediaId);
      }

      if (!media) {
        res.status(404).json({ error: 'Media object not found' });
        return;
      }

      res.setHeader('Content-Type', media.contentType);
      res.setHeader('Content-Length', String(media.buffer.length));
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(media.buffer);
    } catch (err) {
      res.status(502).json({
        error: 'Unable to stream media object',
        detail: err instanceof Error ? err.message : 'Unexpected server error',
      });
    }
  });

  // Phase 3 Social, Friends, Leaderboards, Achievements & Notifications Routes
  app.post('/api/profile/sync', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      await syncUserLeaderboardProfile(serverDb, decoded.uid);
      await evaluateUserAchievements(serverDb, decoded.uid, false);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to sync social profile.',
        detail: err instanceof Error ? err.message : 'Sync failed',
      });
    }
  });

  app.get('/api/friends/search', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    if (rawQuery.length < 2) {
      res.json({ users: [] });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const [usersSnap, friendshipsSnap] = await Promise.all([
        serverDb.collection('users').limit(120).get(),
        serverDb
          .collection('friendships')
          .where('participantUids', 'array-contains', decoded.uid)
          .limit(100)
          .get(),
      ]);

      const relationMap = new Map<string, { friendshipId: string; status: string; requesterUid: string }>();
      for (const fDoc of friendshipsSnap.docs) {
        const f = fDoc.data();
        const otherUid =
          f.requesterUid === decoded.uid ? String(f.recipientUid) : String(f.requesterUid);
        relationMap.set(otherUid, {
          friendshipId: String(f.friendshipId || fDoc.id),
          status: String(f.status || 'pending'),
          requesterUid: String(f.requesterUid),
        });
      }

      const matches = usersSnap.docs
        .map((d) => d.data())
        .filter((u) => {
          if (u.uid === decoded.uid) return false;
          const uname = String(u.username || '').toLowerCase();
          const dname = String(u.displayName || '').toLowerCase();
          return uname.includes(rawQuery) || dname.includes(rawQuery);
        })
        .slice(0, 12)
        .map((u) => {
          const rel = relationMap.get(String(u.uid));
          return {
            uid: String(u.uid),
            username: String(u.username || ''),
            displayName: String(u.displayName || ''),
            photoURL: typeof u.photoURL === 'string' ? u.photoURL : undefined,
            distinctPotholeCount: Number(u.distinctPotholeCount || 0),
            evidenceCount: Number(u.evidenceCount || 0),
            homeNeighborhood:
              u.shareNeighborhood && typeof u.homeNeighborhood === 'string'
                ? u.homeNeighborhood
                : undefined,
            friendshipStatus: rel ? rel.status : 'none',
            friendshipId: rel?.friendshipId,
            direction: rel
              ? rel.requesterUid === decoded.uid
                ? 'outgoing'
                : 'incoming'
              : 'none',
          };
        });

      res.json({ users: matches });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to search contributors.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.get('/api/friends', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const friendshipsSnap = await serverDb
        .collection('friendships')
        .where('participantUids', 'array-contains', decoded.uid)
        .limit(100)
        .get();

      const records = friendshipsSnap.docs
        .map((d) => d.data())
        .filter((f) => f.status === 'accepted' || f.status === 'pending');

      const otherUids = Array.from(
        new Set(
          records.map((f) =>
            f.requesterUid === decoded.uid ? String(f.recipientUid) : String(f.requesterUid)
          )
        )
      );

      const userProfiles = new Map<string, FirebaseFirestore.DocumentData>();
      if (otherUids.length > 0) {
        const userRefs = otherUids.map((id) => serverDb.collection('users').doc(id));
        const userSnaps = await serverDb.getAll(...userRefs);
        for (const snap of userSnaps) {
          if (snap.exists) {
            userProfiles.set(snap.id, snap.data()!);
          }
        }
      }

      const items = records.map((f) => {
        const isRequester = f.requesterUid === decoded.uid;
        const otherUid = isRequester ? String(f.recipientUid) : String(f.requesterUid);
        const profile = userProfiles.get(otherUid);
        return {
          friendshipId: String(f.friendshipId),
          status: String(f.status),
          direction: isRequester ? 'outgoing' : 'incoming',
          otherUid,
          username: String(profile?.username || 'atlanta_user'),
          displayName: String(profile?.displayName || 'Contributor'),
          photoURL: typeof profile?.photoURL === 'string' ? profile.photoURL : undefined,
          distinctPotholeCount: Number(profile?.distinctPotholeCount || 0),
          evidenceCount: Number(profile?.evidenceCount || 0),
          homeNeighborhood:
            profile?.shareNeighborhood && typeof profile?.homeNeighborhood === 'string'
              ? profile.homeNeighborhood
              : undefined,
        };
      });

      res.json({ items });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load friendships.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.post('/api/friends/request', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const targetUid = typeof req.body?.targetUid === 'string' ? req.body.targetUid.trim() : '';
    if (!SAFE_ID_REGEX.test(targetUid) || targetUid === decoded.uid) {
      res.status(400).json({ error: 'Valid target contributor UID is required.' });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const friendshipId = makeFriendshipId(decoded.uid, targetUid);
      const outcome = await serverDb.runTransaction(async (tx) => {
        const [senderSnap, targetSnap, friendshipSnap] = await Promise.all([
          tx.get(serverDb.collection('users').doc(decoded.uid)),
          tx.get(serverDb.collection('users').doc(targetUid)),
          tx.get(serverDb.collection('friendships').doc(friendshipId)),
        ]);

        if (!senderSnap.exists || !targetSnap.exists) {
          throw new Error('Contributor profile not found.');
        }

        if (friendshipSnap.exists) {
          const existing = friendshipSnap.data()!;
          if (existing.status === 'accepted') {
            return { status: 'accepted', alreadyExists: true };
          }
          if (existing.status === 'pending') {
            if (existing.requesterUid === targetUid) {
              // Mutual request auto-accepts cleanly
              tx.update(friendshipSnap.ref, {
                status: 'accepted',
                updatedAt: FieldValue.serverTimestamp(),
              });
              return {
                status: 'accepted',
                autoAccepted: true,
                senderUsername: String(senderSnap.data()?.username || 'atlanta_user'),
              };
            }
            return { status: 'pending', alreadyExists: true };
          }
        }

        tx.set(serverDb.collection('friendships').doc(friendshipId), {
          friendshipId,
          requesterUid: decoded.uid,
          recipientUid: targetUid,
          participantUids: [decoded.uid, targetUid].sort(),
          status: 'pending',
          createdAt: friendshipSnap.exists
            ? friendshipSnap.data()!.createdAt
            : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          status: 'pending',
          alreadyExists: false,
          senderUsername: String(senderSnap.data()?.username || 'atlanta_user'),
        };
      });

      if (!outcome.alreadyExists) {
        if (outcome.status === 'accepted') {
          await createNotification(serverDb, {
            uid: targetUid,
            type: 'friend_accepted',
            title: 'Friend Request Accepted',
            body: `@${outcome.senderUsername} is now connected with you on PatchUp.`,
            relatedId: friendshipId,
          });
        } else {
          await createNotification(serverDb, {
            uid: targetUid,
            type: 'friend_request',
            title: 'New Friend Request',
            body: `@${outcome.senderUsername} sent you a friend request on PatchUp.`,
            relatedId: friendshipId,
          });
        }
      }

      res.status(201).json({ ok: true, friendshipId, status: outcome.status });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to send friend request.',
      });
    }
  });

  app.post('/api/friends/respond', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const friendshipId =
      typeof req.body?.friendshipId === 'string' ? req.body.friendshipId.trim() : '';
    const action = req.body?.action;

    if (!SAFE_ID_REGEX.test(friendshipId)) {
      res.status(400).json({ error: 'Invalid friendshipId.' });
      return;
    }
    if (action !== 'accept' && action !== 'decline' && action !== 'remove') {
      res.status(400).json({ error: 'Action must be accept, decline, or remove.' });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const result = await serverDb.runTransaction(async (tx) => {
        const ref = serverDb.collection('friendships').doc(friendshipId);
        const snap = await tx.get(ref);
        if (!snap.exists) throw new Error('Friendship record not found.');

        const data = snap.data()!;
        const isRequester = data.requesterUid === decoded.uid;
        const isRecipient = data.recipientUid === decoded.uid;
        if (!isRequester && !isRecipient) {
          throw new Error('You do not have permission to modify this friendship.');
        }

        if (action === 'accept') {
          if (!isRecipient) {
            throw new Error('Only the recipient can accept a pending friend request.');
          }
          if (data.status === 'accepted') {
            return { status: 'accepted', notifyUid: null };
          }
          const recipientSnap = await tx.get(serverDb.collection('users').doc(decoded.uid));
          tx.update(ref, {
            status: 'accepted',
            updatedAt: FieldValue.serverTimestamp(),
          });
          return {
            status: 'accepted',
            notifyUid: String(data.requesterUid),
            recipientUsername: String(recipientSnap.data()?.username || 'atlanta_user'),
          };
        }

        if (action === 'decline') {
          if (!isRecipient) {
            throw new Error('Only the recipient can decline a friend request.');
          }
          tx.update(ref, {
            status: 'declined',
            updatedAt: FieldValue.serverTimestamp(),
          });
          return { status: 'declined', notifyUid: null };
        }

        // action === 'remove'
        tx.delete(ref);
        return { status: 'removed', notifyUid: null };
      });

      if (result.notifyUid) {
        await createNotification(serverDb, {
          uid: result.notifyUid,
          type: 'friend_accepted',
          title: 'Friend Request Accepted',
          body: `@${result.recipientUsername} accepted your PatchUp friend request.`,
          relatedId: friendshipId,
        });
      }

      res.json({ ok: true, friendshipId, status: result.status });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update friendship.',
      });
    }
  });

  app.get('/api/leaderboard', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const period =
      req.query.period === 'weekly' ||
      req.query.period === 'monthly' ||
      req.query.period === 'neighborhood'
        ? req.query.period
        : 'overall';
    const neighborhoodFilter =
      typeof req.query.neighborhood === 'string' ? req.query.neighborhood.trim().toLowerCase() : '';

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      // Ensure caller's profile is mirrored cleanly in leaderboardStats
      await syncUserLeaderboardProfile(serverDb, decoded.uid);

      const snap = await serverDb
        .collection('leaderboardStats')
        .where('showOnLeaderboard', '==', true)
        .limit(100)
        .get();

      const weekKey = getCurrentWeekKey();
      const monthKey = getCurrentMonthKey();

      const neighborhoodSet = new Set<string>();
      const entries = snap.docs
        .map((d) => {
          const s = d.data();
          const nh =
            s.shareNeighborhood && typeof s.neighborhood === 'string'
              ? s.neighborhood.trim()
              : '';
          if (nh) neighborhoodSet.add(nh);

          const weeklyDistinct = s.weekKey === weekKey ? Number(s.weeklyDistinctCount || 0) : 0;
          const weeklyEvidence = s.weekKey === weekKey ? Number(s.weeklyEvidenceCount || 0) : 0;
          const monthlyDistinct =
            s.monthKey === monthKey ? Number(s.monthlyDistinctCount || 0) : 0;
          const monthlyEvidence =
            s.monthKey === monthKey ? Number(s.monthlyEvidenceCount || 0) : 0;
          const overallDistinct = Number(s.overallDistinctCount || 0);
          const overallEvidence = Number(s.overallEvidenceCount || 0);

          const primaryScore =
            period === 'weekly'
              ? weeklyDistinct
              : period === 'monthly'
                ? monthlyDistinct
                : overallDistinct;
          const evidenceScore =
            period === 'weekly'
              ? weeklyEvidence
              : period === 'monthly'
                ? monthlyEvidence
                : overallEvidence;

          return {
            uid: String(s.uid),
            username: String(s.username || ''),
            displayName: String(s.displayName || ''),
            photoURL: typeof s.photoURL === 'string' ? s.photoURL : undefined,
            neighborhood: nh || undefined,
            shareNeighborhood: Boolean(s.shareNeighborhood),
            primaryScore,
            evidenceScore,
            overallDistinctCount: overallDistinct,
            overallEvidenceCount: overallEvidence,
          };
        })
        .filter((entry) => {
          if (period === 'neighborhood') {
            if (!entry.shareNeighborhood || !entry.neighborhood) return false;
            if (neighborhoodFilter && entry.neighborhood.toLowerCase() !== neighborhoodFilter) {
              return false;
            }
          }
          return true;
        })
        .sort(
          (a, b) =>
            b.primaryScore - a.primaryScore ||
            b.evidenceScore - a.evidenceScore ||
            a.username.localeCompare(b.username)
        )
        .slice(0, 30);

      res.json({
        period,
        weekKey,
        monthKey,
        neighborhoods: Array.from(neighborhoodSet).sort((a, b) => a.localeCompare(b)),
        entries,
      });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load leaderboard.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.get('/api/achievements/me', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const badges = await evaluateUserAchievements(serverDb, decoded.uid, false);
      res.json({ badges });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to evaluate achievements.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.post('/api/notifications/read', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    const notificationId =
      typeof req.body?.notificationId === 'string' ? req.body.notificationId.trim() : '';
    const markAll = Boolean(req.body?.all);

    try {
      const itemsCol = serverDb.collection('notifications').doc(decoded.uid).collection('items');
      if (markAll) {
        const unreadSnap = await itemsCol.where('read', '==', false).limit(50).get();
        if (!unreadSnap.empty) {
          const batch = serverDb.batch();
          unreadSnap.docs.forEach((d) => {
            batch.update(d.ref, { read: true, updatedAt: FieldValue.serverTimestamp() });
          });
          await batch.commit();
        }
        res.json({ ok: true, updatedCount: unreadSnap.size });
        return;
      }

      if (!SAFE_ID_REGEX.test(notificationId)) {
        res.status(400).json({ error: 'Valid notificationId or all=true is required.' });
        return;
      }

      await itemsCol.doc(notificationId).update({
        read: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
      res.json({ ok: true, notificationId });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to mark notification read.',
      });
    }
  });

  // Phase 4 Civic Segmentation, 5-Pothole Report Engine & Admin Oversight Routes
  app.post('/api/admin/bootstrap', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const email = String(decoded.email || '').trim().toLowerCase();
    const allowlisted = getAllowedAdminEmails();
    if (!email || !allowlisted.has(email)) {
      res.status(403).json({
        ok: false,
        admin: false,
        error: 'Account email is not allowlisted for PatchUp admin bootstrap.',
      });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady || !adminApp) {
      res.status(503).json({ error: 'Server Firebase Admin SDK unavailable.' });
      return;
    }

    try {
      const existingAdminSnap = await serverDb.collection('admins').doc(decoded.uid).get();
      if (!decoded.admin) {
        await getAdminAuth(adminApp).setCustomUserClaims(decoded.uid, {
          ...(decoded.admin ? {} : {}),
          admin: true,
        });
      }
      if (!existingAdminSnap.exists) {
        await serverDb.collection('admins').doc(decoded.uid).set({
          uid: decoded.uid,
          email,
          grantedAt: FieldValue.serverTimestamp(),
        });
        await writeAdminAudit(serverDb, {
          actor: { uid: decoded.uid, email },
          action: 'admin_bootstrap',
          targetType: 'admin',
          targetId: decoded.uid,
          reason: 'Verified owner allowlist bootstrap',
          afterSummary: `admin=true for ${email}`,
        });
      }

      res.json({
        ok: true,
        admin: true,
        claimUpdated: !decoded.admin,
      });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to bootstrap admin claim.',
        detail: err instanceof Error ? err.message : 'Admin error',
      });
    }
  });

  app.get('/api/segments', async (_req, res) => {
    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      await backfillAcceptedPotholeSegments(serverDb).catch(() => 0);
      const snap = await serverDb
        .collection('streetSegments')
        .where('status', '==', 'active')
        .limit(100)
        .get();

      const segments = snap.docs
        .map((d) => d.data())
        .sort(
          (a, b) =>
            Number(b.currentCycleDistinctCount || 0) - Number(a.currentCycleDistinctCount || 0) ||
            Number(b.distinctAcceptedCount || 0) - Number(a.distinctAcceptedCount || 0)
        );

      res.json({ segments });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load street segments.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.get('/api/reports', async (_req, res) => {
    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const snap = await serverDb.collection('reports').limit(60).get();
      const reports = snap.docs
        .map((d) => d.data())
        .sort((a, b) => {
          const aMs = (a.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          const bMs = (b.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          return bMs - aMs;
        });

      res.json({ reports });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load civic reports.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.get('/api/admin/overview', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const serverDb = getServerFirestore()!;
    try {
      await backfillAcceptedPotholeSegments(serverDb).catch(() => 0);

      const [segmentsSnap, reportsSnap, potholesSnap, auditSnap] = await Promise.all([
        serverDb.collection('streetSegments').where('status', '==', 'active').limit(120).get(),
        serverDb.collection('reports').limit(80).get(),
        serverDb.collection('potholes').limit(150).get(),
        serverDb.collection('adminAudit').orderBy('createdAt', 'desc').limit(30).get(),
      ]);

      const segments = segmentsSnap.docs.map((d) => d.data());
      const reports = reportsSnap.docs
        .map((d) => d.data())
        .sort((a, b) => {
          const aMs = (a.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          const bMs = (b.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          return bMs - aMs;
        });
      const potholes = potholesSnap.docs
        .map((d) => d.data())
        .sort((a, b) => {
          const aMs = (a.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          const bMs = (b.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0;
          return bMs - aMs;
        });
      const auditEvents = auditSnap.docs.map((d) => d.data());

      res.json({
        segments,
        reports,
        potholes,
        auditEvents,
      });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load admin civic oversight overview.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.post('/api/admin/potholes/:potholeId/review', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const { potholeId } = req.params;
    if (!SAFE_ID_REGEX.test(potholeId)) {
      res.status(400).json({ error: 'Invalid potholeId.' });
      return;
    }

    const body = req.body ?? {};
    const status = typeof body.status === 'string' ? body.status : undefined;
    if (
      status &&
      !['accepted', 'provisional', 'reported', 'acknowledged', 'repaired', 'rejected'].includes(
        status
      )
    ) {
      res.status(400).json({ error: 'Invalid pothole status.' });
      return;
    }

    const severityLabel = typeof body.severityLabel === 'string' ? body.severityLabel : undefined;
    if (severityLabel && !ALLOWED_SEVERITIES.has(severityLabel)) {
      res.status(400).json({ error: 'Invalid severityLabel.' });
      return;
    }

    const jurisdiction =
      body.jurisdiction === 'atldot' ||
      body.jurisdiction === 'gdot' ||
      body.jurisdiction === 'unknown'
        ? body.jurisdiction
        : undefined;

    const segmentConfidence: SegmentConfidence | undefined =
      body.segmentConfidence === 'verified' ||
      body.segmentConfidence === 'provisional' ||
      body.segmentConfidence === 'needs_review'
        ? body.segmentConfidence
        : undefined;

    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Admin pothole verification update';

    try {
      const outcome = await adminReviewPothole(getServerFirestore()!, {
        potholeId,
        status,
        severityLabel,
        streetName: typeof body.streetName === 'string' ? body.streetName : undefined,
        jurisdiction,
        segmentConfidence,
        reason,
        actor: adminCtx.actor,
      });
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to review pothole.',
      });
    }
  });

  app.post('/api/admin/segments/reassign', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const body = req.body ?? {};
    const potholeId = typeof body.potholeId === 'string' ? body.potholeId.trim() : '';
    const targetSegmentId =
      typeof body.targetSegmentId === 'string' ? body.targetSegmentId.trim() : undefined;
    if (!SAFE_ID_REGEX.test(potholeId)) {
      res.status(400).json({ error: 'Valid potholeId is required.' });
      return;
    }
    if (targetSegmentId && !SAFE_ID_REGEX.test(targetSegmentId)) {
      res.status(400).json({ error: 'Invalid targetSegmentId.' });
      return;
    }

    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Admin segment reassignment';

    try {
      const outcome = await adminReassignPotholeSegment(getServerFirestore()!, {
        potholeId,
        targetSegmentId,
        createNewCorridor: Boolean(body.createNewCorridor),
        streetName: typeof body.streetName === 'string' ? body.streetName : undefined,
        jurisdiction:
          body.jurisdiction === 'atldot' ||
          body.jurisdiction === 'gdot' ||
          body.jurisdiction === 'unknown'
            ? body.jurisdiction
            : undefined,
        confidence:
          body.confidence === 'verified' ||
          body.confidence === 'provisional' ||
          body.confidence === 'needs_review'
            ? body.confidence
            : 'verified',
        reason,
        actor: adminCtx.actor,
      });
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to reassign pothole segment.',
      });
    }
  });

  app.post('/api/admin/segments/merge', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const sourceSegmentId =
      typeof req.body?.sourceSegmentId === 'string' ? req.body.sourceSegmentId.trim() : '';
    const targetSegmentId =
      typeof req.body?.targetSegmentId === 'string' ? req.body.targetSegmentId.trim() : '';
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Admin segment merge';

    if (!SAFE_ID_REGEX.test(sourceSegmentId) || !SAFE_ID_REGEX.test(targetSegmentId)) {
      res.status(400).json({ error: 'Valid sourceSegmentId and targetSegmentId are required.' });
      return;
    }

    try {
      const outcome = await adminMergeSegments(getServerFirestore()!, {
        sourceSegmentId,
        targetSegmentId,
        reason,
        actor: adminCtx.actor,
      });
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to merge segments.',
      });
    }
  });

  app.post('/api/admin/segments/split', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const sourceSegmentId =
      typeof req.body?.sourceSegmentId === 'string' ? req.body.sourceSegmentId.trim() : '';
    const splitPotholeIds = Array.isArray(req.body?.splitPotholeIds)
      ? req.body.splitPotholeIds.filter(
          (id: unknown): id is string => typeof id === 'string' && SAFE_ID_REGEX.test(id)
        )
      : [];
    const newCorridorLabel =
      typeof req.body?.newCorridorLabel === 'string' ? req.body.newCorridorLabel : undefined;
    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Admin segment split';

    if (!SAFE_ID_REGEX.test(sourceSegmentId) || splitPotholeIds.length === 0) {
      res.status(400).json({ error: 'sourceSegmentId and splitPotholeIds are required.' });
      return;
    }

    try {
      const outcome = await adminSplitSegment(getServerFirestore()!, {
        sourceSegmentId,
        splitPotholeIds,
        newCorridorLabel,
        reason,
        actor: adminCtx.actor,
      });
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to split segment.',
      });
    }
  });

  app.post('/api/admin/reports/:reportId/status', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const { reportId } = req.params;
    if (!SAFE_ID_REGEX.test(reportId)) {
      res.status(400).json({ error: 'Invalid reportId.' });
      return;
    }

    const status = req.body?.status as ReportStatus;
    if (
      ![
        'ready_for_submission',
        'submitted',
        'acknowledged',
        'resolved',
        'unable_to_submit',
        'closed',
      ].includes(status)
    ) {
      res.status(400).json({ error: 'Invalid target report status.' });
      return;
    }

    const reason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : `Transition report to ${status}`;

    try {
      const outcome = await adminTransitionReportStatus(getServerFirestore()!, {
        reportId,
        status,
        externalReference:
          typeof req.body?.externalReference === 'string' ? req.body.externalReference : undefined,
        submissionChannel:
          typeof req.body?.submissionChannel === 'string' ? req.body.submissionChannel : undefined,
        adminReviewNotes:
          typeof req.body?.adminReviewNotes === 'string' ? req.body.adminReviewNotes : undefined,
        reason,
        actor: adminCtx.actor,
      });
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to update report status.',
      });
    }
  });

  app.post('/api/admin/reports/:reportId/sheet-export', async (req, res) => {
    const adminCtx = await requireAdmin(req, res);
    if (!adminCtx) return;

    const { reportId } = req.params;
    const spreadsheetUrl =
      typeof req.body?.spreadsheetUrl === 'string' ? req.body.spreadsheetUrl.trim() : '';
    if (!SAFE_ID_REGEX.test(reportId) || !spreadsheetUrl.startsWith('https://')) {
      res.status(400).json({ error: 'Valid reportId and HTTPS spreadsheetUrl are required.' });
      return;
    }

    const serverDb = getServerFirestore()!;
    try {
      const reportRef = serverDb.collection('reports').doc(reportId);
      const snap = await reportRef.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'Civic report not found.' });
        return;
      }
      await reportRef.update({
        googleSheetUrl: spreadsheetUrl.slice(0, 512),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await writeAdminAudit(serverDb, {
        actor: adminCtx.actor,
        action: 'sheet_export_recorded',
        targetType: 'report',
        targetId: reportId,
        reason: 'Admin exported consolidated report packet to Google Sheets',
        afterSummary: spreadsheetUrl.slice(0, 300),
      });
      res.json({ ok: true, reportId, googleSheetUrl: spreadsheetUrl });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to record Google Sheet export.',
      });
    }
  });

  // Phase 5 Entertainment Minigame Routes (strictly isolated from civic metrics)
  app.get('/api/games/stats', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, false);
    if (!decoded) return;

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const stats = await getUserGameStats(serverDb, decoded.uid);
      res.json({ ok: true, stats });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load minigame statistics.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.post('/api/games/score', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    const validation = validateGameScorePayload({
      gameId: req.body?.gameId,
      score: req.body?.score,
      durationMs: req.body?.durationMs,
    });
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) {
      res.status(503).json({ error: 'Server Firestore database unavailable.' });
      return;
    }

    try {
      const saved = await recordValidatedGameScore(serverDb, {
        uid: decoded.uid,
        gameId: validation.value.gameId,
        score: validation.value.score,
        durationMs: validation.value.durationMs,
      });
      res.json({ ok: true, ...saved });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to save minigame score.',
        detail: err instanceof Error ? err.message : 'Write error',
      });
    }
  });

  // Phase 6 Account & Personal Data Deletion Route
  app.delete('/api/account', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;

    if (req.body?.confirmText !== 'DELETE') {
      res.status(400).json({
        error: 'Explicit confirmation text "DELETE" is required to delete your account.',
      });
      return;
    }

    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady || !adminApp) {
      res.status(503).json({ error: 'Server Firebase Admin SDK unavailable.' });
      return;
    }

    try {
      const outcome = await deleteUserAccountAndPersonalData({
        serverDb,
        adminAuth: getAdminAuth(adminApp),
        uid: decoded.uid,
      });
      res.json({ ok: true, ...outcome });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to complete account deletion.',
      });
    }
  });

  // Catch-all for unknown /api routes so SPA fallback never masks API 404s
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Global Express JSON/error handler (no stack traces leaked to client)
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err instanceof SyntaxError && 'status' in err && (err as { status?: number }).status === 400) {
        res.status(400).json({ error: 'Malformed JSON request body.' });
        return;
      }
      res.status(500).json({ error: 'Unexpected internal server error.' });
    }
  );

  app.listen(port, '0.0.0.0', () => {
    console.log(
      `PatchUp server running on http://0.0.0.0:${port} (mode: ${isProd ? 'production' : 'development'})`
    );
  });
}

startServer().catch((err) => {
  console.error('Failed to start PatchUp server:', err);
  process.exit(1);
});

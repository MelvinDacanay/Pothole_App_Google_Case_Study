import {publicPothole,publicEvidence,publicActivity} from './server/publicCommunity.ts';
import { loadMediaBytes, storeSanitizedUpload, isReadableMedia, mediaBackend, runMediaMaintenance } from './server/mediaStore.ts';
import { decodeUpload, PHOTO_PRIVACY_VERSION } from './server/photoPrivacy.ts';
import { lookupCityRoad, confirmRoad } from './server/roadLocation.ts';
import { buildReportDraft } from './server/adminDraft.ts';
import 'dotenv/config';
import { CONSENT_VERSION, hasAccountConsent, saveAccountConsent, validConsentRequest } from './server/consent.ts';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { initializeApp, cert, applicationDefault, getApps, type App as AdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { credentialMode, verifyCloudRunIdentity } from './server/runtimeAuth.ts';
import { authorizeAdmin, normalizeEmail, reconcileAdminDirectory, revokeLegacyAdmin } from './server/adminAuthorization.ts';
import {
  FieldValue,
  getFirestore as getAdminFirestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import {
  haversineMeters,
  isValidCoordinatePair,
  isWithinAtlantaMetro,
  normalizeStreetName,
  scoreDuplicateCandidate,
} from './server/geo.ts';
import {
  getConfiguredGeminiModel,
} from './server/gemini.ts';
import {
  createNotification,
  evaluateUserAchievements,
  getCurrentMonthKey,
  getCurrentWeekKey,
  makeFriendshipId,
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
import { createRateLimiter, checkRateLimit } from './server/rateLimit.ts';
import { verifyImage, publicVerification } from './server/verification.ts';
import { commitVerifiedSubmission, commitPendingReview } from './server/submission.ts';
import { autoAcceptEnabled } from './server/verificationPolicy.ts';
import { finishContribution } from './server/contributions.ts';
import { deleteUserAccountAndPersonalData } from './server/account.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const ALLOWED_MEDIA_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_COORD_SOURCES = new Set(['gps_verified', 'exif_extracted', 'manual_pin']);
const ALLOWED_SEVERITIES = new Set(['low', 'moderate', 'severe', 'unclassified']);

async function syncUserPotholeContributorIdentity(
  db: FirebaseFirestore.Firestore,
  uid: string
): Promise<void> {
  const [userSnap, potholesSnap] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('potholes').where('primaryContributorUid', '==', uid).limit(500).get(),
  ]);
  if (!userSnap.exists || potholesSnap.empty) return;

  const userData = userSnap.data()!;
  const photoURL =
    typeof userData.photoURL === 'string' && userData.photoURL.length <= 512
      ? userData.photoURL
      : undefined;
  const batch = db.batch();
  for (const potholeDoc of potholesSnap.docs) {
    batch.update(potholeDoc.ref, {
      primaryContributorUsername: String(userData.username || 'atlanta_user').slice(0, 32),
      primaryContributorDisplayName: String(userData.displayName || 'Patcher').slice(0, 64),
      ...(photoURL ? { primaryContributorPhotoURL: photoURL } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

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

const runtimeCredentialMode = credentialMode(process.env); // Invalid Cloud Run overrides terminate startup.
if (firebaseConfig) {
  try {
    if (getApps().length > 0) {
      if (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) throw new Error('Unexpected preinitialized Firebase app.');
      adminApp = getApps()[0] ?? null;
      adminSdkMode = 'adc_or_project';
    } else if (runtimeCredentialMode === 'service_account') {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
      if (parsed.project_id !== firebaseConfig.projectId) throw new Error('Firebase credential project mismatch.');
      adminApp = initializeApp({
        credential: cert(parsed),
        projectId: firebaseConfig.projectId,
      });
      adminSdkMode = 'service_account';
    } else if (runtimeCredentialMode === 'adc') {
      adminApp = initializeApp({
        credential: applicationDefault(),
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
    if (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) throw new Error('Cloud Run Firebase initialization failed.');
    console.warn('Firebase Admin SDK initialization deferred; check server credentials.');
    adminApp = null;
    adminSdkMode = 'unconfigured';
  }
}

export function getServerFirestore() {
  if (!adminApp || !firebaseConfig) return null;
  const dbId = firebaseConfig.firestoreDatabaseId?.trim();
  return dbId && dbId !== '(default)'
    ? getAdminFirestore(adminApp, dbId)
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
    ''
  );
}

async function verifyBearerToken(
  req: express.Request,
  res: express.Response,
  requireVerifiedEmail = true,
  checkRevoked = false
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
    const decoded = await getAdminAuth(adminApp).verifyIdToken(token, checkRevoked);
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

async function requireAccountConsent(db: NonNullable<ReturnType<typeof getServerFirestore>>, uid: string, res: express.Response): Promise<boolean> {
  try {
    if (await hasAccountConsent(db, uid)) return true;
    res.status(403).json({error:'Complete the required account confirmations before continuing.'});
  } catch { res.status(503).json({error:'Unable to verify account consent. Please retry.'}); }
  return false;
}

async function requireAdmin(
  req: express.Request,
  res: express.Response
): Promise<{ decoded: DecodedIdToken; actor: AdminActor } | null> {
  const decoded = await verifyBearerToken(req, res, true, true);
  if (!decoded) return null;

  if (!getServerFirestore() || !adminFirestoreReady || !adminApp) {
    res.status(503).json({ error: 'Server Firestore database unavailable.' });
    return null;
  }
  try {
    if (!await authorizeAdmin(getAdminAuth(adminApp), decoded)) {
      res.status(403).json({ error: 'Admin privileges required for community oversight actions.' });
      return null;
    }
  } catch {
    res.status(503).json({ error: 'Unable to verify administrator access.' });
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

async function startServer() {
  if (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) {
    if (!firebaseConfig) throw new Error('Cloud Run requires Firebase project configuration.');
    await verifyCloudRunIdentity(firebaseConfig.projectId);
  }
  await probeAdminFirestore();
  if ((process.env.K_SERVICE || process.env.CLOUD_RUN_JOB) && (!adminApp || !adminFirestoreReady)) {
    throw new Error('Cloud Run requires working Firebase ADC and Firestore access.');
  }
  const startupDb = getServerFirestore();
  if (adminApp && startupDb && adminFirestoreReady && process.env.PATCHUP_ADMIN_EMAILS !== undefined && !process.env.FIRESTORE_EMULATOR_HOST) {
    try { await reconcileAdminDirectory(getAdminAuth(adminApp), startupDb); }
    catch { console.warn('Administrator directory reconciliation incomplete; retry on next startup or sign-in.'); }
  }
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
  app.use('/api/media', createRateLimiter({scope:'media_read',maxRequests:180,windowMs:60_000}));
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
      firebaseStorageEnabled: mediaBackend()==='gcs',
      mediaStoreMode: mediaBackend(),
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
      imageAiEnabled:process.env.PATCHUP_IMAGE_AI_ENABLED==='true'&&process.env.PATCHUP_GEMINI_DATA_MODE==='paid',
      imageAutoAcceptEnabled:autoAcceptEnabled(),
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
    const decoded = await verifyBearerToken(req, res, false, true);
    if (!decoded) return;
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      res.json({ uid: decoded.uid, emailVerified: Boolean(decoded.email_verified), admin: Boolean(adminApp && await authorizeAdmin(getAdminAuth(adminApp), decoded)) });
    } catch { res.status(503).json({ error: 'Unable to verify session.' }); }
  });

  // Account consent is stored by the Admin SDK, never trusted from an image request.
  app.get('/api/auth/consent', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;
    res.setHeader('Cache-Control', 'no-store');
    const db = getServerFirestore();
    if (!db || !adminFirestoreReady) { res.status(503).json({error:'Consent service unavailable.'}); return; }
    try { res.json({accepted: await hasAccountConsent(db, decoded.uid), version: CONSENT_VERSION}); }
    catch { res.status(503).json({error:'Unable to load account consent. Please retry.'}); }
  });
  app.post('/api/auth/consent', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!validConsentRequest(req.body)) { res.status(400).json({error:'Both confirmations and the current consent version are required.'}); return; }
    const db = getServerFirestore();
    if (!db || !adminFirestoreReady) { res.status(503).json({error:'Consent service unavailable.'}); return; }
    try { await saveAccountConsent(db, decoded.uid); res.json({accepted:true, version:CONSENT_VERSION}); }
    catch { res.status(503).json({error:'Unable to save account consent. Please retry.'}); }
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

    const db=getServerFirestore(); if(!db){res.status(503).json({error:'Location service unavailable.'});return;}
    if(!await requireAccountConsent(db,decoded.uid,res))return;
    const match=await lookupCityRoad(db,decoded.uid,lat,lng);
    res.json({...match,streetName:match?.streetName||'',source:match?'city_centerline':'coordinate_fallback',inAtlantaMetro:isWithinAtlantaMetro(lat,lng)});
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
          if (dist > 25 || !['accepted','reported','acknowledged'].includes(String(data.status))) return null;

          const updatedAt = data.updatedAt as Timestamp | undefined;
          return scoreDuplicateCandidate({
            targetLat: lat,
            targetLng: lng,
            targetNormalizedStreet,
            candidate: {
              potholeId: String(data.potholeId || d.id),
              lat: pLat,
              lng: pLng,
              formattedAddress: String(data.streetName || ''),
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

  app.post('/api/media/upload',async(req,res)=>{
    const decoded=await verifyBearerToken(req,res,true);if(!decoded)return;
    const db=getServerFirestore();if(!db){res.status(503).json({error:'Photo storage unavailable.'});return;}
    if(!await requireAccountConsent(db,decoded.uid,res))return;
    if(req.body?.privacyConfirmed!==true){res.status(400).json({error:'Review the photo for personal details before uploading.'});return;}
    const rate=checkRateLimit({scope:'photo_upload_uid',key:decoded.uid,maxRequests:6,windowMs:60_000});if(!rate.allowed){res.status(429).json({error:'Too many uploads. Please wait.'});return;}
    try{const result=await storeSanitizedUpload(db,{uid:decoded.uid,mediaId:String(req.body?.mediaId||''),bytes:decodeUpload(req.body?.data),mime:String(req.body?.contentType||'')});res.status(201).json(result);}catch{res.status(400).json({error:'Photo could not be saved. Check the format, upload allowance, or try again.'});}
  });

  app.post('/api/admin/media-maintenance',async(req,res)=>{
    if(!await requireAdmin(req,res))return;
    try{res.json(await runMediaMaintenance(getServerFirestore()!));}catch{res.status(503).json({error:'Photo cleanup unavailable.'});}
  });

  app.post('/api/potholes/analyze', async (req, res) => {
    const decoded = await verifyBearerToken(req, res, true);
    if (!decoded) return;
    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady) { res.status(503).json({error:'Verification database unavailable.'}); return; }
    const mediaId = typeof req.body?.mediaId === 'string' ? req.body.mediaId : '';
    if (!SAFE_ID_REGEX.test(mediaId)) { res.status(400).json({error:'Invalid media ID.'}); return; }
    if (!(await requireAccountConsent(serverDb, decoded.uid, res))) return;
    if (process.env.PATCHUP_IMAGE_AI_ENABLED !== 'true' || process.env.PATCHUP_GEMINI_DATA_MODE !== 'paid') { res.status(503).json({error:'Photo verification is temporarily disabled.'}); return; }
    const rate = checkRateLimit({scope:'verification_uid',key:decoded.uid,maxRequests:8,windowMs:60_000});
    if (!rate.allowed) {res.setHeader('Retry-After',String(rate.retryAfterSeconds));res.status(429).json({error:'Please wait before checking another photo.'});return;}
    try {
      const m=(await serverDb.collection('mediaObjects').doc(mediaId).get()).data();
      if (!isReadableMedia(m) || m.ownerId !== decoded.uid || m.privacyVersion!==PHOTO_PRIVACY_VERSION || !mediaId.startsWith('med_')) {res.status(404).json({error:'Your uploaded photo was not found.'});return;}
      const media=await loadMediaBytes(mediaId,m,'evidence','analysis');
      const record=await verifyImage(serverDb,{uid:decoded.uid,mediaId,bytes:media.buffer,mime:media.contentType,consent:true});
      res.setHeader('Cache-Control','no-store');res.json(publicVerification(record));
    } catch (err) {
      const message=err instanceof Error?err.message:'';
      if (message==='An image check is already running. Retry shortly.' || message==='Image check superseded. Retry shortly.') {res.status(409).json({error:message});return;}
      if(message==='This photo was already submitted.') {res.status(409).json({error:message});return;}
      res.status(400).json({error:'Unable to verify this photo. Check the image format or try again.'});
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

    if (!(await requireAccountConsent(serverDb, decoded.uid, res))) return;

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

    const locationUserCorrected = Boolean(body.locationUserCorrected);
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 400) : '';
    const duplicateConfidence = Number.isFinite(Number(body.duplicateConfidence))
      ? Math.min(1, Math.max(0, Number(body.duplicateConfidence)))
      : 0;

    const verificationId = typeof body.verificationId === 'string' ? body.verificationId : '';
    if (!SAFE_ID_REGEX.test(verificationId)) {res.status(400).json({error:'A server photo verification is required.'});return;}
    const requestedAction = actionType;
    if(actionType==='new_pothole'&&targetPotholeId){res.status(400).json({error:'New potholes cannot include an evidence target.'});return;}
    if (!SAFE_ID_REGEX.test(mediaId)) {
      res.status(400).json({ error: 'Valid mediaId is required.' });
      return;
    }
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' || !isValidCoordinatePair(lat, lng) || !isWithinAtlantaMetro(lat,lng)) {
      res.status(400).json({ error: 'Valid Atlanta metro coordinates are required.' });
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

    if(body.locationConfirmed!==true){res.status(400).json({error:'Confirm the pothole location first.'});return;}
    try {
      const existing=(await serverDb.collection('submissions').doc(submissionId).get()).data();
      const road=existing?.userId===decoded.uid&&existing.lat===lat&&existing.lng===lng?{streetName:existing.streetName,normalizedStreet:existing.normalizedStreet,formattedAddress:existing.formattedAddress,neighborhood:'',city:'Atlanta',state:'GA',postalCode:'',placeId:'',jurisdiction:existing.jurisdiction||'unknown',streetSource:existing.streetSource||'legacy'}:await confirmRoad(serverDb,decoded.uid,lat,lng,body.streetName,body.streetSource);
      const txResult = await commitVerifiedSubmission(serverDb,{uid:decoded.uid,submissionId, mediaId, verificationId, requestedAction, targetPotholeId, lat, lng, actionType, coordinateSource, accuracyMeters, ...road, locationUserCorrected, notes, duplicateConfidence, candidatePotholeIds});

      const segmentResult=txResult.duplicateStatus==='pending_review'?null:await finishContribution(serverDb,submissionId).catch(()=>null);
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

  async function resolvePendingSubmission(serverDb:FirebaseFirestore.Firestore, decoded:DecodedIdToken, submissionId:string, resolution:'confirm_distinct'|'merge_evidence'|'reject', targetPotholeId:string, reason:string) {
    const outcome=await commitPendingReview(serverDb,{uid:decoded.uid,email:String(decoded.email||'')},submissionId,resolution,targetPotholeId,reason);
    if (['distinct','evidence_added'].includes(String(outcome.duplicateStatus))) await finishContribution(serverDb,submissionId).catch(()=>null);
    return outcome;
  }

  app.post('/api/submissions/:submissionId/resolve', async (req, res) => {
    const adminCtx=await requireAdmin(req,res);if(!adminCtx)return;
    const {submissionId}=req.params, resolution=req.body?.resolution;
    const target=typeof req.body?.targetPotholeId==='string'?req.body.targetPotholeId:'';
    if(!SAFE_ID_REGEX.test(submissionId)||!['confirm_distinct','merge_evidence','reject'].includes(resolution)||(resolution==='merge_evidence'&&!SAFE_ID_REGEX.test(target))) {res.status(400).json({error:'Invalid review request.'});return;}
    try {const outcome=await resolvePendingSubmission(getServerFirestore()!,adminCtx.decoded,submissionId,resolution,target,typeof req.body?.reason==='string'?req.body.reason:'Administrator manual photo review');res.json({ok:true,...outcome});}
    catch(err){res.status(400).json({error:err instanceof Error?err.message:'Unable to resolve submission.'});}
  });

  app.use('/api/community',createRateLimiter({scope:'community_read',maxRequests:60,windowMs:60_000}));
  const communityCache=new Map<string,{until:number;items:unknown[]}>();
  app.get('/api/community/:kind',async(req,res)=>{
    const kind=req.params.kind;if(!['potholes','activity'].includes(kind)){res.sendStatus(404);return;}
    const db=getServerFirestore();if(!db){res.sendStatus(503);return;}
    try{let cached=communityCache.get(kind);if(!cached||cached.until<Date.now()){
      const snap=kind==='potholes'?await db.collection('potholes').where('status','in',['accepted','reported','acknowledged','repaired']).limit(150).get():await db.collection('activityFeed').where('visibility','==','public').limit(40).get();
      const sorted=snap.docs.slice().sort((a,b)=>(b.data().createdAt?.toMillis?.()||0)-(a.data().createdAt?.toMillis?.()||0));
      const items=kind==='potholes'?sorted.filter(d=>d.data().verificationStatus==='accepted').map(d=>publicPothole(d.id,d.data())):sorted.map(d=>publicActivity(d.id,d.data()));cached={until:Date.now()+30000,items};communityCache.set(kind,cached);
    }res.setHeader('Cache-Control','private, max-age=30');res.json({items:cached.items});}catch{res.status(503).json({error:'Community information unavailable.'});}
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
      const parent=await serverDb.collection('potholes').doc(potholeId).get();
      if(!parent.exists||!['accepted','reported','acknowledged','repaired'].includes(String(parent.data()?.status))){res.status(404).json({error:'Pothole not available.'});return;}
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

      res.json({ items:items.map(s=>publicEvidence(String(s.submissionId||s.mediaId),s)) });
    } catch (err) {
      res.status(500).json({
        error: 'Unable to load pothole evidence records.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  app.get('/api/media/:mediaId', async (req,res)=>{
    const {mediaId}=req.params;
    if(!SAFE_ID_REGEX.test(mediaId)){res.status(400).json({error:'Invalid media ID.'});return;}
    const db=getServerFirestore();if(!db||!adminFirestoreReady){res.status(503).json({error:'Media service unavailable.'});return;}
    try{
      const media=(await db.collection('mediaObjects').doc(mediaId).get()).data();
      if(!isReadableMedia(media)){res.status(404).json({error:'Media not found.'});return;}
      let allowed=false;
      if(req.headers.authorization){const decoded=await verifyBearerToken(req,res,false,true);if(!decoded)return;allowed=decoded.uid===media.ownerId||Boolean(adminApp&&await authorizeAdmin(getAdminAuth(adminApp),decoded));}
      if(!allowed){
        // Public only when referenced by an accepted canonical record, approved evidence, or the owner's own avatar.
        const [pots,subs,owner]=await Promise.all([db.collection('potholes').where('primaryMediaId','==',mediaId).limit(10).get(),db.collection('submissions').where('mediaId','==',mediaId).limit(10).get(),db.collection('users').doc(media.ownerId).get()]);
        const accepted=(d:FirebaseFirestore.DocumentData)=>['accepted','reported','acknowledged','repaired'].includes(String(d.status))&&d.verificationStatus==='accepted';
        const owns=(uid:unknown)=>uid===media.ownerId;
        allowed=pots.docs.some(d=>accepted(d.data())&&owns(d.data().primaryContributorUid))||(mediaId.startsWith('avt_')&&owner.data()?.photoURL===`/api/media/${mediaId}`);
        if(!allowed){for(const sub of subs.docs){const v=sub.data();if(!['distinct','evidence_added'].includes(String(v.duplicateStatus))||!owns(v.userId))continue;const pot=await db.collection('potholes').doc(String(v.potholeId)).get();if(pot.exists&&accepted(pot.data()!)){allowed=true;break;}}}
      }
      if(!allowed){res.status(404).json({error:'Media not found.'});return;}
      const prepared=await loadMediaBytes(mediaId,media,req.query.variant==='thumb'?'thumb':'evidence');
      res.setHeader('Content-Type',prepared.contentType);res.setHeader('Content-Length',String(prepared.buffer.length));res.setHeader('Cache-Control',req.headers.authorization?'private, no-store':'private, max-age=120');res.setHeader('Vary','Authorization');res.setHeader('X-Content-Type-Options','nosniff');res.status(200).send(prepared.buffer);
    }catch{res.status(404).json({error:'Media not available.'});}
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
      // Contribution counters are maintained by acceptance transactions; do not reset them from a capped query.
      await syncUserPotholeContributorIdentity(serverDb, decoded.uid);
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

    const normalizeName = (value: string) => value.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/^@/, '');
    const rawQuery = normalizeName(typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '');
    const recommendations = req.query.recommendations === 'true';
    if (!rawQuery && !recommendations) {
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
        serverDb.collection('users')
          .select('uid', 'username', 'displayName', 'photoURL', 'bio',
            'distinctPotholeCount', 'evidenceCount', 'shareNeighborhood', 'homeNeighborhood').get(),
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

      const scoreName = (value: string) => {
        const name = normalizeName(value);
        if (name === rawQuery) return 4;
        if (name.startsWith(rawQuery)) return 3;
        if (name.includes(rawQuery)) return 2;
        let index = 0;
        for (const char of name) if (char === rawQuery[index]) index++;
        return index === rawQuery.length ? 1 : 0;
      };
      const candidates = usersSnap.docs
        .map((d) => ({ ...d.data(), uid: d.id }) as FirebaseFirestore.DocumentData & { uid: string })
        .filter((u) => {
          if (u.uid === decoded.uid) return false;
          if (recommendations) return !relationMap.has(u.uid);
          return scoreName(String(u.username || '')) > 0 || scoreName(String(u.displayName || '')) > 0;
        })
        .map((u) => ({ ...u, rank: recommendations ? Math.random() :
          Math.max(scoreName(String(u.username || '')), scoreName(String(u.displayName || ''))) }) as
          FirebaseFirestore.DocumentData & { uid: string; rank: number })
        .sort((a, b) => b.rank - a.rank);
      const matches = candidates
        .slice(0, 12)
        .map((u) => {
          const rel = relationMap.get(String(u.uid));
          return {
            uid: String(u.uid),
            username: String(u.username || ''),
            displayName: String(u.displayName || ''),
            photoURL: typeof u.photoURL === 'string' ? u.photoURL : undefined,
            bio: typeof u.bio === 'string' ? u.bio.slice(0, 160) : '',
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
        error: 'Unable to search Patchers.',
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
          displayName: String(profile?.displayName || 'Patcher'),
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
      res.status(400).json({ error: 'Valid target Patcher UID is required.' });
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
          throw new Error('Patcher profile not found.');
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

  // Phase 4 Community Segmentation, 5-Pothole Report Engine & Admin Oversight Routes
  app.post('/api/admin/bootstrap', async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const decoded = await verifyBearerToken(req, res, true, true);
    if (!decoded) return;
    const serverDb = getServerFirestore();
    if (!serverDb || !adminFirestoreReady || !adminApp) {
      res.status(503).json({ error: 'Server Firebase Admin SDK unavailable.' });
      return;
    }
    try {
      const auth = getAdminAuth(adminApp);
      if (!await authorizeAdmin(auth, decoded)) {
        // A legacy claim-only account is cleaned up when it returns. Current
        // authorization remains denied even if cleanup fails.
        await revokeLegacyAdmin(auth, serverDb, decoded.uid);
        res.status(403).json({ ok: false, admin: false, error: 'Admin privileges required.' });
        return;
      }
      const email = normalizeEmail(decoded.email);
      const ref = serverDb.collection('admins').doc(decoded.uid);
      const enrolled = await serverDb.runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (existing.exists && existing.data()?.email === email) return false;
        tx.set(ref, { uid: decoded.uid, email, grantedAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (enrolled) await writeAdminAudit(serverDb, {
        actor: { uid: decoded.uid, email }, action: 'admin_bootstrap', targetType: 'admin',
        targetId: decoded.uid, reason: 'Verified server allowlist enrollment', afterSummary: 'Administrator enrolled',
      });
      // No new privileged custom claim is necessary; every admin operation uses
      // the server allowlist and current Auth account instead.
      res.json({ ok: true, admin: true, claimUpdated: false });
    } catch {
      res.status(503).json({ error: 'Unable to verify administrator access.' });
    }
  });

  app.get('/api/segments', async (req, res) => {
    if(!await requireAdmin(req,res))return;
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

  app.get('/api/reports', async (req, res) => {
    if(!await requireAdmin(req,res))return;
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
        error: 'Unable to load community reports.',
        detail: err instanceof Error ? err.message : 'Query error',
      });
    }
  });

  // Admin-only, read-only views over persistent submission and report records.
  app.get('/api/admin/hub/:section', async (req,res) => {
    if (!await requireAdmin(req,res)) return;
    res.set('Cache-Control','private, no-store');
    const db = getServerFirestore()!;
    const section = req.params.section;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    if (cursor && !SAFE_ID_REGEX.test(cursor)) {res.status(400).json({error:'Invalid cursor.'});return;}
    try {
      let query: FirebaseFirestore.Query;
      if (section === 'reviews') query = db.collection('submissions').where('duplicateStatus','==','pending_review');
      else if (section === 'drafts') query = db.collection('reports').where('status','in',['awaiting_admin_review','ready_for_submission','unable_to_submit']);
      else if (section === 'sent') query = db.collection('reports').where('status','in',['submitted','acknowledged','resolved']);
      else if (section === 'repairs') query = db.collection('potholes').where('status','in',['accepted','reported','acknowledged']);
      else if (section === 'history') {
        const recent = await db.collection('adminAudit').orderBy('createdAt','desc').limit(30).get();
        res.json({items:recent.docs.map(doc=>{const d=doc.data();return {id:doc.id,action:d.action,reason:d.reason,afterSummary:d.afterSummary,createdAt:d.createdAt?.toMillis?.()??null};}),nextCursor:null});return;
      }
      else {res.status(404).json({error:'Unknown section.'});return;}
      query = query.orderBy('__name__');
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.limit(26).get();
      const docs = snapshot.docs.slice(0,25);
      const items = docs.map(doc => { const d=doc.data(); return section === 'reviews' ? {
        id:doc.id, streetName:d.streetName, formattedAddress:d.formattedAddress, mediaId:d.mediaId, lat:d.lat,lng:d.lng, aiSummary:d.aiSummary, targetPotholeId:d.reviewTargetPotholeId || '', candidatePotholeIds:Array.isArray(d.candidatePotholeIds)?d.candidatePotholeIds:[]
      } : section === 'repairs' ? {
        id:doc.id, streetName:d.streetName, formattedAddress:d.formattedAddress, mediaId:d.primaryMediaId, lat:d.lat, lng:d.lng, status:d.status
      } : {id:doc.id,streetName:d.streetName,status:d.status,jurisdiction:d.jurisdiction,distinctPotholeCount:d.distinctPotholeCount,externalReference:d.externalReference,submissionChannel:d.submissionChannel}; });
      res.json({items,nextCursor:snapshot.size>25?docs[docs.length-1].id:null});
    } catch {res.status(500).json({error:'Unable to load admin queue.'});}
  });
  app.get('/api/admin/email-drafts/:reportId', async (req,res) => {
    if (!await requireAdmin(req,res)) return;
    res.set('Cache-Control','private, no-store');
    const db=getServerFirestore()!, id=req.params.reportId;
    if (!SAFE_ID_REGEX.test(id)) {res.status(400).json({error:'Invalid report ID.'});return;}
    try {
      const snap=await db.collection('reports').doc(id).get();
      const report=snap.data();
      if (!report || !['awaiting_admin_review','ready_for_submission','unable_to_submit'].includes(report.status)) {res.status(404).json({error:'Draft no longer pending.'});return;}
      const ids=Array.isArray(report.snapshotPotholeIds)?[...new Set<string>(report.snapshotPotholeIds.filter((id:unknown)=>typeof id==='string'&&SAFE_ID_REGEX.test(id)))].slice(0,5):[];
      const photos=ids.length?await db.getAll(...ids.map(id=>db.collection('potholes').doc(id))):[];
      const draft=buildReportDraft(report,photos.filter(p=>p.exists).map(p=>({...p.data(),potholeId:p.id})),(process.env.PATCHUP_REPORT_FROM_EMAIL||'').trim());
      const media=draft.attachments.length?await db.getAll(...draft.attachments.map(a=>db.collection('mediaObjects').doc(a.mediaId))):[];
      const attachments=[];
      for(const [i,a] of draft.attachments.entries()){
        const m=media[i]?.data(); const p=photos.find(p=>p.id===a.potholeId)?.data(); const type=String(m?.contentType||'');
        let valid=false;
        try {if(isReadableMedia(m)&&m.ownerId===p?.primaryContributorUid){await loadMediaBytes(a.mediaId,m);valid=true;}}catch{/* missing or malformed photo */}
        if(!valid) draft.warnings.push(`Pothole ${a.number}: image unavailable.`);
        const ext='jpg';
        if(m?.privacyVersion!==PHOTO_PRIVACY_VERSION)draft.warnings.push(`Pothole ${a.number}: older photo; review visible personal details before sharing.`);
        attachments.push({...a,filename:`pothole-${a.number}.${ext}`,url:valid?`/api/media/${a.mediaId}`:null});
      }
      res.json({...draft,attachments,reportId:id,status:report.status});
    } catch {res.status(500).json({error:'Unable to generate email draft.'});}
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
        error: 'Unable to load admin community oversight overview.',
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
      const reviewDb=getServerFirestore()!;
      const pot=await reviewDb.collection('potholes').doc(potholeId).get();
      if(pot.data()?.status==='provisional' && status && status!=='provisional') {
        if(status!=='accepted'&&status!=='rejected') throw new Error('Accept or reject the pending photo before changing repair status.');
        const subs=await reviewDb.collection('submissions').where('potholeId','==',potholeId).get();
        const pending=subs.docs.filter(d=>d.data().duplicateStatus==='pending_review');
        if(pending.length!==1) throw new Error('Expected one pending submission. Inspect the review records.');
        const target=String(pending[0].data().reviewTargetPotholeId||'');
        const decision=status==='rejected'?'reject':target?'merge_evidence':'confirm_distinct';
        const review=await resolvePendingSubmission(reviewDb,adminCtx.decoded,pending[0].id,decision,target,reason);
        res.json({ok:true,potholeId:review.potholeId,status:review.duplicateStatus==='rejected'?'rejected':'accepted',duplicateStatus:review.duplicateStatus});return;
      }
      const outcome = await adminReviewPothole(reviewDb, {
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

  app.post('/api/admin/contributions/reconcile',async(req,res)=>{
    if(!await requireAdmin(req,res))return;
    const db=getServerFirestore()!;const snap=await db.collection('contributionEffects').where('status','==','pending').limit(25).get();
    let completed=0,failed=0;for(const d of snap.docs){try{await finishContribution(db,d.id);completed++;}catch{failed++;}}
    res.json({ok:true,processed:snap.size,completed,failed});
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
        res.status(404).json({ error: 'Community report not found.' });
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

  // Phase 5 Entertainment Minigame Routes (strictly isolated from community metrics)
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
    if (validation.ok === false) {
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

  if(process.env.PATCHUP_MEDIA_MAINTENANCE_ENABLED==='true'){let running=false;const tick=async()=>{if(running)return;const db=getServerFirestore();if(!db)return;running=true;try{await runMediaMaintenance(db);}catch{/* retry next run */}finally{running=false;}};setInterval(()=>void tick(),60*60*1000).unref();void tick();}
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

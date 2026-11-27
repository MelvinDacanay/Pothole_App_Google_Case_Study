import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  reauthenticateWithPopup,
  setPersistence,
  signInWithPopup,
  signOut,
  type Auth,
} from 'firebase/auth';
import { doc, getDocFromServer, getFirestore, type Firestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const LOCAL_DEV_FIRESTORE_ID = '(default)';

function resolveClientApiKey(): string {
  const fromEnv = import.meta.env.VITE_FIREBASE_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return (firebaseConfig.apiKey || '').trim();
}

function resolveClientAppId(): string {
  const fromEnv = import.meta.env.VITE_FIREBASE_APP_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  return (firebaseConfig.appId || '').trim();
}

function resolveFirestoreDatabaseId(): string {
  const fromEnv = import.meta.env.VITE_FIRESTORE_DATABASE_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromFile = (firebaseConfig.firestoreDatabaseId || '').trim();
  return fromFile || LOCAL_DEV_FIRESTORE_ID;
}

export const firebaseClientConfigured = Boolean(
  resolveClientApiKey() && resolveClientAppId() && firebaseConfig.projectId
);

const missingConfigMessage =
  'Firebase web config is missing. Add apiKey and appId to firebase-applet-config.json, or set VITE_FIREBASE_API_KEY and VITE_FIREBASE_APP_ID in .env.';

let app: FirebaseApp | null = null;
export let auth: Auth | null = null;
export let db: Firestore | null = null;

if (firebaseClientConfigured) {
  app = initializeApp({
    apiKey: resolveClientApiKey(),
    appId: resolveClientAppId(),
    authDomain: firebaseConfig.authDomain,
    projectId: firebaseConfig.projectId,
    storageBucket: firebaseConfig.storageBucket,
    messagingSenderId: firebaseConfig.messagingSenderId || undefined,
    measurementId: firebaseConfig.measurementId || undefined,
  });
  auth = getAuth(app);
  setPersistence(auth, browserLocalPersistence).catch((err) => {
    console.warn('Unable to configure local auth persistence:', err);
  });
  const firestoreDbId = resolveFirestoreDatabaseId();
  db = firestoreDbId && firestoreDbId !== '(default)'
    ? getFirestore(app, firestoreDbId)
    : getFirestore(app);
} else {
  console.warn(`PatchUp: ${missingConfigMessage}`);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth?.currentUser?.uid ?? null,
      email: auth?.currentUser?.email ?? null,
      emailVerified: auth?.currentUser?.emailVerified ?? null,
      isAnonymous: auth?.currentUser?.isAnonymous ?? null,
      tenantId: auth?.currentUser?.tenantId ?? null,
      providerInfo:
        auth?.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testFirestoreConnection(): Promise<{
  ok: boolean;
  message: string;
}> {
  if (!db) {
    return { ok: false, message: missingConfigMessage };
  }
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true, message: 'Connected to Cloud Firestore' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('the client is offline')) {
      return { ok: false, message: 'Firestore client appears offline. Check network or config.' };
    }
    if (message.toLowerCase().includes('permission')) {
      return { ok: false, message: 'Firestore permissions rejected health probe.' };
    }
    return { ok: true, message: 'Connected to Cloud Firestore' };
  }
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

const WORKSPACE_SHEETS_CLIENT_ID =
  '427628919354-0c8s92odjf3pfebhai7vvvq4rlg24fbb.apps.googleusercontent.com';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const sheetsProvider = new GoogleAuthProvider();
sheetsProvider.addScope(SHEETS_SCOPE);
sheetsProvider.setCustomParameters({ prompt: 'consent select_account' });

// Strictly in-memory OAuth access token for Google Sheets (never localStorage/sessionStorage)
let sheetsAccessTokenInMemory: string | null = null;

export function getSheetsAccessToken(): string | null {
  return sheetsAccessTokenInMemory;
}

export function clearSheetsAccessToken(): void {
  sheetsAccessTokenInMemory = null;
}

interface GisTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GisWindow extends Window {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          hint?: string;
          callback: (resp: GisTokenResponse) => void;
          error_callback?: (err: { type?: string; message?: string }) => void;
        }) => { requestAccessToken: (opts?: { prompt?: string }) => void };
      };
    };
  };
}

function loadGisScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  const gWin = window as GisWindow;
  if (gWin.google?.accounts?.oauth2?.initTokenClient) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-patchup-gis="true"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Google Identity')), {
        once: true,
      });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.patchupGis = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script'));
    document.head.appendChild(script);
  });
}

export async function connectGoogleSheetsForExport(): Promise<string> {
  let initTokenClient:
    | ((config: {
        client_id: string;
        scope: string;
        hint?: string;
        callback: (resp: GisTokenResponse) => void;
        error_callback?: (err: { type?: string; message?: string }) => void;
      }) => { requestAccessToken: (opts?: { prompt?: string }) => void })
    | undefined;

  try {
    await loadGisScript();
    const gWin = window as GisWindow;
    initTokenClient = gWin.google?.accounts?.oauth2?.initTokenClient;
  } catch {
    initTokenClient = undefined;
  }

  if (initTokenClient) {
    const token = await new Promise<string>((resolve, reject) => {
      const client = initTokenClient({
        client_id: WORKSPACE_SHEETS_CLIENT_ID,
        scope: SHEETS_SCOPE,
        hint: auth?.currentUser?.email ?? undefined,
        callback: (resp) => {
          if (resp.access_token) {
            resolve(resp.access_token);
          } else {
            reject(
              new Error(resp.error_description || resp.error || 'Sheets authorization denied.')
            );
          }
        },
        error_callback: (err) => {
          reject(new Error(err.message || err.type || 'Google Sheets popup blocked or closed.'));
        },
      });
      client.requestAccessToken({ prompt: 'consent' });
    });
    sheetsAccessTokenInMemory = token;
    return token;
  }

  if (!auth) {
    throw new Error(missingConfigMessage);
  }
  const result = auth.currentUser
    ? await reauthenticateWithPopup(auth.currentUser, sheetsProvider)
    : await signInWithPopup(auth, sheetsProvider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const accessToken = credential?.accessToken ?? null;
  if (!accessToken) {
    throw new Error('Google Sheets authorization did not return an access token.');
  }
  sheetsAccessTokenInMemory = accessToken;
  return accessToken;
}

export async function signInWithGoogle() {
  if (!auth) {
    throw new Error(missingConfigMessage);
  }
  return signInWithPopup(auth, googleProvider);
}

export async function signOutUser() {
  clearSheetsAccessToken();
  if (!auth) return;
  return signOut(auth);
}

export { firebaseConfig };

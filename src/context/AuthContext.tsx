import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  auth,
  clearSheetsAccessToken,
  db,
  firebaseClientConfigured,
  handleFirestoreError,
  OperationType,
  signInWithGoogle,
  signOutUser,
  testFirestoreConnection,
} from '../lib/firebase';

export interface UserPublicProfile {
  uid: string;
  username: string;
  displayName: string;
  photoURL?: string;
  bio?: string;
  homeNeighborhood?: string;
  joinedAt?: Timestamp;
  updatedAt?: Timestamp;
  distinctPotholeCount: number;
  evidenceCount: number;
  unlockedBadgesCount: number;
  potholesCollectedCount: number;
  dailyStreak: number;
  lastCollectedDate?: string;
  showOnLeaderboard: boolean;
  shareNeighborhood: boolean;
}

export interface UserPrivateAccount {
  uid: string;
  email: string;
  notificationsEnabled: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

interface AuthContextValue {
  user: User | null;
  authReady: boolean;
  publicProfile: UserPublicProfile | null;
  privateAccount: UserPrivateAccount | null;
  isAdmin: boolean;
  firestoreStatus: { ok: boolean; message: string } | null;
  authError: string | null;
  isSigningIn: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (updates: {
    displayName?: string;
    username?: string;
    photoURL?: string;
    homeNeighborhood?: string;
    bio?: string;
    showOnLeaderboard?: boolean;
    shareNeighborhood?: boolean;
  }) => Promise<void>;
  updateNotificationsPref: (enabled: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function buildSafeUsername(user: User): string {
  const baseSource = (user.email?.split('@')[0] || user.displayName || 'atlanta')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = (baseSource || 'driver').slice(0, 20);
  const suffix = user.uid.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'atl1';
  const combined = `${prefix}_${suffix}`;
  return combined.length >= 3 ? combined.slice(0, 32) : `atl_${suffix}`.slice(0, 32);
}

function buildSafeDisplayName(user: User): string {
  const raw = (user.displayName || user.email?.split('@')[0] || 'Atlanta Patcher').trim();
  return raw.slice(0, 64) || 'Atlanta Patcher';
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [publicProfile, setPublicProfile] = useState<UserPublicProfile | null>(null);
  const [privateAccount, setPrivateAccount] = useState<UserPrivateAccount | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [firestoreStatus, setFirestoreStatus] = useState<{ ok: boolean; message: string } | null>(
    null
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    if (!firebaseClientConfigured || !auth) {
      setFirestoreStatus({
        ok: false,
        message:
          'Firebase web config missing (apiKey/appId). UI preview works; sign-in and live data need firebase-applet-config.json or VITE_FIREBASE_* in .env.',
      });
      setAuthReady(true);
      return;
    }
    testFirestoreConnection().then(setFirestoreStatus);
  }, []);

  useEffect(() => {
    if (!auth || !db) {
      setAuthReady(true);
      return;
    }

    const firestore = db;
    const firebaseAuth = auth;

    let unsubPublic: (() => void) | null = null;
    let unsubPrivate: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(firebaseAuth, async (nextUser) => {
      if (unsubPublic) {
        unsubPublic();
        unsubPublic = null;
      }
      if (unsubPrivate) {
        unsubPrivate();
        unsubPrivate = null;
      }

      setUser(nextUser);
      setAuthError(null);

      if (!nextUser) {
        clearSheetsAccessToken();
        setPublicProfile(null);
        setPrivateAccount(null);
        setIsAdmin(false);
        setAuthReady(true);
        return;
      }

      setIsAdmin(false);
      try {
        if (nextUser.emailVerified) {
          const token = await nextUser.getIdToken();
          const bootRes = await fetch('/api/admin/bootstrap', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
          });
          const adminActive = bootRes.ok && (await bootRes.json()).admin === true;
          if (firebaseAuth.currentUser?.uid === nextUser.uid) setIsAdmin(adminActive);
        }
      } catch {
        if (firebaseAuth.currentUser?.uid === nextUser.uid) setIsAdmin(false);
      }

      const publicPath = `users/${nextUser.uid}`;
      const privatePath = `users/${nextUser.uid}/private/account`;
      const publicRef = doc(firestore, 'users', nextUser.uid);
      const privateRef = doc(firestore, 'users', nextUser.uid, 'private', 'account');

      try {
        const [pubSnap, privSnap] = await Promise.all([
          getDoc(publicRef).catch((err) => handleFirestoreError(err, OperationType.GET, publicPath)),
          getDoc(privateRef).catch((err) =>
            handleFirestoreError(err, OperationType.GET, privatePath)
          ),
        ]);

        if (!pubSnap.exists() || !privSnap.exists()) {
          const batch = writeBatch(firestore);
          if (!pubSnap.exists()) {
            const safePhoto =
              nextUser.photoURL && nextUser.photoURL.length <= 512 ? nextUser.photoURL : undefined;
            batch.set(publicRef, {
              uid: nextUser.uid,
              username: buildSafeUsername(nextUser),
              displayName: buildSafeDisplayName(nextUser),
              ...(safePhoto ? { photoURL: safePhoto } : {}),
              joinedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
              distinctPotholeCount: 0,
              evidenceCount: 0,
              unlockedBadgesCount: 0,
              potholesCollectedCount: 0,
              dailyStreak: 0,
              showOnLeaderboard: true,
              shareNeighborhood: true,
            });
          }
          if (!privSnap.exists()) {
            batch.set(privateRef, {
              uid: nextUser.uid,
              email: (nextUser.email || '').slice(0, 254),
              notificationsEnabled: true,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
          await batch
            .commit()
            .catch((err) => handleFirestoreError(err, OperationType.WRITE, publicPath));
        }

        unsubPublic = onSnapshot(
          publicRef,
          (snap) => {
            setPublicProfile(snap.exists() ? (snap.data() as UserPublicProfile) : null);
          },
          (err) => {
            handleFirestoreError(err, OperationType.GET, publicPath);
          }
        );

        unsubPrivate = onSnapshot(
          privateRef,
          (snap) => {
            setPrivateAccount(snap.exists() ? (snap.data() as UserPrivateAccount) : null);
          },
          (err) => {
            handleFirestoreError(err, OperationType.GET, privatePath);
          }
        );

        // Best-effort sync to server-maintained leaderboardStats & achievement backfill
        nextUser
          .getIdToken()
          .then((token) =>
            fetch('/api/profile/sync', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}` },
            })
          )
          .catch(() => {
            // Non-fatal
          });
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Unable to load profile data.');
      } finally {
        setAuthReady(true);
      }
    });

    return () => {
      unsubAuth();
      if (unsubPublic) unsubPublic();
      if (unsubPrivate) unsubPrivate();
    };
  }, []);

  // Recheck a signed-in administrator while the app remains open. Server requests
  // independently enforce authorization even before this presentation refresh.
  useEffect(() => {
    if (!user || !isAdmin) return;
    let active = true;
    let checking = false;
    const recheck = async () => {
      if (checking) return;
      checking = true;
      try {
        const token = await user.getIdToken();
        const response = await fetch('/api/auth/session', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        const allowed = response.ok && (await response.json()).admin === true;
        if (active && !allowed) setIsAdmin(false);
      } catch { if (active) setIsAdmin(false); }
      finally { checking = false; }
    };
    const timer = window.setInterval(() => void recheck(), 60_000);
    const onFocus = () => void recheck();
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [user, isAdmin]);

  const signIn = async () => {
    setAuthError(null);
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Sign-In failed.';
      setAuthError(msg);
      throw err;
    } finally {
      setIsSigningIn(false);
    }
  };

  const signOut = async () => {
    setAuthError(null);
    await signOutUser();
  };

  const updateProfile = async (updates: {
    displayName?: string;
    username?: string;
    photoURL?: string;
    homeNeighborhood?: string;
    bio?: string;
    showOnLeaderboard?: boolean;
    shareNeighborhood?: boolean;
  }) => {
    if (!user) throw new Error('Sign in required.');
    if (!db) throw new Error('Firebase is not configured.');
    const path = `users/${user.uid}`;
    const payload: Record<string, unknown> = {
      updatedAt: serverTimestamp(),
    };

    if (typeof updates.displayName === 'string') {
      const cleanName = updates.displayName.trim().slice(0, 64);
      if (cleanName.length < 1) throw new Error('Display name cannot be empty.');
      payload.displayName = cleanName;
    }

    if (typeof updates.username === 'string') {
      const cleanUsername = updates.username.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,32}$/.test(cleanUsername)) {
        throw new Error('Username must be 3-32 lowercase letters, numbers, or underscores.');
      }
      payload.username = cleanUsername;
    }

    if (typeof updates.photoURL === 'string') {
      const cleanPhoto = updates.photoURL.trim().slice(0, 512);
      if (cleanPhoto.length > 0) {
        payload.photoURL = cleanPhoto;
      }
    }

    if (typeof updates.homeNeighborhood === 'string') {
      payload.homeNeighborhood = updates.homeNeighborhood.trim().slice(0, 64);
    }
    if (typeof updates.bio === 'string') {
      payload.bio = updates.bio.trim().slice(0, 160);
    }

    if (typeof updates.showOnLeaderboard === 'boolean') {
      payload.showOnLeaderboard = updates.showOnLeaderboard;
    }

    if (typeof updates.shareNeighborhood === 'boolean') {
      payload.shareNeighborhood = updates.shareNeighborhood;
    }

    try {
      await updateDoc(doc(db, 'users', user.uid), payload);
      const token = await user.getIdToken();
      await fetch('/api/profile/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  const updateNotificationsPref = async (enabled: boolean) => {
    if (!user) throw new Error('Sign in required.');
    if (!db) throw new Error('Firebase is not configured.');
    const path = `users/${user.uid}/private/account`;
    try {
      await updateDoc(doc(db, 'users', user.uid, 'private', 'account'), {
        notificationsEnabled: enabled,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        authReady,
        publicProfile,
        privateAccount,
        isAdmin,
        firestoreStatus,
        authError,
        isSigningIn,
        signIn,
        signOut,
        updateProfile,
        updateNotificationsPref,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider.');
  return ctx;
}

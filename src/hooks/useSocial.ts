import { COMMUNITY_NOTIFICATION_TYPES, isCommunityNotification } from '../lib/communityNotifications';
import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { readApiJson } from '../lib/apiResponse';

export interface FriendItem {
  friendshipId: string;
  status: 'pending' | 'accepted' | 'declined';
  direction: 'incoming' | 'outgoing';
  otherUid: string;
  username: string;
  displayName: string;
  photoURL?: string;
  distinctPotholeCount: number;
  evidenceCount: number;
  homeNeighborhood?: string;
}

export interface FriendSearchUser {
  uid: string;
  username: string;
  displayName: string;
  photoURL?: string;
  bio?: string;
  distinctPotholeCount: number;
  evidenceCount: number;
  homeNeighborhood?: string;
  friendshipStatus: 'none' | 'pending' | 'accepted' | 'declined';
  friendshipId?: string;
  direction: 'none' | 'incoming' | 'outgoing';
}

export interface NotificationRecord {
  notificationId: string;
  uid: string;
  type: string;
  title: string;
  body: string;
  relatedId?: string;
  read: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ActivityFeedItem {
  eventId: string;
  actorUid: string;
  actorUsername: string;
  actorDisplayName: string;
  eventType: 'new_pothole' | 'evidence_added' | 'badge_unlocked' | 'confirmed_repair';
  summary: string;
  streetName?: string;
  neighborhood?: string;
  potholeId?: string;
  visibility: 'public';
  createdAt?: Timestamp;
}

export interface AchievementBadgeRecord {
  badgeType: string;
  uid: string;
  title: string;
  description: string;
  progress: number;
  target: number;
  unlocked: boolean;
  unlockedAt?: Timestamp;
}

export function useFriends(user: User | null) {
  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshFriends = useCallback(async () => {
    if (!user) {
      setFriends([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/friends', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await readApiJson<{ items?: FriendItem[] }>(res);
      if (!Array.isArray(data.items)) throw new Error('The server returned an invalid friends list.');
      setFriends(data.items);
      setError(null);
    } catch (err) {
      // Preserve the last known list, but do not disguise a backend outage as an empty account.
      setError(err instanceof Error ? err.message : 'Unable to load friends. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!user || !db) {
      setFriends([]);
      setLoading(false);
      return;
    }

    void refreshFriends();

    const q = query(
      collection(db, 'friendships'),
      where('participantUids', 'array-contains', user.uid),
      limit(100)
    );

    const unsub = onSnapshot(
      q,
      () => {
        void refreshFriends();
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, 'friendships');
      }
    );

    return () => unsub();
  }, [user, refreshFriends]);

  const sendFriendRequest = async (targetUid: string) => {
    if (!user) throw new Error('Sign in required.');
    const token = await user.getIdToken();
    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ targetUid }),
    });
    const data = await readApiJson<{ ok: boolean; friendshipId: string; status: string }>(res);
    await refreshFriends();
    return data as { ok: boolean; friendshipId: string; status: string };
  };

  const respondToFriend = async (
    friendshipId: string,
    action: 'accept' | 'decline' | 'remove'
  ) => {
    if (!user) throw new Error('Sign in required.');
    const token = await user.getIdToken();
    const res = await fetch('/api/friends/respond', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ friendshipId, action }),
    });
    const data = await readApiJson<{ ok: boolean }>(res);
    await refreshFriends();
    return data;
  };

  const searchUsers = useCallback(async (queryText: string, recommendations = false): Promise<FriendSearchUser[]> => {
    if (!user || (!recommendations && !queryText.trim())) return [];
    const token = await user.getIdToken();
    const res = await fetch(`/api/friends/search?q=${encodeURIComponent(queryText.trim())}&recommendations=${recommendations}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await readApiJson<{ users?: FriendSearchUser[] }>(res);
    if (!Array.isArray(data.users)) throw new Error('The server returned invalid Patcher search results.');
    return data.users;
  }, [user]);

  const acceptedFriends = friends.filter((f) => f.status === 'accepted');
  const incomingRequests = friends.filter(
    (f) => f.status === 'pending' && f.direction === 'incoming'
  );
  const outgoingRequests = friends.filter(
    (f) => f.status === 'pending' && f.direction === 'outgoing'
  );

  return {
    friends,
    acceptedFriends,
    incomingRequests,
    outgoingRequests,
    loading,
    error,
    refreshFriends,
    sendFriendRequest,
    respondToFriend,
    searchUsers,
  };
}

export function useNotifications(user: User | null) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user || !db) {
      setNotifications([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const path = `notifications/${user.uid}/items`;
    const q = query(
      collection(db, 'notifications', user.uid, 'items'),
      where('uid', '==', user.uid),
      where('type', 'in', [...COMMUNITY_NOTIFICATION_TYPES]),
      limit(30)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as NotificationRecord)
          .filter(n => isCommunityNotification(n.type))
          .sort((a, b) => {
            const aMs = a.createdAt?.toMillis?.() ?? 0;
            const bMs = b.createdAt?.toMillis?.() ?? 0;
            return bMs - aMs;
          });
        setNotifications(items);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );

    return () => unsub();
  }, [user]);

  const markRead = async (notificationId: string) => {
    if (!user || !db) return;
    const docPath = `notifications/${user.uid}/items/${notificationId}`;
    try {
      await updateDoc(doc(db, 'notifications', user.uid, 'items', notificationId), {
        read: true,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, docPath);
    }
  };

  const markAllRead = async () => {
    if (!user) return;
    const token = await user.getIdToken();
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ all: true }),
    });
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, unreadCount, loading, markRead, markAllRead };
}

export function useActivityFeed() {
  const [events, setEvents] = useState<ActivityFeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(()=>{let active=true;const load=async()=>{if(document.visibilityState==='hidden')return;try{const r=await fetch('/api/community/activity');if(!r.ok)throw new Error();const d=await r.json();if(active)setEvents(d.items||[]);}catch{/* retry on next refresh */}finally{if(active)setLoading(false);}};void load();const timer=window.setInterval(load,60000);return()=>{active=false;window.clearInterval(timer);};},[]);

  return { events, loading };
}

export function useAchievements(user: User | null) {
  const [badges, setBadges] = useState<AchievementBadgeRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!user || !db) {
      setBadges([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    user
      .getIdToken()
      .then((token) =>
        fetch('/api/achievements/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
      .then((res) => res.json())
      .then((data: { badges?: AchievementBadgeRecord[] }) => {
        if (Array.isArray(data.badges)) {
          setBadges(data.badges);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    const path = `achievements/${user.uid}/badges`;
    const q = query(
      collection(db, 'achievements', user.uid, 'badges'),
      where('uid', '==', user.uid),
      limit(20)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        if (!snap.empty) {
          const items = snap.docs
            .map((d) => d.data() as AchievementBadgeRecord)
            .sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || a.target - b.target);
          setBadges(items);
        }
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, path);
      }
    );

    return () => unsub();
  }, [user]);

  return { badges, loading };
}

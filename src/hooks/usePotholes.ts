import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { PotholeRecord, PotholeSubmission } from '../lib/maps';

export function useCommunityPotholes() {
  const [potholes, setPotholes] = useState<PotholeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(
      collection(db, 'potholes'),
      where('status', '!=', 'rejected'),
      limit(150)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as PotholeRecord)
          .sort((a, b) => {
            const aMs = a.createdAt?.toMillis?.() ?? 0;
            const bMs = b.createdAt?.toMillis?.() ?? 0;
            return bMs - aMs;
          });
        setPotholes(items);
        setLoading(false);
        setError(null);
      },
      (err) => {
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Unable to load community potholes.');
        handleFirestoreError(err, OperationType.LIST, 'potholes');
      }
    );

    return () => unsub();
  }, []);

  return { potholes, loading, error };
}

export function useMySubmissions(uid: string | null) {
  const [submissions, setSubmissions] = useState<PotholeSubmission[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!uid) {
      setSubmissions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(
      collection(db, 'submissions'),
      where('userId', '==', uid),
      limit(50)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const items = snap.docs
          .map((d) => d.data() as PotholeSubmission)
          .sort((a, b) => {
            const aMs = a.createdAt?.toMillis?.() ?? 0;
            const bMs = b.createdAt?.toMillis?.() ?? 0;
            return bMs - aMs;
          });
        setSubmissions(items);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, 'submissions');
      }
    );

    return () => unsub();
  }, [uid]);

  return { submissions, loading };
}

import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { PotholeRecord, PotholeSubmission } from '../lib/maps';

export function useCommunityPotholes() {
  const [potholes, setPotholes] = useState<PotholeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(()=>{let active=true;const load=async()=>{if(document.visibilityState==='hidden')return;try{const r=await fetch('/api/community/potholes');if(!r.ok)throw new Error('Unable to load map.');const d=await r.json();if(active){setPotholes(d.items||[]);setError(null);}}catch{if(active)setError('Unable to load community potholes.');}finally{if(active)setLoading(false);}};void load();const timer=window.setInterval(load,30000);document.addEventListener('visibilitychange',load);return()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',load);};},[]);

  return { potholes, loading, error };
}

export function useMySubmissions(uid: string | null) {
  const [submissions, setSubmissions] = useState<PotholeSubmission[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!uid || !db) {
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

import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { MyCaseItem } from '../lib/maps';

export type CasesLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

async function authedPost(
  user: User,
  url: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const token = await user.getIdToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 503) throw new Error('Case tracking is unavailable in this environment.');
  if (!res.ok) throw new Error(String(data.error || 'Request failed.'));
  return data;
}

export const logCase = (user: User, body: Record<string, unknown>) =>
  authedPost(user, '/api/cases/log', body);
export const saveCaseDeadline = (user: User, body: Record<string, unknown>) =>
  authedPost(user, '/api/cases/deadline', body);
export const saveCaseFollowUp = (user: User, body: Record<string, unknown>) =>
  authedPost(user, '/api/cases/followup', body);

/** Loads the signed-in user's own ATL311 / GDOT cases from the server. */
export function useCases(user: User | null) {
  const [cases, setCases] = useState<MyCaseItem[]>([]);
  const [state, setState] = useState<CasesLoadState>('idle');
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!user) {
      setCases([]);
      setState('idle');
      return;
    }
    setState((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/cases/mine', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 503) {
        setCases([]);
        setState('unavailable');
        setError(null);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { cases?: MyCaseItem[]; error?: string };
      if (!res.ok) {
        setState('error');
        setError(data.error || 'Unable to load your cases.');
        return;
      }
      setCases(Array.isArray(data.cases) ? data.cases : []);
      setState('ready');
      setError(null);
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'Network error.');
    }
  }, [user]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { cases, state, error, refetch };
}

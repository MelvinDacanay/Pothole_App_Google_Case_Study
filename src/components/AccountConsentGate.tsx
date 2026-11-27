import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import type { User } from 'firebase/auth';
import { readApiJson } from '../lib/apiResponse';

const VERSION = '2026-11-27-v2';
const statements = [
  'I am at least 18 years old.',
  'I understand that Gemini will be used to assess and verify if a photo uploaded is appropriate. I will avoid including sensitive information or other personal details.',
] as const;

type Status = 'loading' | 'required' | 'accepted' | 'error';
export function AccountConsentGate({user, signOut, children}: {user: User; signOut: () => Promise<void>; children: ReactNode}) {
  const [status, setStatus] = useState<Status>('loading');
  const [age, setAge] = useState(false);
  const [consent, setConsent] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const ageRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading'); setError('');
    (async () => {
      try {
        const token = await user.getIdToken();
        const response = await fetch('/api/auth/consent', {headers:{Authorization:`Bearer ${token}`}, signal:controller.signal, cache:'no-store'});
        const data = await readApiJson<{accepted:boolean;version:string}>(response);
        if (controller.signal.aborted) return;
        if (data.version !== VERSION || typeof data.accepted !== 'boolean') throw new Error('Consent version mismatch. Reload the app and try again.');
        setStatus(data.accepted ? 'accepted' : 'required');
      } catch (err) {
        if (!controller.signal.aborted) { setError(err instanceof Error ? err.message : 'Unable to load confirmations.'); setStatus('error'); }
      }
    })();
    return () => controller.abort();
  }, [user, retry]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (status === 'required' && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [status]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setAttempted(true); setError('');
    if (!age || !consent) { (!age ? ageRef : consentRef).current?.focus(); return; }
    if (saving) return;
    setSaving(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/auth/consent', {method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify({ageConfirmed:age,aiConsent:consent,version:VERSION})});
      const data = await readApiJson<{accepted:boolean;version:string}>(response);
      if (data.accepted !== true || data.version !== VERSION) throw new Error('Your confirmations were not saved. Please retry.');
      if (active.current) setStatus('accepted');
    } catch (err) { if (active.current) setError(err instanceof Error ? err.message : 'Unable to save confirmations.'); }
    finally { if (active.current) setSaving(false); }
  }
  const leave = async () => { try { await signOut(); } catch { setError('Unable to sign out. Please try again.'); } };
  if (status === 'accepted') return <>{children}</>;
  return <div className="min-h-dvh flex items-center justify-center bg-[#F4F0E5] p-4">
    {status === 'loading' && <div role="status" className="text-[#17231D] text-sm">Checking your account…</div>}
    {status === 'error' && <section className="max-w-md rounded-2xl border border-[#b6ac98] bg-[#fffaf0] p-6 space-y-4"><h1 className="font-display text-xl">Unable to check your account</h1><p role="alert">{error}</p><button className="min-h-11 px-4 rounded-xl bg-[#17231D] text-white" onClick={()=>setRetry(n=>n+1)}>Try again</button><button className="min-h-11 px-4 underline" onClick={()=>void leave()}>Sign out</button></section>}
    {status === 'required' && <dialog ref={dialogRef} aria-labelledby="consent-title" onCancel={e=>e.preventDefault()} className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl border-2 border-[#17231D] bg-[#fffaf0] p-6 sm:p-8 text-[#17231D] shadow-xl backdrop:bg-[#17231D]/65">
      <form onSubmit={submit} className="space-y-5">
        <img src="/patchup-logo.png" alt="PatchUp" className="w-20 h-auto" />
        <div><p className="text-xs font-bold tracking-widest uppercase">Before you get started</p><h1 id="consent-title" className="font-display text-2xl mt-2">Welcome to PatchUp</h1><p className="text-sm mt-2">Please confirm both statements to access the app.</p><p className="text-sm mt-2">We remove embedded photo metadata before saving or using Gemini. You confirm the pothole’s location separately. Approved images and road locations are public and may be shared with ATL311; your account details and notes are not included in those reports. Location is requested only when needed. <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="underline">Privacy notice</a></p></div>
        {([age,consent] as const).map((checked,i)=> <label key={i} className={`flex items-start gap-3 rounded-xl border p-3 text-sm leading-relaxed cursor-pointer ${attempted&&!checked?'border-red-600 text-red-700 bg-red-50':'border-[#b6ac98]'}`}>
          <input ref={i===0?ageRef:consentRef} type="checkbox" checked={checked} onChange={e=>i===0?setAge(e.target.checked):setConsent(e.target.checked)} disabled={saving} aria-invalid={attempted&&!checked} className="mt-1 h-5 w-5 shrink-0 accent-[#17231D]" />
          <span>{statements[i]}</span>
        </label>)}
        {attempted && (!age || !consent) && <p role="alert" className="text-sm font-semibold text-red-700">Please select both checkboxes to continue.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={saving} className="w-full min-h-11 rounded-xl bg-[#17231D] text-white font-bold px-4 py-3 disabled:opacity-60">{saving?'Saving…':'Continue to PatchUp'}</button>
        <button type="button" disabled={saving} onClick={()=>void leave()} className="w-full min-h-11 text-sm underline">Sign out</button>
      </form>
    </dialog>}
  </div>;
}

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ProtectedImage } from '../components/ProtectedImage';
import { ADMIN_SECTIONS, adminActivityLabel, adminDate, adminDraftWarning, adminReportStatus, adminRoadOwner, type AdminSection } from '../lib/adminLabels';

type Item = {
  id: string; streetName?: string; formattedAddress?: string; mediaId?: string;
  lat?: number; lng?: number; aiSummary?: string; targetPotholeId?: string; candidatePotholeIds?: string[];
  status?: string; jurisdiction?: string; distinctPotholeCount?: number;
  externalReference?: string; submissionChannel?: string;
  action?: string; reason?: string; afterSummary?: string; createdAt?: number | null;
};
type Draft = {
  reportId: string; status: string; from: string; to: string; subject: string; body: string;
  warnings: string[]; attachments: { number: number; filename: string; url: string | null; lat: number; lng: number }[];
};
type Queue = { items: Item[]; nextCursor: string | null };
type ReportStatus = 'ready_for_submission' | 'submitted' | 'acknowledged' | 'resolved' | 'unable_to_submit';
const btn = 'min-h-[44px] px-4 py-2 border border-[#17231d] rounded-md font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2';
const primary = btn + ' bg-[#17231d] text-white';
const field = 'mt-1 block w-full rounded-md border border-[#b6ac98] p-3 bg-white text-sm';
const panel = 'border border-[#17231d] rounded-md bg-white p-4 sm:p-5 space-y-3';
const coordinates = (item: Item) => typeof item.lat === 'number' && typeof item.lng === 'number' && Number.isFinite(item.lat) && Number.isFinite(item.lng) ? `${item.lat.toFixed(6)}, ${item.lng.toFixed(6)}` : 'Location coordinates unavailable';

export function AdminHubView() {
  const { user, isAdmin } = useAuth();
  const [section, setSection] = useState<AdminSection>('reviews');
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [caseReference, setCaseReference] = useState('');
  const [channel, setChannel] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reviewPhotoLoaded, setReviewPhotoLoaded] = useState(false);
  const [pendingReportAction, setPendingReportAction] = useState<{ id: string; status: 'acknowledged' | 'resolved' | 'unable_to_submit'; question: string } | null>(null);
  const generation = useRef(0);
  const detailRef = useRef<HTMLElement>(null);
  const active = ADMIN_SECTIONS.find(tab => tab.id === section)!;

  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    if (!user || !isAdmin) throw new Error('Not authorized');
    const token = await user.getIdToken();
    const response = await fetch(path, { ...options, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Not authorized' : 'Request failed');
    return await response.json() as T;
  }
  function closeDetails() {
    setDraft(null); setSelected(null); setReason(''); setCaseReference(''); setChannel(''); setConfirmed(false); setReviewPhotoLoaded(false); setPendingReportAction(null);
  }
  async function load(next: AdminSection, after?: string) {
    const g = ++generation.current;
    setBusy(true); setError('');
    if (!after) { setItems([]); setCursor(null); closeDetails(); }
    try {
      const result = await api<Queue>(`/api/admin/hub/${next}${after ? '?cursor=' + encodeURIComponent(after) : ''}`);
      if (g !== generation.current) return;
      setItems(old => after ? [...old, ...result.items] : result.items);
      setCursor(result.nextCursor);
    } catch {
      if (g === generation.current) setError('We couldn’t load this list. Please refresh and try again. If the problem continues, contact the PatchUp team.');
    } finally { if (g === generation.current) setBusy(false); }
  }
  useEffect(() => {
    if (user && isAdmin) void load(section);
    return () => { generation.current++; };
  }, [section, user, isAdmin]);
  useEffect(() => { if (draft || selected) detailRef.current?.focus(); }, [draft, selected]);
  async function openDraft(item: Item) {
    const g = ++generation.current;
    setBusy(true); setError(''); setNotice(''); closeDetails();
    try {
      const result = await api<Draft>('/api/admin/email-drafts/' + encodeURIComponent(item.id));
      if (g === generation.current) { setSelected(item); setDraft(result); }
    } catch { if (g === generation.current) setError('This email draft could not be opened. Refresh the list and try again.'); }
    finally { if (g === generation.current) setBusy(false); }
  }
  function openItem(item: Item) { closeDetails(); setSelected(item); setNotice(''); setError(''); }
  async function save(path: string, payload: Record<string, unknown>, message: string) {
    if (busy) return;
    const g = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ alreadyResolved?: boolean }>(path, { method: 'POST', body: JSON.stringify(payload) });
      if (g !== generation.current) return;
      setNotice(result.alreadyResolved ? 'Another administrator has already reviewed this photo. The list has been refreshed.' : message);
      await load(section);
    } catch {
      if (g === generation.current) setError('We couldn’t confirm that your change was saved. Refresh to check the latest status before trying again. If the problem continues, contact the PatchUp team.');
    } finally { if (g === generation.current) setBusy(false); }
  }
  function resolve(resolution: 'confirm_distinct' | 'reject') {
    if (!selected || !reason.trim() || busy) return;
    if (resolution === 'confirm_distinct' && (!reviewPhotoLoaded || ((selected.targetPotholeId || selected.candidatePotholeIds?.length) && !confirmed))) return;
    void save('/api/submissions/' + encodeURIComponent(selected.id) + '/resolve', { resolution, reason: reason.trim() }, resolution === 'confirm_distinct' ? 'Photo approved. Thank you for reviewing it!' : 'Photo rejected.');
  }
  function updateReport(id: string, status: ReportStatus) {
    const descriptions: Record<ReportStatus, string> = {
      ready_for_submission: 'Administrator reviewed the email and marked it ready to submit',
      submitted: 'Administrator confirmed the report was submitted outside PatchUp',
      acknowledged: 'Administrator confirmed an agency response',
      resolved: 'Administrator confirmed the agency case was resolved',
      unable_to_submit: 'Administrator recorded that the report could not be submitted',
    };
    const messages: Record<ReportStatus, string> = {
      ready_for_submission: 'Report marked ready. No email was sent.', submitted: 'External submission recorded. No email was sent by PatchUp.',
      acknowledged: 'Agency response recorded.', resolved: 'Agency case marked resolved. Individual pothole repair status is unchanged.', unable_to_submit: 'Report marked as not submitted.',
    };
    if (busy || (status === 'submitted' && (!confirmed || !caseReference.trim() || !channel))) return;
    if (status === 'ready_for_submission' && (!draft || draft.warnings.length || draft.attachments.length !== 5)) return;
    const payload: Record<string, unknown> = { status, reason: descriptions[status] };
    if (status === 'submitted') { payload.externalReference = caseReference.trim(); payload.submissionChannel = channel; }
    void save('/api/admin/reports/' + encodeURIComponent(id) + '/status', payload, messages[status]);
  }
  if (!user || !isAdmin) return null;
  const renderImage = (item: Item, full = false) => item.mediaId ? <ProtectedImage key={item.mediaId} onLoad={full && section === 'reviews' ? () => setReviewPhotoLoaded(true) : undefined} onError={full && section === 'reviews' ? () => setReviewPhotoLoaded(false) : undefined} src={'/api/media/' + encodeURIComponent(item.mediaId)} alt="Pothole photograph" className={full ? 'w-full max-h-[500px] object-contain bg-[#f4f0e5]' : 'w-full h-44 object-contain bg-[#f4f0e5]'} /> : <p className="text-sm">Photo unavailable.</p>;
  const possibleDuplicate = !!(selected?.targetPotholeId || selected?.candidatePotholeIds?.length);
  const confirmationPanel = pendingReportAction && <div className="border border-amber-700 bg-amber-50 p-3 rounded-md space-y-3" role="group" aria-label="Confirm status change">
    <p className="text-sm font-semibold">{pendingReportAction.question}</p>
    <div className="flex flex-wrap gap-2"><button className={primary} disabled={busy} onClick={() => { const action = pendingReportAction; setPendingReportAction(null); updateReport(action.id, action.status); }}>Yes, confirm</button><button className={btn} disabled={busy} onClick={() => setPendingReportAction(null)}>Cancel</button></div>
  </div>;

  return <section className="max-w-5xl mx-auto space-y-5 text-[#17231d]">
    <header className="border-b-2 border-[#17231d] pb-4">
      <p className="text-xs font-bold tracking-widest uppercase">Community management</p>
      <h1 className="font-display text-4xl font-bold uppercase">Admin Hub</h1>
      <p className="text-sm mt-2">Help keep PatchUp accurate, reliable, and useful for Atlanta residents.</p>
    </header>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Admin sections">
      {ADMIN_SECTIONS.map(tab => <button key={tab.id} className={btn + (section === tab.id ? ' bg-[#17231d] text-white' : ' bg-white')} aria-pressed={section === tab.id} disabled={busy} onClick={() => { if (section !== tab.id) { setNotice(''); setError(''); closeDetails(); setItems([]); setCursor(null); setSection(tab.id); } }}>{tab.label}</button>)}
    </div>
    <div className="flex flex-wrap justify-between items-start gap-3">
      <div className="flex-1 min-w-[200px]"><h2 className="text-xl font-bold">{active.label}</h2><p className="text-sm mt-1">{active.description}</p></div>
      <button className={btn} disabled={busy} onClick={() => { setNotice(''); void load(section); }}>Refresh</button>
    </div>
    {error && <p role="alert" className="border border-red-700 p-3 text-red-800 bg-white">{error}</p>}
    {notice && <p role="status" className="border border-[#246b28] bg-green-50 p-3">{notice}</p>}
    {busy && <p role="status">Please wait…</p>}
    {!busy && !items.length && !error && <p className={panel}>{active.empty}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map(item => <article key={item.id} className={panel}>
        {section === 'history' ? <><h3 className="font-bold">{adminActivityLabel(item.action, item.afterSummary)}</h3><p className="text-sm text-[#536159]">{adminDate(item.createdAt)}</p>{item.reason && (item.action === 'submission_review' || item.action === 'pothole_review') && <p className="text-sm break-words">{item.reason}</p>}</> : <>
          <h3 className="font-bold text-lg break-words">{item.streetName || 'Street not confirmed'}</h3>
          {section === 'reviews' || section === 'repairs' ? <>
            <p className="text-sm">{item.formattedAddress || coordinates(item)}</p>{renderImage(item)}
            {section === 'reviews' && <><p className="text-sm">{item.aiSummary || 'The automatic photo check did not provide an explanation.'}</p>{(item.targetPotholeId || !!item.candidatePotholeIds?.length) && <p className="text-sm text-amber-900">This may be a photo of a pothole already on the map.</p>}</>}
            <button className={primary} disabled={busy} onClick={() => openItem(item)}>{section === 'reviews' ? 'Review photo' : 'Check repair'}</button>
          </> : <>
            <p className="text-sm">{item.distinctPotholeCount ?? 'Unknown number of'} potholes recorded</p>
            <p className="text-sm font-semibold">{adminReportStatus(item.status)}</p>
            <p className="text-sm text-[#536159]">{adminRoadOwner(item.jurisdiction)}</p>
            {section === 'drafts' ? <button className={primary} disabled={busy} onClick={() => void openDraft(item)}>Review email</button> : <>
              <p className="text-sm break-words">Agency reference: {item.externalReference || 'Not recorded'}</p>
              {item.submissionChannel && <p className="text-sm break-words">Submitted via: {item.submissionChannel}</p>}
              <button className={btn} disabled={busy} onClick={() => openItem(item)}>View report status</button>
            </>}
          </>}
        </>}
      </article>)}
    </div>
    {cursor && <button className={btn} disabled={busy} onClick={() => void load(section, cursor)}>Load more</button>}

    {section === 'reviews' && selected && <section ref={detailRef} tabIndex={-1} className="border-2 border-[#17231d] bg-[#f4f0e5] p-5 space-y-4" aria-label="Review photo">
      <div className="flex justify-between gap-3"><h2 className="text-xl font-bold">Review photo: {selected.streetName || 'Street not confirmed'}</h2><button className={btn} disabled={busy} onClick={closeDetails}>Close</button></div>
      {renderImage(selected, true)}{!reviewPhotoLoaded && <p className="text-sm text-amber-900">Wait for the photo to appear before approving it. If it is missing, refresh or ask the PatchUp team for help.</p>}<p className="text-sm">{selected.formattedAddress}<br />{coordinates(selected)}</p>
      <h3 className="font-bold">Why this needs review</h3><p>{selected.aiSummary || 'The automatic photo check could not approve this photo.'}</p>
      <p className="text-sm">Does this photo show a real pothole that is not already recorded? Reject non-potholes and repeat submissions.</p>
      {possibleDuplicate && <label className="flex gap-3 items-start bg-amber-50 border border-amber-700 p-3 text-sm"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} /> <span>There may already be a pothole nearby. I checked the community map and confirmed that this is a different pothole.</span></label>}
      <label className="block text-sm font-semibold">Why did you make this decision? (required)<textarea value={reason} onChange={e => setReason(e.target.value)} disabled={busy} maxLength={400} className={field} rows={3} placeholder="For example: A clear hole in the road surface." /></label>
      <div className="flex flex-wrap gap-2"><button className={primary} disabled={busy || !reviewPhotoLoaded || !reason.trim() || (possibleDuplicate && !confirmed)} onClick={() => resolve('confirm_distinct')}>Yes, approve pothole</button><button className={btn + ' text-red-800'} disabled={busy || !reason.trim()} onClick={() => resolve('reject')}>Reject photo</button></div>
    </section>}

    {section === 'drafts' && draft && <section ref={detailRef} tabIndex={-1} className="border-2 border-[#17231d] bg-white p-5 space-y-4" aria-label="Email draft">
      <div className="flex justify-between gap-3"><h2 className="text-xl font-bold">Email preview</h2><button className={btn} disabled={busy} onClick={closeDetails}>Close</button></div>
      <p className="text-sm font-bold">{adminReportStatus(draft.status)} — not sent by PatchUp</p>
      <dl className="text-sm space-y-2 break-words"><div><dt className="font-bold">From</dt><dd>{draft.from || 'Shared email not set up yet'}</dd></div><div><dt className="font-bold">To</dt><dd>{draft.to}</dd></div><div><dt className="font-bold">Subject</dt><dd>{draft.subject}</dd></div></dl>
      {draft.warnings.length > 0 && <div role="status" className="bg-amber-50 border border-amber-700 p-3 space-y-1"><strong>Please check before submitting</strong><ul className="list-disc pl-5 text-sm">{draft.warnings.map((warning, i) => <li key={i}>{adminDraftWarning(warning)}</li>)}</ul></div>}
      <div className="border-y py-4 whitespace-pre-wrap text-sm leading-relaxed">{draft.body.split('About Us:').map((part, i) => <React.Fragment key={i}>{i > 0 && <strong>About Us:</strong>}{part}</React.Fragment>)}</div>
      <h3 className="font-bold">Photos ({draft.attachments.length})</h3><div className="grid gap-3 sm:grid-cols-2">{draft.attachments.map(a => <figure key={a.number} className="border p-2">{a.url ? <ProtectedImage src={a.url} alt={`Pothole ${a.number}`} className="w-full h-56 object-contain bg-[#f4f0e5]" /> : <p>Image unavailable</p>}<figcaption className="text-sm break-words">{a.filename}<br />{a.lat.toFixed(6)}, {a.lng.toFixed(6)}</figcaption></figure>)}</div>
      <div className="border-t pt-4 space-y-3"><h3 className="font-bold">Report submission</h3><p className="text-sm">Email sending is not connected yet. This is only a draft. You can record a report submitted separately to the agency, using its case reference.</p>
        {(draft.status === 'awaiting_admin_review' || draft.status === 'unable_to_submit') && <button className={primary} disabled={busy || !!draft.warnings.length || draft.attachments.length !== 5} onClick={() => updateReport(draft.reportId, 'ready_for_submission')}>Mark ready to send</button>}
        {draft.status === 'ready_for_submission' && <div className="space-y-3">
          <label className="block text-sm font-semibold">Agency case reference (required)<input value={caseReference} onChange={e => setCaseReference(e.target.value)} disabled={busy} maxLength={128} className={field} placeholder="Enter the reference from ATL311 or the agency" /></label>
          <label className="block text-sm font-semibold">How was it submitted? (required)<select className={field} disabled={busy} value={channel} onChange={e => setChannel(e.target.value)}><option value="">Choose a method</option><option>ATL311 online form</option><option>Email</option><option>Phone</option><option>Other agency reporting channel</option></select></label>
          <label className="flex gap-3 items-start text-sm"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />This report has already been submitted outside PatchUp, and the reference is correct.</label>
          <button className={primary} disabled={busy || !confirmed || !caseReference.trim() || !channel} onClick={() => updateReport(draft.reportId, 'submitted')}>Record submission</button>
        </div>}
        {['awaiting_admin_review', 'ready_for_submission'].includes(draft.status) && <button className={btn + ' ml-0 sm:ml-2'} disabled={busy} onClick={() => setPendingReportAction({ id: draft.reportId, status: 'unable_to_submit', question: 'Mark this report as not submitted? It will remain in Email Drafts so you can review it later.' })}>Unable to submit</button>}
        {confirmationPanel}
      </div>
    </section>}

    {section === 'sent' && selected && <section ref={detailRef} tabIndex={-1} className={panel} aria-label="Report status">
      <div className="flex justify-between gap-3"><h2 className="text-xl font-bold">Report: {selected.streetName || 'Street not confirmed'}</h2><button className={btn} disabled={busy} onClick={closeDetails}>Close</button></div>
      <p>{adminReportStatus(selected.status)}</p><p className="text-sm break-words">Agency reference: {selected.externalReference || 'Not recorded'}</p>
      <p className="text-sm">Only change the status after you have received confirmation from the agency. Confirm physical repairs separately in Confirm Repairs.</p>
      {selected.status === 'submitted' && <button className={primary} disabled={busy} onClick={() => setPendingReportAction({ id: selected.id, status: 'acknowledged', question: 'Has the agency confirmed that it received this report?' })}>Record agency response</button>}
      {['submitted', 'acknowledged'].includes(selected.status || '') && <button className={btn} disabled={busy} onClick={() => setPendingReportAction({ id: selected.id, status: 'resolved', question: 'Has the agency confirmed that this case is resolved? This closes the report, but does not mark any individual pothole as repaired.' })}>Mark agency case resolved</button>}
      {confirmationPanel}
    </section>}

    {section === 'repairs' && selected && <section ref={detailRef} tabIndex={-1} className={panel} aria-label="Confirm repair">
      <div className="flex justify-between gap-3"><h2 className="text-xl font-bold">Check repair: {selected.streetName || 'Street not confirmed'}</h2><button className={btn} disabled={busy} onClick={closeDetails}>Close</button></div>
      {renderImage(selected, true)}<p className="text-sm">Original pothole photo, not proof of a repair.</p><p>{selected.formattedAddress}<br />{coordinates(selected)}</p>
      <label className="flex gap-3 items-start text-sm"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I have reliable evidence that this specific pothole has been repaired.</label>
      <label className="block text-sm font-semibold">How was the repair confirmed? (required)<textarea className={field} rows={3} maxLength={400} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} placeholder="For example: I visited the location and confirmed the repair." /></label>
      <button className={primary} disabled={busy || !confirmed || !reason.trim()} onClick={() => void save('/api/admin/potholes/' + encodeURIComponent(selected.id) + '/review', { status: 'repaired', reason: reason.trim() }, 'Repair confirmed. Thank you for updating the community.')}>Confirm repaired</button>
    </section>}
  </section>;
}

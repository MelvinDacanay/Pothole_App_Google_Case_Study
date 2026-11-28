import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ClipboardCopy,
  ExternalLink,
  Loader2,
  Mail,
  Phone,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { saveCaseFollowUp, useCases } from '../hooks/useCases';
import { resolveAgency } from '../lib/agencyDirectory';
import {
  buildEscalationMessage,
  ESCALATION_REASONS,
  MS_PER_DAY,
  reasonKind,
  type EscalationReasonId,
} from '../../server/cases';
import { caseStatusLabel, elapsedSince, formatDate, formatDateTime, potholeStatusLabel } from '../lib/caseFormat';

interface EscalateViewProps {
  caseId: string;
  onBack: () => void;
}

// ATL311 knowledge/contact pages — reference material, NOT an escalation form.
const ATL311_KB_URL = 'https://www.atl311.com/en-US/knowledgearticle/?code=KB10000062';
const ATL311_CONTACT_URL = 'https://www.atl311.com/en-US/contactus/';

export const EscalateView: React.FC<EscalateViewProps> = ({ caseId, onBack }) => {
  const { user } = useAuth();
  const { cases, state, refetch } = useCases(user);
  const c = cases.find((x) => x.caseId === caseId);

  const nowMillis = Date.now();
  const [reasonId, setReasonId] = useState<EscalationReasonId>('status_update');
  const [draft, setDraft] = useState('');
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState('');
  const [newReference, setNewReference] = useState('');
  const [evidenceNotes, setEvidenceNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const officialStatusKnown = useMemo(() => {
    if (!c) return null;
    if (c.status === 'resolved') return 'The agency told me it closed this case.';
    if (c.status === 'acknowledged') return 'The agency acknowledged this case.';
    return null; // Never invent an agency status.
  }, [c]);

  const elapsedDays = useMemo(() => {
    if (!c?.submittedAtMillis) return null;
    return Math.floor(Math.max(0, nowMillis - c.submittedAtMillis) / MS_PER_DAY);
  }, [c, nowMillis]);

  // Regenerate the editable draft from verified fields whenever reason/case change.
  const regenerate = useMemo(() => {
    if (!c) return '';
    const reason = ESCALATION_REASONS.find((r) => r.id === reasonId);
    return buildEscalationMessage({
      potholeId: c.potholeId,
      externalCaseRef: c.externalCaseRef,
      submittedAtISO: c.submittedAtMillis ? formatDate(c.submittedAtMillis) : null,
      confirmedSubmission: Boolean(c.submittedAtMillis),
      streetName: c.streetName,
      formattedAddress: c.formattedAddress,
      lat: c.lat,
      lng: c.lng,
      notes: c.notes,
      officialStatusKnown,
      patchupStatus: caseStatusLabel(c.status),
      potholeStatus: c.potholeStatus ? potholeStatusLabel(c.potholeStatus) : null,
      reasonLabel: reason?.label,
      elapsedDays,
      photoUrls: c.primaryPhotoUrl ? [c.primaryPhotoUrl] : [],
    });
  }, [c, reasonId, officialStatusKnown, elapsedDays]);

  useEffect(() => {
    setDraft(regenerate);
    if (c) setSubject(`Pothole repair follow-up — ${c.externalCaseRef || c.potholeId}`);
  }, [regenerate, c]);

  if (state === 'loading' || state === 'idle') {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center text-sm text-[#6E6978]">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3 text-[#4CB729]" />
        Loading case…
      </div>
    );
  }

  if (!c) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <BackButton onBack={onBack} />
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-10 text-center">
          <AlertTriangle className="w-8 h-8 text-[#6E6978] mx-auto mb-2" />
          <p className="text-sm text-[#6E6978]">
            This case isn’t available{state === 'unavailable' ? ' (server database offline here)' : ''}.
          </p>
        </div>
      </div>
    );
  }

  const { agency, confirmed } = resolveAgency(c.jurisdiction);
  const isAtl311 = agency.key === 'atl311';
  const kind = reasonKind(reasonId);

  const record = async (key: string, action: string, extra: Record<string, unknown> = {}) => {
    if (!user) return;
    setBusy(key);
    setActionError(null);
    try {
      await saveCaseFollowUp(user, { caseId: c.caseId, reasonId, action, ...extra });
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not save that follow-up.');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setActionError('Copy failed — your browser blocked clipboard access.');
    }
    // Copying is only ever "contact initiated", never an agency confirmation.
    await record(`copy-${key}`, 'copy');
  };

  const openUrl = (key: string, url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    void record(key, 'open_link');
  };

  const openGmail = () => {
    const params = new URLSearchParams({ view: 'cm', fs: '1', su: subject, body: draft });
    if (recipient.trim()) params.set('to', recipient.trim());
    window.open(`https://mail.google.com/mail/?${params.toString()}`, '_blank', 'noopener,noreferrer');
    void record('gmail', 'open_gmail');
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <BackButton onBack={onBack} />

      {/* Case facts — verified only */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-[#e7421e]" />
          <h1 className="font-display text-xl font-bold text-[#2D2B35]">Follow up on this case</h1>
        </div>
        <div className="flex gap-4">
          {c.primaryPhotoUrl && (
            <img
              src={c.primaryPhotoUrl}
              alt={`Pothole on ${c.streetName}`}
              className="w-24 h-24 rounded-xl object-cover border border-[#E8DFC5] shrink-0"
            />
          )}
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-[#2D2B35] truncate">{c.streetName || 'Unverified street'}</div>
            <div className="text-[#6E6978] truncate">{c.formattedAddress}</div>
            <div className="font-mono text-xs text-[#2D2B35] mt-1 tabular-nums">
              {c.lat.toFixed(5)}, {c.lng.toFixed(5)}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <Fact label="Official case number" value={c.externalCaseRef || 'Not logged yet'} />
          <Fact
            label="Confirmed submission"
            value={c.submittedAtMillis ? formatDateTime(c.submittedAtMillis) : 'Not confirmed'}
          />
          <Fact
            label="Recorded completion date"
            value={c.expectedCompletionAtMillis ? formatDate(c.expectedCompletionAtMillis) : 'Official deadline unavailable'}
          />
          <Fact
            label="Days since reported"
            value={elapsedDays !== null ? `${elapsedDays} (${elapsedSince(c.submittedAtMillis, nowMillis)})` : '—'}
          />
        </dl>

        <div className="space-y-2 text-xs">
          <StatusLine label="Official agency status" value={officialStatusKnown || 'No agency status logged'} />
          <StatusLine label="PatchUp workflow status" value={caseStatusLabel(c.status)} />
          <StatusLine label="Physical repair (PatchUp evidence)" value={potholeStatusLabel(c.potholeStatus)} />
        </div>
      </div>

      {/* Reason */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-3">
        <h2 className="font-display text-lg font-bold text-[#2D2B35]">Why are you following up?</h2>
        <div className="space-y-2">
          {ESCALATION_REASONS.map((r) => (
            <label
              key={r.id}
              className={`flex items-start gap-3 rounded-xl border p-3 cursor-pointer ${
                reasonId === r.id ? 'border-[#4CB729] bg-[#4CB729]/5' : 'border-[#E8DFC5]'
              }`}
            >
              <input
                type="radio"
                name="reason"
                checked={reasonId === r.id}
                onChange={() => setReasonId(r.id)}
                className="mt-0.5 accent-[#4CB729]"
              />
              <span className="text-sm text-[#2D2B35]">
                {r.label}
                {r.kind === 'overdue' && (
                  <span className="ml-2 text-[11px] font-semibold text-[#B45309]">overdue path</span>
                )}
              </span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-[#6E6978]">
          This will be saved as {kind === 'overdue' ? 'an overdue follow-up' : 'an ordinary follow-up'}.
        </p>
      </div>

      {/* Draft */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">Your message</h2>
          <button
            type="button"
            onClick={() => setDraft(regenerate)}
            className="text-xs font-semibold text-[#536159] hover:text-[#2D2B35] min-h-[44px] px-2"
          >
            Reset to verified fields
          </button>
        </div>
        <p className="text-[11px] text-[#6E6978]">
          Built from fields PatchUp can verify. Edit freely — nothing here is sent automatically, and
          PatchUp never adds a government email address or a fake agency reply.
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          className="w-full rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-3 text-xs font-mono text-[#2D2B35] leading-relaxed"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void copy('draft', draft)}
            disabled={busy === 'copy-draft'}
            className="min-h-[44px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {copied === 'draft' ? <Check className="w-4 h-4 text-[#4CB729]" /> : <ClipboardCopy className="w-4 h-4" />}
            Copy message
          </button>
          {c.externalCaseRef && (
            <button
              type="button"
              onClick={() => void copy('ref', c.externalCaseRef!)}
              className="min-h-[44px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold inline-flex items-center gap-2"
            >
              {copied === 'ref' ? <Check className="w-4 h-4 text-[#4CB729]" /> : <ClipboardCopy className="w-4 h-4" />}
              Copy case number
            </button>
          )}
        </div>
      </div>

      {/* Contact channels */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <h2 className="font-display text-lg font-bold text-[#2D2B35]">Contact {agency.shortName}</h2>
        {!confirmed && (
          <p className="text-[11px] text-[#B45309] bg-[#D97706]/10 border border-[#D97706]/30 rounded-lg px-3 py-2">
            This street’s maintaining agency isn’t confirmed. Double-check whether it’s a City of
            Atlanta or state (GDOT) road before you contact anyone.
          </p>
        )}

        {/* Portal + reference pages */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => openUrl('portal', agency.portalUrl)}
            className="w-full sm:w-auto min-h-[44px] px-4 rounded-xl bg-[#2D2B35] text-white text-sm font-semibold inline-flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" /> Open {agency.portalLabel}
          </button>
          {isAtl311 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => openUrl('kb', ATL311_KB_URL)}
                className="min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#536159] text-xs font-semibold inline-flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" /> ATL311 help article
              </button>
              <button
                type="button"
                onClick={() => openUrl('contact', ATL311_CONTACT_URL)}
                className="min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#536159] text-xs font-semibold inline-flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" /> ATL311 contact page
              </button>
            </div>
          )}
          <p className="text-[11px] text-[#6E6978]">
            These are {agency.shortName} reference pages, not a PatchUp escalation form. Opening a link
            only records “contact initiated” — it does not submit anything or confirm a reply.
          </p>
        </div>

        {/* Phone */}
        <div className="rounded-xl border border-[#E8DFC5] p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2D2B35]">
            <Phone className="w-4 h-4 text-[#536159]" /> Phone
          </div>
          <a
            href={`tel:${agency.phonePrimary}`}
            onClick={() => void record('phone', 'open_phone')}
            className="text-sm text-[#4CB729] font-semibold"
          >
            Call {agency.phonePrimary}
          </a>
          {agency.phoneNote && <p className="text-[11px] text-[#6E6978] mt-0.5">{agency.phoneNote}</p>}
        </div>

        {/* Email */}
        <div className="rounded-xl border border-[#E8DFC5] p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#2D2B35]">
            <Mail className="w-4 h-4 text-[#536159]" /> Email
          </div>
          <p className="text-[11px] text-[#6E6978]">
            Enter the recipient yourself — PatchUp won’t guess a government email address. Gmail opens
            with your draft but can’t attach photos; attach them manually.
          </p>
          <input
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="recipient@email (you type this)"
            className="w-full min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35]"
          />
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="w-full min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35]"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void copy('email', `Subject: ${subject}\n\n${draft}`)}
              className="min-h-[44px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold inline-flex items-center gap-2"
            >
              {copied === 'email' ? <Check className="w-4 h-4 text-[#4CB729]" /> : <ClipboardCopy className="w-4 h-4" />}
              Copy email
            </button>
            <button
              type="button"
              onClick={openGmail}
              disabled={!recipient.trim()}
              className="min-h-[44px] px-4 rounded-xl bg-[#e7421e] hover:bg-[#ff5833] text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
            >
              <Mail className="w-4 h-4" /> Open Gmail
            </button>
          </div>
        </div>
      </div>

      {/* New evidence notes (for worsening) */}
      {reasonId === 'worsening' && (
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-2">
          <label className="text-sm font-bold text-[#2D2B35]">Describe the worsening damage</label>
          <textarea
            value={evidenceNotes}
            onChange={(e) => setEvidenceNotes(e.target.value)}
            rows={3}
            className="w-full rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-3 text-sm text-[#2D2B35]"
          />
        </div>
      )}

      {/* Confirm + save reference */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <h2 className="font-display text-lg font-bold text-[#2D2B35]">Record what you did</h2>
        {actionError && (
          <p className="text-xs text-[#DC2626] bg-[#DC2626]/10 border border-[#DC2626]/30 rounded-lg px-3 py-2">
            {actionError}
          </p>
        )}

        <div className="space-y-2">
          <button
            type="button"
            onClick={() =>
              void record('sent', 'user_confirmed_sent', reasonId === 'worsening' ? { newEvidenceNotes: evidenceNotes } : {})
            }
            disabled={busy === 'sent'}
            className="w-full sm:w-auto min-h-[44px] px-5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-bold inline-flex items-center gap-2 disabled:opacity-50"
          >
            <Check className="w-4 h-4" /> I sent this follow-up
          </button>
          <p className="text-[11px] text-[#6E6978]">
            Records “contact confirmed by you”. PatchUp doesn’t mark your case as accepted or answered
            — only you can record a reference the agency gives you.
          </p>
        </div>

        <div className="space-y-2 pt-1">
          <label className="text-sm font-bold text-[#2D2B35]">Got a reference back?</label>
          <p className="text-[11px] text-[#6E6978]">
            If the agency gave you a new case/reference number, enter it here. Only then does the case
            read “agency reference recorded”.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newReference}
              onChange={(e) => setNewReference(e.target.value)}
              placeholder="Agency reference number"
              className="flex-1 min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] font-mono"
            />
            <button
              type="button"
              onClick={() => void record('ref', 'save_reference', { newReference }).then(() => setNewReference(''))}
              disabled={!newReference.trim() || busy === 'ref'}
              className="min-h-[44px] px-4 rounded-xl bg-[#2D2B35] text-white text-sm font-semibold disabled:opacity-50"
            >
              Save reference
            </button>
          </div>
        </div>

        {c.followUps.length > 0 && (
          <div className="pt-2 border-t border-[#E8DFC5]">
            <div className="text-xs font-bold text-[#2D2B35] mb-2">Prior follow-ups</div>
            <div className="space-y-1.5">
              {[...c.followUps]
                .sort((a, b) => (b.draftedAtMillis || 0) - (a.draftedAtMillis || 0))
                .map((f) => (
                  <div key={f.followUpId} className="text-[11px] text-[#6E6978] flex justify-between gap-2">
                    <span className="truncate">
                      {f.reasonLabel} · {f.status.replace(/_/g, ' ')}
                    </span>
                    <span className="shrink-0">{formatDateTime(f.draftedAtMillis)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const BackButton: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <button
    type="button"
    onClick={onBack}
    className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-[#536159] hover:text-[#2D2B35]"
  >
    <ArrowLeft className="w-4 h-4" /> Back
  </button>
);

const Fact: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3">
    <dt className="text-[11px] text-[#6E6978]">{label}</dt>
    <dd className="mt-0.5 text-[#2D2B35] font-semibold break-words">{value}</dd>
  </div>
);

const StatusLine: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-start justify-between gap-3 rounded-lg border border-[#E8DFC5] px-3 py-2">
    <span className="text-[#6E6978]">{label}</span>
    <span className="font-semibold text-[#2D2B35] text-right">{value}</span>
  </div>
);

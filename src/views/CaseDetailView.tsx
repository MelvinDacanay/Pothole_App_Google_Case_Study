import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  MapPin,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { logCase, saveCaseDeadline, saveCaseFollowUp, useCases } from '../hooks/useCases';
import { resolveAgency } from '../lib/agencyDirectory';
import { loadMapsClientConfig, MapsClientConfig } from '../lib/maps';
import { CaseLocationMap } from '../components/CaseLocationMap';
import {
  caseStatusLabel,
  deadlineFor,
  elapsedSince,
  formatDate,
  formatDateTime,
  potholeStatusLabel,
} from '../lib/caseFormat';

interface CaseDetailViewProps {
  caseId: string;
  onBack: () => void;
  onEscalate: (caseId: string) => void;
}

export const CaseDetailView: React.FC<CaseDetailViewProps> = ({ caseId, onBack, onEscalate }) => {
  const { user } = useAuth();
  const { cases, state, refetch } = useCases(user);
  const c = cases.find((x) => x.caseId === caseId);

  const [mapsConfig, setMapsConfig] = useState<MapsClientConfig>({
    configured: false,
    apiKey: '',
    mapId: 'DEMO_MAP_ID',
  });
  useEffect(() => {
    loadMapsClientConfig().then(setMapsConfig);
  }, []);

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dateInput, setDateInput] = useState('');
  const [citationInput, setCitationInput] = useState('');
  const [reminderInput, setReminderInput] = useState('');

  const nowMillis = Date.now();
  const deadline = useMemo(() => (c ? deadlineFor(c, nowMillis) : null), [c, nowMillis]);
  const sortedEvents = useMemo(
    () => (c ? [...c.events].sort((a, b) => (b.atMillis || 0) - (a.atMillis || 0)) : []),
    [c]
  );

  if (state === 'loading' || state === 'idle') {
    return (
      <div className="max-w-4xl mx-auto py-16 text-center text-sm text-[#6E6978]">
        <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3 text-[#4CB729]" />
        Loading case…
      </div>
    );
  }

  if (!c) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <BackButton onBack={onBack} />
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-10 text-center space-y-2">
          <AlertTriangle className="w-8 h-8 text-[#6E6978] mx-auto" />
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">Case not found</h2>
          <p className="text-sm text-[#6E6978]">
            This case isn’t available{state === 'unavailable' ? ' (server database offline here)' : ''}.
          </p>
        </div>
      </div>
    );
  }

  const { agency } = resolveAgency(c.jurisdiction);

  const runAction = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const saveDate = () => {
    if (!user || !dateInput) return;
    const millis = new Date(`${dateInput}T00:00:00`).getTime();
    if (!Number.isFinite(millis)) return;
    void runAction('date', () =>
      saveCaseDeadline(user, {
        caseId: c.caseId,
        expectedCompletionAtMillis: millis,
        deadlineCitation: citationInput,
      })
    ).then(() => {
      setDateInput('');
      setCitationInput('');
    });
  };

  const saveReminder = () => {
    if (!user || !reminderInput) return;
    const millis = new Date(reminderInput).getTime();
    if (!Number.isFinite(millis)) return;
    void runAction('reminder', () =>
      saveCaseDeadline(user, { caseId: c.caseId, personalFollowUpAtMillis: millis })
    ).then(() => setReminderInput(''));
  };

  // Official agency status is ONLY what the user has logged — never invented.
  const officialAgencyStatus =
    c.status === 'resolved'
      ? 'You recorded: the agency closed this case.'
      : c.status === 'acknowledged'
        ? 'You recorded: the agency acknowledged this case.'
        : c.externalCaseRef
          ? `Case number on file: ${c.externalCaseRef}. No agency status update logged.`
          : 'No official agency status logged yet.';

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <BackButton onBack={onBack} />

      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold text-[#2D2B35] truncate">
              {c.streetName || 'Unverified street'}
            </h1>
            <p className="text-sm text-[#6E6978] truncate">{c.formattedAddress}</p>
          </div>
          <span className="text-xs font-semibold text-[#536159] bg-[#F7F7F8] border border-[#E8DFC5] rounded-full px-3 py-1.5 whitespace-nowrap shrink-0">
            {caseStatusLabel(c.status)}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {c.primaryPhotoUrl ? (
            <img
              src={c.primaryPhotoUrl}
              alt={`Pothole on ${c.streetName}`}
              className="w-full h-48 rounded-xl object-cover border border-[#E8DFC5]"
            />
          ) : (
            <div className="w-full h-48 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] flex items-center justify-center">
              <MapPin className="w-7 h-7 text-[#6E6978]" />
            </div>
          )}
          <CaseLocationMap
            mapsConfig={mapsConfig}
            coords={{ lat: c.lat, lng: c.lng }}
            label={c.streetName}
          />
        </div>

        {c.notes && (
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-4 text-sm text-[#2D2B35]">
            <div className="text-[11px] text-[#6E6978] mb-1">Description</div>
            {c.notes}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <Detail label="PatchUp report (not a case number)" value={c.potholeId} mono />
          <Detail
            label="Official case number"
            value={c.externalCaseRef || 'Not logged yet'}
            mono={Boolean(c.externalCaseRef)}
          />
          <Detail
            label="Submission method"
            value={
              c.reportMethod === 'official_portal'
                ? 'Official portal'
                : c.reportMethod === 'phone'
                  ? 'Phone'
                  : c.reportMethod === 'email'
                    ? 'Email'
                    : `${agency.shortName} channel`
            }
          />
          <Detail
            label="Reported"
            value={
              c.submittedAtMillis
                ? `${formatDateTime(c.submittedAtMillis)} · ${elapsedSince(c.submittedAtMillis, nowMillis)} ago`
                : 'Not confirmed'
            }
          />
        </div>

        {/* Three separate, clearly-labeled status lines */}
        <div className="space-y-2">
          <StatusLine
            icon={<ExternalLink className="w-4 h-4 text-[#536159]" />}
            label="Official agency status"
            value={officialAgencyStatus}
            hint="Only what you logged — PatchUp never invents an agency status."
          />
          <StatusLine
            icon={<Clock className="w-4 h-4 text-[#536159]" />}
            label="PatchUp workflow status"
            value={caseStatusLabel(c.status)}
          />
          <StatusLine
            icon={<MapPin className="w-4 h-4 text-[#536159]" />}
            label="Physical repair (PatchUp evidence)"
            value={potholeStatusLabel(c.potholeStatus)}
            hint="From PatchUp map evidence — not an ATL311 confirmation."
          />
        </div>

        {/* Deadline block */}
        {deadline && (
          <div
            className={`rounded-xl border p-4 ${
              deadline.state === 'past'
                ? 'border-[#DC2626]/40 bg-[#DC2626]/5'
                : deadline.state === 'approaching'
                  ? 'border-[#D97706]/40 bg-[#D97706]/5'
                  : 'border-[#E8DFC5] bg-[#F7F7F8]'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <CalendarClock className="w-4 h-4 text-[#2D2B35]" />
              <span className="text-xs font-bold text-[#2D2B35]">Completion date</span>
            </div>
            <p className="text-sm text-[#2D2B35]">{deadline.message}</p>
            {c.expectedCompletionAtMillis && (
              <p className="text-[11px] text-[#6E6978] mt-1">
                Recorded by you from the agency: {formatDate(c.expectedCompletionAtMillis)}
                {c.deadlineCitation ? ` · “${c.deadlineCitation}”` : ''}
              </p>
            )}
            {c.personalFollowUpAtMillis && (
              <p className="text-[11px] text-[#4CB729] mt-1 inline-flex items-center gap-1">
                <Bell className="w-3 h-3" /> Your reminder: {formatDateTime(c.personalFollowUpAtMillis)}{' '}
                (not a government deadline)
              </p>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-5">
        <h2 className="font-display text-lg font-bold text-[#2D2B35]">Update this case</h2>
        {actionError && (
          <p className="text-xs text-[#DC2626] bg-[#DC2626]/10 border border-[#DC2626]/30 rounded-lg px-3 py-2">
            {actionError}
          </p>
        )}

        {/* Record transcribed completion date */}
        <div className="space-y-2">
          <label className="text-xs font-bold text-[#2D2B35]">
            {c.expectedCompletionAtMillis ? 'Replace' : 'Record'} completion date from the agency
          </label>
          <p className="text-[11px] text-[#6E6978]">
            Only enter a date you copied from an official agency page or notice. PatchUp never
            invents a repair deadline.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="date"
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              className="min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35]"
            />
            <input
              type="text"
              value={citationInput}
              onChange={(e) => setCitationInput(e.target.value)}
              placeholder="Short citation (e.g. ATL311 portal, Nov 20)"
              className="flex-1 min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35]"
            />
            <button
              type="button"
              onClick={saveDate}
              disabled={!dateInput || busy === 'date'}
              className="min-h-[44px] px-4 rounded-xl bg-[#2D2B35] text-white text-sm font-semibold disabled:opacity-50"
            >
              {busy === 'date' ? 'Saving…' : 'Save date'}
            </button>
          </div>
        </div>

        {/* Personal reminder */}
        <div className="space-y-2">
          <label className="text-xs font-bold text-[#2D2B35]">Set a personal reminder</label>
          <p className="text-[11px] text-[#6E6978]">
            Just for you — shown as “Your reminder”, never as a government deadline.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="datetime-local"
              value={reminderInput}
              onChange={(e) => setReminderInput(e.target.value)}
              className="flex-1 min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35]"
            />
            <button
              type="button"
              onClick={saveReminder}
              disabled={!reminderInput || busy === 'reminder'}
              className="min-h-[44px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold disabled:opacity-50"
            >
              {busy === 'reminder' ? 'Saving…' : 'Set reminder'}
            </button>
          </div>
        </div>

        {/* Agency status logging + escalate */}
        <div className="flex flex-wrap gap-2 pt-1">
          {user && c.status !== 'resolved' && c.status !== 'acknowledged' && (
            <button
              type="button"
              onClick={() =>
                void runAction('ack', () =>
                  logCase(user, { potholeId: c.potholeId, status: 'acknowledged' })
                )
              }
              disabled={busy === 'ack'}
              className="min-h-[44px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold disabled:opacity-50"
            >
              I logged an agency acknowledgement
            </button>
          )}
          {user && c.status !== 'resolved' && (
            <button
              type="button"
              onClick={() =>
                void runAction('resolve', () =>
                  logCase(user, { potholeId: c.potholeId, status: 'resolved' })
                )
              }
              disabled={busy === 'resolve'}
              className="min-h-[44px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold disabled:opacity-50"
            >
              Agency told me it’s closed
            </button>
          )}
          {user && c.status === 'resolved' && c.potholeStatus !== 'repaired' && (
            <button
              type="button"
              onClick={() =>
                void runAction('stillthere', () =>
                  saveCaseFollowUp(user, {
                    caseId: c.caseId,
                    reasonId: 'closed_still_there',
                    action: 'prepare_draft',
                    agencyClosureDamageRemains: true,
                  })
                )
              }
              disabled={busy === 'stillthere'}
              className="min-h-[44px] px-4 rounded-xl border border-[#D97706]/50 bg-[#D97706]/10 text-[#B45309] text-sm font-semibold disabled:opacity-50"
            >
              Closed, but pothole is still there
            </button>
          )}
          <button
            type="button"
            onClick={() => onEscalate(c.caseId)}
            className="min-h-[44px] px-5 rounded-xl bg-[#e7421e] hover:bg-[#ff5833] text-white text-sm font-bold inline-flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4" />
            {deadline?.escalateProminent ? 'Escalate' : 'Follow up'}
          </button>
        </div>
      </div>

      {/* Follow-up history */}
      {c.followUps.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-3">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">Follow-up history</h2>
          <div className="space-y-2">
            {[...c.followUps]
              .sort((a, b) => (b.draftedAtMillis || 0) - (a.draftedAtMillis || 0))
              .map((f) => (
                <div
                  key={f.followUpId}
                  className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[#2D2B35]">{f.reasonLabel}</span>
                    <span className="text-[#6E6978]">{formatDateTime(f.draftedAtMillis)}</span>
                  </div>
                  <div className="text-[#6E6978] mt-0.5">
                    {f.kind === 'overdue' ? 'Overdue follow-up' : 'Follow-up'} ·{' '}
                    {f.status.replace(/_/g, ' ')}
                    {f.newReference ? ` · ref ${f.newReference}` : ''}
                  </div>
                  {f.newEvidenceNotes && (
                    <div className="text-[#2D2B35] mt-1">{f.newEvidenceNotes}</div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Event timeline */}
      <div className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-3">
        <h2 className="font-display text-lg font-bold text-[#2D2B35]">Timeline</h2>
        <ol className="space-y-3">
          {sortedEvents.map((ev, i) => (
            <li key={`${ev.type}-${ev.atMillis}-${i}`} className="flex items-start gap-3">
              <CheckCircle2 className="w-4 h-4 text-[#4CB729] mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[#2D2B35]">
                  {ev.type.replace(/_/g, ' ')}
                </div>
                <div className="text-[11px] text-[#6E6978]">{formatDateTime(ev.atMillis)}</div>
                {ev.note && <div className="text-xs text-[#4B4646] mt-0.5">{ev.note}</div>}
                {ev.externalCaseRef && (
                  <div className="text-xs font-mono text-[#2D2B35] mt-0.5">
                    ref {ev.externalCaseRef}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
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
    <ArrowLeft className="w-4 h-4" /> Back to My Cases
  </button>
);

const Detail: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3">
    <div className="text-[11px] text-[#6E6978]">{label}</div>
    <div className={`mt-0.5 text-[#2D2B35] ${mono ? 'font-mono' : 'font-semibold'} break-words`}>
      {value}
    </div>
  </div>
);

const StatusLine: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}> = ({ icon, label, value, hint }) => (
  <div className="flex items-start gap-3 rounded-xl border border-[#E8DFC5] p-3">
    <div className="mt-0.5 shrink-0">{icon}</div>
    <div className="min-w-0">
      <div className="text-[11px] text-[#6E6978]">{label}</div>
      <div className="text-sm font-semibold text-[#2D2B35]">{value}</div>
      {hint && <div className="text-[11px] text-[#6E6978] mt-0.5">{hint}</div>}
    </div>
  </div>
);

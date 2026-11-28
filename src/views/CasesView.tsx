import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  MapPin,
  Search,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCases } from '../hooks/useCases';
import { resolveAgency } from '../lib/agencyDirectory';
import type { MyCaseItem } from '../lib/maps';
import {
  CASE_FILTERS,
  CaseFilter,
  CaseSort,
  caseStatusLabel,
  deadlineFor,
  elapsedSince,
  formatDate,
  formatDateTime,
  matchesFilter,
  matchesSearch,
  potholeStatusLabel,
  sortCases,
  summarizeCases,
} from '../lib/caseFormat';

interface CasesViewProps {
  onOpenCase: (caseId: string) => void;
  onEscalate: (caseId: string) => void;
}

type PrimaryAction = 'view' | 'check_status' | 'follow_up' | 'escalate';

function primaryActionFor(c: MyCaseItem, nowMillis: number): PrimaryAction {
  const d = deadlineFor(c, nowMillis);
  if (d.escalateProminent) return 'escalate';
  if (d.state === 'unknown' && c.status !== 'resolved') return 'check_status';
  if (c.status === 'case_logged' || c.status === 'acknowledged' || c.status === 'reopened')
    return 'follow_up';
  return 'view';
}

const SORTS: { id: CaseSort; label: string }[] = [
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
  { id: 'status', label: 'Status' },
  { id: 'deadline', label: 'Deadline' },
];

export const CasesView: React.FC<CasesViewProps> = ({ onOpenCase, onEscalate }) => {
  const { user } = useAuth();
  const { cases, state, error } = useCases(user);
  const [filter, setFilter] = useState<CaseFilter>('all');
  const [sort, setSort] = useState<CaseSort>('newest');
  const [search, setSearch] = useState('');

  const nowMillis = Date.now();
  const counts = useMemo(() => summarizeCases(cases, nowMillis), [cases, nowMillis]);
  const visible = useMemo(() => {
    const filtered = cases
      .filter((c) => matchesFilter(c, filter, nowMillis))
      .filter((c) => matchesSearch(c, search));
    return sortCases(filtered, sort);
  }, [cases, filter, search, sort, nowMillis]);

  return (
    <div className="city-page city-cases max-w-5xl mx-auto space-y-6">
      <div className="page-banner page-banner-cases">
        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#2D2B35]">My Cases</h1>
          <p className="text-sm text-[#4B4646] mt-1 max-w-2xl leading-relaxed">
            Every pothole you’ve taken to ATL311 or GDOT, with the official case number you logged
            and the completion date you recorded. These are your private cases — nobody else sees
            them.
          </p>
        </div>
      </div>

      {/* Summary counts — one compact row that wraps on a phone */}
      <SummaryRow counts={counts} />

      {/* Filters + search + sort */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 text-[#6E6978] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address, PatchUp id, or case number"
              className="w-full min-h-[44px] pl-9 pr-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] placeholder:text-[#6E6978] focus-visible:outline-2 focus-visible:outline-[#4CB729]"
            />
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-[#6E6978] shrink-0">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as CaseSort)}
              className="min-h-[44px] px-3 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm font-semibold text-[#2D2B35]"
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="scrollbar-none -mx-1 px-1 flex items-center gap-1.5 overflow-x-auto">
          {CASE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`min-h-[36px] px-3 rounded-full text-xs font-semibold whitespace-nowrap border transition ${
                filter === f.id
                  ? 'bg-[#2D2B35] text-white border-[#2D2B35]'
                  : 'bg-[#F7F7F8] text-[#536159] border-[#E8DFC5] hover:border-[#2D2B35]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      {/* Body states */}
      {state === 'loading' || state === 'idle' ? (
        <LoadingState />
      ) : state === 'unavailable' ? (
        <UnavailableState />
      ) : state === 'error' ? (
        <ErrorState message={error} />
      ) : cases.length === 0 ? (
        <EmptyState />
      ) : visible.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-8 text-center text-sm text-[#6E6978]">
          No cases match this filter or search.
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((c) => (
            <CaseCard
              key={c.caseId}
              c={c}
              nowMillis={nowMillis}
              onOpenCase={onOpenCase}
              onEscalate={onEscalate}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const SummaryRow: React.FC<{ counts: ReturnType<typeof summarizeCases> }> = ({ counts }) => {
  const stats: { label: string; value: number; tone?: 'warn' | 'bad' | 'good' }[] = [
    { label: 'Total', value: counts.total },
    { label: 'Awaiting case #', value: counts.awaitingCaseNumber },
    { label: 'Open', value: counts.open },
    { label: 'Deadline unavailable', value: counts.deadlineUnavailable },
    { label: 'Approaching', value: counts.approaching, tone: 'warn' },
    { label: 'Past deadline', value: counts.pastDeadline, tone: 'bad' },
    { label: 'Follow-up', value: counts.followUp },
    { label: 'Agency closed', value: counts.agencyClosed },
    { label: 'Repair verified', value: counts.repairVerified, tone: 'good' },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {stats.map((s) => (
        <div
          key={s.label}
          className={`rounded-xl border px-3.5 py-2.5 bg-white min-w-[96px] ${
            s.tone === 'bad'
              ? 'border-[#DC2626]/40'
              : s.tone === 'warn'
                ? 'border-[#D97706]/40'
                : s.tone === 'good'
                  ? 'border-[#4CB729]/50'
                  : 'border-[#E8DFC5]'
          }`}
        >
          <div
            className={`font-mono text-xl font-bold tabular-nums ${
              s.tone === 'bad'
                ? 'text-[#DC2626]'
                : s.tone === 'warn'
                  ? 'text-[#D97706]'
                  : s.tone === 'good'
                    ? 'text-[#3FA31F]'
                    : 'text-[#2D2B35]'
            }`}
          >
            {s.value}
          </div>
          <div className="text-[11px] text-[#6E6978] leading-tight">{s.label}</div>
        </div>
      ))}
    </div>
  );
};

const CaseCard: React.FC<{
  c: MyCaseItem;
  nowMillis: number;
  onOpenCase: (caseId: string) => void;
  onEscalate: (caseId: string) => void;
}> = ({ c, nowMillis, onOpenCase, onEscalate }) => {
  const d = deadlineFor(c, nowMillis);
  const action = primaryActionFor(c, nowMillis);
  const { agency } = resolveAgency(c.jurisdiction);

  const runAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (action === 'escalate' || action === 'follow_up') onEscalate(c.caseId);
    else if (action === 'check_status') window.open(agency.portalUrl, '_blank', 'noopener,noreferrer');
    else onOpenCase(c.caseId);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenCase(c.caseId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenCase(c.caseId);
        }
      }}
      className="group bg-white rounded-2xl border border-[#E8DFC5] p-4 sm:p-5 flex flex-col sm:flex-row gap-4 cursor-pointer hover:border-[#2D2B35] focus-visible:outline-2 focus-visible:outline-[#4CB729] transition"
    >
      {c.primaryPhotoUrl ? (
        <img
          src={c.primaryPhotoUrl}
          alt={`Pothole on ${c.streetName}`}
          className="w-full sm:w-28 h-32 sm:h-28 rounded-xl object-cover border border-[#E8DFC5] shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="w-full sm:w-28 h-32 sm:h-28 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] flex items-center justify-center shrink-0">
          <MapPin className="w-6 h-6 text-[#6E6978]" />
        </div>
      )}

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-display text-base font-bold text-[#2D2B35] truncate">
              {c.streetName || 'Unverified street'}
            </div>
            <div className="text-xs text-[#6E6978] truncate">{c.formattedAddress}</div>
          </div>
          <span className="text-[11px] font-semibold text-[#536159] bg-[#F7F7F8] border border-[#E8DFC5] rounded-full px-2.5 py-1 whitespace-nowrap shrink-0">
            {caseStatusLabel(c.status)}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1.5 text-[11px]">
          <Field label="PatchUp report">
            <span className="font-mono text-[#2D2B35] truncate">{c.potholeId}</span>
          </Field>
          <Field label="Official case #">
            {c.externalCaseRef ? (
              <span className="font-mono text-[#2D2B35]">{c.externalCaseRef}</span>
            ) : (
              <span className="text-[#6E6978]">Not logged yet</span>
            )}
          </Field>
          <Field label="PatchUp map status">
            <span className="text-[#2D2B35]">{potholeStatusLabel(c.potholeStatus)}</span>
          </Field>
          <Field label="Last update">
            <span className="text-[#2D2B35]">{formatDateTime(c.updatedAtMillis)}</span>
          </Field>
          <Field label="Reported">
            <span className="text-[#2D2B35]">
              {c.submittedAtMillis
                ? `${elapsedSince(c.submittedAtMillis, nowMillis)} ago`
                : 'Not confirmed'}
            </span>
          </Field>
          <Field label="Recorded completion">
            {c.expectedCompletionAtMillis ? (
              <span className="text-[#2D2B35]">{formatDate(c.expectedCompletionAtMillis)}</span>
            ) : (
              <span className="text-[#6E6978]">Official deadline unavailable</span>
            )}
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <DeadlineChip state={d.state} message={d.message} />
          <button
            type="button"
            onClick={runAction}
            className={
              action === 'escalate'
                ? 'min-h-[40px] px-4 rounded-xl bg-[#e7421e] hover:bg-[#ff5833] text-white text-xs font-bold inline-flex items-center gap-1.5 shrink-0'
                : 'min-h-[40px] px-4 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-xs font-semibold inline-flex items-center gap-1.5 shrink-0'
            }
          >
            {action === 'escalate' && (
              <>
                <AlertTriangle className="w-3.5 h-3.5" /> Escalate
              </>
            )}
            {action === 'check_status' && (
              <>
                <ExternalLink className="w-3.5 h-3.5" /> Check official status
              </>
            )}
            {action === 'follow_up' && (
              <>
                <ArrowUpRight className="w-3.5 h-3.5" /> Follow up
              </>
            )}
            {action === 'view' && (
              <>
                <FileText className="w-3.5 h-3.5" /> View case
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0">
    <div className="text-[#6E6978]">{label}</div>
    <div className="mt-0.5 truncate">{children}</div>
  </div>
);

const DeadlineChip: React.FC<{ state: string; message: string }> = ({ state, message }) => {
  const tone =
    state === 'past'
      ? 'text-[#DC2626] bg-[#DC2626]/10 border-[#DC2626]/30'
      : state === 'approaching'
        ? 'text-[#D97706] bg-[#D97706]/10 border-[#D97706]/30'
        : state === 'repaired'
          ? 'text-[#3FA31F] bg-[#4CB729]/10 border-[#4CB729]/30'
          : 'text-[#536159] bg-[#F7F7F8] border-[#E8DFC5]';
  return (
    <span
      className={`text-[11px] font-semibold rounded-lg border px-2.5 py-1.5 leading-snug max-w-full ${tone}`}
    >
      {message}
    </span>
  );
};

const LoadingState: React.FC = () => (
  <div className="space-y-3" aria-busy="true" aria-live="polite">
    {[0, 1, 2].map((i) => (
      <div key={i} className="bg-white rounded-2xl border border-[#E8DFC5] p-5 flex gap-4">
        <div className="w-28 h-28 rounded-xl bg-[#F7F7F8] animate-pulse shrink-0" />
        <div className="flex-1 space-y-3 py-1">
          <div className="h-4 w-1/3 bg-[#F7F7F8] rounded animate-pulse" />
          <div className="h-3 w-2/3 bg-[#F7F7F8] rounded animate-pulse" />
          <div className="h-3 w-1/2 bg-[#F7F7F8] rounded animate-pulse" />
        </div>
      </div>
    ))}
  </div>
);

const UnavailableState: React.FC = () => (
  <div className="bg-white rounded-2xl border border-[#E8DFC5] p-8 text-center space-y-2">
    <ClipboardList className="w-8 h-8 text-[#6E6978] mx-auto" />
    <h2 className="font-display text-lg font-bold text-[#2D2B35]">Case tracking is offline here</h2>
    <p className="text-sm text-[#6E6978] max-w-md mx-auto">
      This environment has no server database credentials, so your official cases can’t load. In a
      deployment with Admin SDK credentials, your ATL311 and GDOT cases appear here.
    </p>
  </div>
);

const ErrorState: React.FC<{ message: string | null }> = ({ message }) => (
  <div className="bg-white rounded-2xl border border-[#DC2626]/40 p-8 text-center space-y-2">
    <AlertTriangle className="w-8 h-8 text-[#DC2626] mx-auto" />
    <h2 className="font-display text-lg font-bold text-[#2D2B35]">Couldn’t load your cases</h2>
    <p className="text-sm text-[#6E6978] max-w-md mx-auto">{message || 'Please try again.'}</p>
  </div>
);

const EmptyState: React.FC = () => (
  <div className="bg-white rounded-2xl border border-[#E8DFC5] p-10 text-center space-y-3">
    <CheckCircle2 className="w-10 h-10 text-[#4CB729] mx-auto" />
    <h2 className="font-display text-xl font-bold text-[#2D2B35]">No official cases yet</h2>
    <p className="text-sm text-[#6E6978] max-w-md mx-auto leading-relaxed">
      When you record a distinct pothole and take it to ATL311 or GDOT, log the case here to track
      its official number, the completion date you record, and any follow-ups.
    </p>
  </div>
);

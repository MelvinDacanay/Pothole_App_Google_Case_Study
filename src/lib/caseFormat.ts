import { classifyDeadline, type DeadlineState } from '../../server/cases';
import {
  CASE_STATUS_LABELS,
  POTHOLE_STATUS_LABELS,
  type CaseStatus,
  type MyCaseItem,
  type PotholeStatus,
} from './maps';

/** All dates are rendered in the user's local timezone. */
export function formatDateTime(millis?: number | null): string {
  if (!millis || !Number.isFinite(millis)) return '—';
  return new Date(millis).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDate(millis?: number | null): string {
  if (!millis || !Number.isFinite(millis)) return '—';
  return new Date(millis).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Coarse elapsed-time label, e.g. "3 days", "5 hours", "just now". */
export function elapsedSince(millis: number | undefined, nowMillis: number): string {
  if (!millis || !Number.isFinite(millis)) return '—';
  const diff = Math.max(0, nowMillis - millis);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}

export function caseStatusLabel(status: string): string {
  return CASE_STATUS_LABELS[status as CaseStatus] ?? status;
}

export function potholeStatusLabel(status?: string): string {
  if (!status) return 'Not on the map';
  return POTHOLE_STATUS_LABELS[status as PotholeStatus] ?? status;
}

export interface DeadlineView {
  state: DeadlineState;
  message: string;
  hasOfficialDeadline: boolean;
  daysRemaining: number | null;
  daysOverdue: number | null;
  showEscalate: boolean;
  escalateProminent: boolean;
  offerCheckStatus: boolean;
  offerPersonalReminder: boolean;
}

/** Thin wrapper that feeds a MyCaseItem into the shared deadline classifier. */
export function deadlineFor(c: MyCaseItem, nowMillis: number): DeadlineView {
  const d = classifyDeadline({
    expectedCompletionAtMillis: c.expectedCompletionAtMillis,
    caseStatus: c.status,
    potholeStatus: c.potholeStatus,
    externalCaseRef: c.externalCaseRef,
    potholeId: c.potholeId,
    nowMillis,
    agencyClosureDamageRemains: c.agencyClosureDamageRemains,
  });
  return {
    state: d.state,
    message: d.message,
    hasOfficialDeadline: d.hasOfficialDeadline,
    daysRemaining: d.daysRemaining,
    daysOverdue: d.daysOverdue,
    showEscalate: d.showEscalate,
    escalateProminent: d.escalateProminent,
    offerCheckStatus: d.offerCheckStatus,
    offerPersonalReminder: d.offerPersonalReminder,
  };
}

export type CaseFilter =
  | 'all'
  | 'needs_case_number'
  | 'open'
  | 'deadline_unknown'
  | 'approaching'
  | 'past_deadline'
  | 'follow_up'
  | 'closed'
  | 'repair_verified';

export const CASE_FILTERS: { id: CaseFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs_case_number', label: 'Needs case number' },
  { id: 'open', label: 'Open' },
  { id: 'deadline_unknown', label: 'Deadline unknown' },
  { id: 'approaching', label: 'Approaching' },
  { id: 'past_deadline', label: 'Past deadline' },
  { id: 'follow_up', label: 'Follow-up' },
  { id: 'closed', label: 'Closed' },
  { id: 'repair_verified', label: 'Repair verified' },
];

export function matchesFilter(c: MyCaseItem, filter: CaseFilter, nowMillis: number): boolean {
  if (filter === 'all') return true;
  const d = deadlineFor(c, nowMillis);
  switch (filter) {
    case 'needs_case_number':
      return (c.status === 'drafted' || c.status === 'submitted_unconfirmed') && !c.externalCaseRef;
    case 'open':
      return c.status === 'case_logged' || c.status === 'acknowledged' || c.status === 'reopened';
    case 'deadline_unknown':
      return d.state === 'unknown';
    case 'approaching':
      return d.state === 'approaching';
    case 'past_deadline':
      return d.state === 'past';
    case 'follow_up':
      return (c.followUps?.length ?? 0) > 0 || Boolean(c.agencyClosureDamageRemains);
    case 'closed':
      return c.status === 'resolved';
    case 'repair_verified':
      return c.potholeStatus === 'repaired';
    default:
      return true;
  }
}

export function matchesSearch(c: MyCaseItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    c.formattedAddress.toLowerCase().includes(q) ||
    c.streetName.toLowerCase().includes(q) ||
    c.potholeId.toLowerCase().includes(q) ||
    (c.externalCaseRef ?? '').toLowerCase().includes(q)
  );
}

export type CaseSort = 'newest' | 'oldest' | 'status' | 'deadline';

const STATUS_ORDER: Record<string, number> = {
  drafted: 0,
  submitted_unconfirmed: 1,
  case_logged: 2,
  acknowledged: 3,
  reopened: 4,
  resolved: 5,
};

export function sortCases(list: MyCaseItem[], sort: CaseSort): MyCaseItem[] {
  const copy = [...list];
  switch (sort) {
    case 'newest':
      return copy.sort((a, b) => (b.updatedAtMillis ?? 0) - (a.updatedAtMillis ?? 0));
    case 'oldest':
      return copy.sort((a, b) => (a.createdAtMillis ?? 0) - (b.createdAtMillis ?? 0));
    case 'status':
      return copy.sort(
        (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      );
    case 'deadline':
      // Dated cases first (soonest first); undated cases sort after.
      return copy.sort((a, b) => {
        const am = a.expectedCompletionAtMillis;
        const bm = b.expectedCompletionAtMillis;
        if (am && bm) return am - bm;
        if (am) return -1;
        if (bm) return 1;
        return (b.updatedAtMillis ?? 0) - (a.updatedAtMillis ?? 0);
      });
    default:
      return copy;
  }
}

export interface CaseSummaryCounts {
  total: number;
  awaitingCaseNumber: number;
  open: number;
  deadlineUnavailable: number;
  approaching: number;
  pastDeadline: number;
  followUp: number;
  agencyClosed: number;
  repairVerified: number;
}

export function summarizeCases(list: MyCaseItem[], nowMillis: number): CaseSummaryCounts {
  const counts: CaseSummaryCounts = {
    total: list.length,
    awaitingCaseNumber: 0,
    open: 0,
    deadlineUnavailable: 0,
    approaching: 0,
    pastDeadline: 0,
    followUp: 0,
    agencyClosed: 0,
    repairVerified: 0,
  };
  for (const c of list) {
    const d = deadlineFor(c, nowMillis);
    if ((c.status === 'drafted' || c.status === 'submitted_unconfirmed') && !c.externalCaseRef)
      counts.awaitingCaseNumber += 1;
    if (c.status === 'case_logged' || c.status === 'acknowledged' || c.status === 'reopened')
      counts.open += 1;
    if (d.state === 'unknown') counts.deadlineUnavailable += 1;
    if (d.state === 'approaching') counts.approaching += 1;
    if (d.state === 'past') counts.pastDeadline += 1;
    if ((c.followUps?.length ?? 0) > 0 || c.agencyClosureDamageRemains) counts.followUp += 1;
    if (c.status === 'resolved') counts.agencyClosed += 1;
    if (c.potholeStatus === 'repaired') counts.repairVerified += 1;
  }
  return counts;
}

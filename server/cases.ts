/**
 * Pure, dependency-free domain logic for per-user ATL311 / GDOT case tracking.
 *
 * This module is the single source of truth shared by three callers:
 *  - server.ts (Admin SDK endpoints that persist cases, follow-ups, deadlines)
 *  - the client My Cases / Case Detail / Escalate views
 *  - tests/production.test.ts
 *
 * It MUST stay free of firebase-admin, browser APIs, Date.now(), and any
 * runtime imports (type-only imports are fine) so every caller can evaluate the
 * exact same result from the exact same inputs. Honesty rules are encoded here:
 * we never invent an agency case number, never convert a calendar date into
 * business days on our own, and never treat a personal reminder as an official
 * deadline.
 */
import type { CaseStatus, PotholeStatus } from '../src/lib/maps';

export const MS_PER_DAY = 86_400_000;
export const DEFAULT_WARNING_WINDOW_DAYS = 3;

export type DeadlineState =
  | 'repaired' // PatchUp evidence shows the road is fixed (physical repair)
  | 'agency_closed' // the user recorded the agency closed the case
  | 'unknown' // no user-transcribed completion date on file
  | 'future' // dated, outside the warning window
  | 'approaching' // dated, inside the warning window
  | 'past'; // dated, elapsed, still unresolved and unrepaired

export interface DeadlineInput {
  /** Millis of the user-transcribed agency completion date, or null/undefined. */
  expectedCompletionAtMillis: number | null | undefined;
  caseStatus: CaseStatus;
  /** Live joined pothole status (PatchUp evidence; not an agency confirmation). */
  potholeStatus?: PotholeStatus | string | null;
  /** Official agency reference, only ever a user-confirmed value. */
  externalCaseRef?: string | null;
  potholeId: string;
  nowMillis: number;
  warningWindowDays?: number;
  /** The user recorded the agency closed the case while the damage remains. */
  agencyClosureDamageRemains?: boolean;
}

export interface DeadlineClassification {
  state: DeadlineState;
  hasOfficialDeadline: boolean;
  daysRemaining: number | null;
  daysOverdue: number | null;
  showEscalate: boolean;
  escalateProminent: boolean;
  offerCheckStatus: boolean;
  offerPersonalReminder: boolean;
  /** Human reference that never fabricates an agency number. */
  referenceLabel: string;
  message: string;
}

function isValidMillis(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Reference label that uses the official ref only when the user logged one. */
export function caseReferenceLabel(
  externalCaseRef: string | null | undefined,
  potholeId: string
): string {
  const ref = (externalCaseRef ?? '').trim();
  if (ref) return `official case #${ref}`;
  return `PatchUp report ${potholeId}`;
}

/**
 * Deadline state is a pure function of the stored transcribed date, the case
 * status, and the joined pothole status. It never invents a date or a case
 * number, and a passed date only becomes "past/overdue" when the case is still
 * unresolved and the pothole is not repaired.
 */
export function classifyDeadline(input: DeadlineInput): DeadlineClassification {
  const {
    expectedCompletionAtMillis,
    caseStatus,
    potholeStatus,
    externalCaseRef,
    potholeId,
    nowMillis,
    warningWindowDays = DEFAULT_WARNING_WINDOW_DAYS,
    agencyClosureDamageRemains = false,
  } = input;

  const referenceLabel = caseReferenceLabel(externalCaseRef, potholeId);
  const base = {
    hasOfficialDeadline: isValidMillis(expectedCompletionAtMillis),
    daysRemaining: null as number | null,
    daysOverdue: null as number | null,
    showEscalate: false,
    escalateProminent: false,
    offerCheckStatus: true,
    offerPersonalReminder: false,
    referenceLabel,
  };

  // Physical repair (PatchUp evidence) is the terminal happy path.
  if (potholeStatus === 'repaired') {
    return {
      ...base,
      state: 'repaired',
      offerCheckStatus: false,
      message: 'PatchUp evidence shows this pothole was repaired.',
    };
  }

  // Agency closure is user-recorded, never an automatic overdue state.
  // Reopened cases intentionally fall through to date recalculation.
  if (caseStatus === 'resolved') {
    return {
      ...base,
      state: 'agency_closed',
      showEscalate: agencyClosureDamageRemains,
      escalateProminent: agencyClosureDamageRemains,
      message: agencyClosureDamageRemains
        ? 'You recorded that the agency closed this case, but the damage is still there. You can send a follow-up.'
        : 'You recorded that the agency closed this case.',
    };
  }

  if (!isValidMillis(expectedCompletionAtMillis)) {
    return {
      ...base,
      state: 'unknown',
      offerPersonalReminder: true,
      message:
        'Official deadline unavailable. Check the agency’s official status, or set a personal reminder.',
    };
  }

  const expected = expectedCompletionAtMillis;
  if (nowMillis > expected) {
    return {
      ...base,
      state: 'past',
      daysOverdue: Math.ceil((nowMillis - expected) / MS_PER_DAY),
      showEscalate: true,
      escalateProminent: true,
      message:
        'This case is past the completion date you recorded. Consider checking its official status and requesting follow-up.',
    };
  }

  const daysRemaining = Math.ceil((expected - nowMillis) / MS_PER_DAY);
  if (daysRemaining <= warningWindowDays) {
    return {
      ...base,
      state: 'approaching',
      daysRemaining,
      message: `Your ${referenceLabel} is approaching the completion date you recorded. ${daysRemaining} day${
        daysRemaining === 1 ? '' : 's'
      } remaining.`,
    };
  }

  return {
    ...base,
    state: 'future',
    daysRemaining,
    message: `On track. The completion date you recorded from the agency is in ${daysRemaining} days.`,
  };
}

export interface PersonalReminderDescription {
  label: string;
  message: string;
  isOfficial: false;
  dueMillis: number | null;
}

/**
 * A personal reminder is strictly the user's own nudge. It is always labeled
 * "Your reminder" and is never presented as a government deadline.
 */
export function describePersonalReminder(
  personalFollowUpAtMillis: number | null | undefined
): PersonalReminderDescription {
  if (!isValidMillis(personalFollowUpAtMillis)) {
    return { label: 'Your reminder', message: 'No personal reminder set.', isOfficial: false, dueMillis: null };
  }
  return {
    label: 'Your reminder',
    message: 'A personal reminder you set for yourself — this is not a government deadline.',
    isOfficial: false,
    dueMillis: personalFollowUpAtMillis,
  };
}

// --- Follow-ups -------------------------------------------------------------

export const ESCALATION_REASONS = [
  { id: 'past_recorded_date', label: 'Past the completion date I recorded', kind: 'overdue' },
  { id: 'closed_still_there', label: 'Agency closed it, pothole still there', kind: 'ordinary' },
  { id: 'stalled', label: 'Case stalled', kind: 'ordinary' },
  { id: 'status_update', label: 'Request a status update', kind: 'ordinary' },
  { id: 'worsening', label: 'New evidence of worsening damage', kind: 'ordinary' },
] as const;

export type EscalationReasonId = (typeof ESCALATION_REASONS)[number]['id'];
export type FollowUpKind = 'overdue' | 'ordinary';

export function reasonKind(reasonId: string): FollowUpKind {
  const found = ESCALATION_REASONS.find((r) => r.id === reasonId);
  return found ? found.kind : 'ordinary';
}

export type FollowUpStatus =
  | 'draft_prepared'
  | 'contact_initiated'
  | 'contact_confirmed'
  | 'awaiting_response'
  | 'agency_reference_recorded'
  | 'resolved';

export type FollowUpAction =
  | 'prepare_draft'
  | 'open_link'
  | 'copy'
  | 'open_gmail'
  | 'open_phone'
  | 'user_confirmed_sent'
  | 'save_reference'
  | 'mark_resolved';

/**
 * Maps a user action to the follow-up status it is allowed to record. Opening a
 * link, copying text, or opening Gmail is only ever "contact initiated" — it is
 * never "agency reference recorded". Only an explicit saved reference may record
 * an agency reference, and only an explicit "I sent this" confirms contact.
 */
export function deriveFollowUpStatus(action: FollowUpAction): FollowUpStatus {
  switch (action) {
    case 'prepare_draft':
      return 'draft_prepared';
    case 'open_link':
    case 'copy':
    case 'open_gmail':
    case 'open_phone':
      return 'contact_initiated';
    case 'user_confirmed_sent':
      return 'contact_confirmed';
    case 'save_reference':
      return 'agency_reference_recorded';
    case 'mark_resolved':
      return 'resolved';
    default:
      return 'draft_prepared';
  }
}

// --- Escalation / report draft assembly ------------------------------------

export interface EscalationDraftInput {
  potholeId: string;
  externalCaseRef?: string | null;
  submittedAtISO?: string | null;
  confirmedSubmission?: boolean;
  streetName?: string | null;
  formattedAddress?: string | null;
  lat?: number | null;
  lng?: number | null;
  notes?: string | null;
  officialStatusKnown?: string | null;
  patchupStatus?: string | null;
  potholeStatus?: string | null;
  reasonLabel?: string | null;
  elapsedDays?: number | null;
  photoUrls?: string[];
}

/**
 * Builds an editable follow-up message from verified fields only. Any field we
 * do not have is omitted entirely — we never write a fake agency reply, a fake
 * confirmation, or a guessed government email address.
 */
export function buildEscalationMessage(input: EscalationDraftInput): string {
  const lines: string[] = ['POTHOLE REPAIR FOLLOW-UP', ''];

  if (input.reasonLabel && input.reasonLabel.trim()) {
    lines.push(`Reason for follow-up: ${input.reasonLabel.trim()}`, '');
  }

  const ref = (input.externalCaseRef ?? '').trim();
  if (ref) {
    lines.push(`Official case number: ${ref}`);
  }
  lines.push(`PatchUp report reference (not an official case number): ${input.potholeId}`);

  if (input.confirmedSubmission && input.submittedAtISO) {
    lines.push(`Originally reported: ${input.submittedAtISO}`);
  }
  if (typeof input.elapsedDays === 'number' && Number.isFinite(input.elapsedDays)) {
    lines.push(`Days since I reported it: ${input.elapsedDays}`);
  }

  lines.push('');
  const location = (input.formattedAddress ?? input.streetName ?? '').trim();
  if (location) lines.push(`Location: ${location}`);
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    lines.push(`Coordinates: ${input.lat.toFixed(6)}, ${input.lng.toFixed(6)}`);
  }

  const statusBits: string[] = [];
  if (input.officialStatusKnown && input.officialStatusKnown.trim()) {
    statusBits.push(`Agency status I was given: ${input.officialStatusKnown.trim()}`);
  }
  if (input.patchupStatus && input.patchupStatus.trim()) {
    statusBits.push(`PatchUp workflow status: ${input.patchupStatus.trim()}`);
  }
  if (input.potholeStatus && input.potholeStatus.trim()) {
    statusBits.push(`PatchUp evidence (physical): ${input.potholeStatus.trim()}`);
  }
  if (statusBits.length) {
    lines.push('', ...statusBits);
  }

  if (input.notes && input.notes.trim()) {
    lines.push('', `Additional detail: ${input.notes.trim()}`);
  }

  const photos = (input.photoUrls ?? []).filter((u) => typeof u === 'string' && u.trim());
  if (photos.length) {
    lines.push('', 'Evidence photos (download and attach manually — not auto-attached):');
    for (const url of photos) lines.push(`- ${url}`);
  }

  lines.push('', 'Thank you for the update.');
  return lines.join('\n');
}

// --- Notifications ----------------------------------------------------------

export type CaseNotificationEvent =
  | 'awaiting_ref'
  | 'deadline_approaching'
  | 'deadline_passed'
  | 'personal_reminder'
  | 'agency_closed'
  | 'repair_verified'
  | 'followup_ref_saved';

export const CASE_NOTIFICATION_TYPES: Record<CaseNotificationEvent, string> = {
  awaiting_ref: 'case_awaiting_ref',
  deadline_approaching: 'case_deadline_approaching',
  deadline_passed: 'case_deadline_passed',
  personal_reminder: 'case_personal_reminder',
  agency_closed: 'case_agency_closed',
  repair_verified: 'case_repair_verified',
  followup_ref_saved: 'case_followup_ref_saved',
};

/**
 * Stable idempotency key. The same (event, caseId, sourceMillis) must always
 * produce the same id so a repeat signed-in load never inserts a duplicate
 * notification. sourceMillis MUST come from stored data, never from "now".
 */
export function caseNotificationId(
  event: CaseNotificationEvent,
  caseId: string,
  sourceMillis: number
): string {
  return `case_${event}_${caseId}_${Math.floor(sourceMillis)}`;
}

export interface PendingCaseNotification {
  id: string;
  type: string;
  event: CaseNotificationEvent;
  title: string;
  body: string;
  relatedId: string; // caseId
  sourceMillis: number;
}

export interface CaseNotificationInput {
  caseId: string;
  potholeId: string;
  streetName?: string | null;
  status: CaseStatus;
  externalCaseRef?: string | null;
  expectedCompletionAtMillis?: number | null;
  submittedAtMillis?: number | null;
  personalFollowUpAtMillis?: number | null;
  potholeStatus?: string | null;
  potholeUpdatedAtMillis?: number | null;
  agencyClosedAtMillis?: number | null;
  followUpRefSavedAtMillis?: number | null;
  nowMillis: number;
  warningWindowDays?: number;
}

/**
 * Deterministically derives the set of case notifications that should exist for
 * one case right now. Pure: identical input → identical ids (so the server can
 * upsert idempotently on a repeat visit). Does NOT touch Firestore and does NOT
 * run during React render — the server calls this inside GET /api/cases/mine.
 */
export function evaluateCaseNotifications(input: CaseNotificationInput): PendingCaseNotification[] {
  const out: PendingCaseNotification[] = [];
  const street = (input.streetName || 'your reported street').trim();
  const refLabel = caseReferenceLabel(input.externalCaseRef, input.potholeId);

  const push = (event: CaseNotificationEvent, sourceMillis: number, title: string, body: string) => {
    if (!Number.isFinite(sourceMillis) || sourceMillis <= 0) return;
    out.push({
      id: caseNotificationId(event, input.caseId, sourceMillis),
      type: CASE_NOTIFICATION_TYPES[event],
      event,
      title,
      body,
      relatedId: input.caseId,
      sourceMillis: Math.floor(sourceMillis),
    });
  };

  // Awaiting an official case number.
  if (
    input.status === 'submitted_unconfirmed' &&
    !(input.externalCaseRef && input.externalCaseRef.trim()) &&
    isValidMillis(input.submittedAtMillis)
  ) {
    push(
      'awaiting_ref',
      input.submittedAtMillis!,
      'Add your official case number',
      `You marked ${street} as submitted. Log the case number the agency gave you to track it.`
    );
  }

  const deadline = classifyDeadline({
    expectedCompletionAtMillis: input.expectedCompletionAtMillis,
    caseStatus: input.status,
    potholeStatus: input.potholeStatus,
    externalCaseRef: input.externalCaseRef,
    potholeId: input.potholeId,
    nowMillis: input.nowMillis,
    warningWindowDays: input.warningWindowDays,
  });

  if (deadline.state === 'approaching' && isValidMillis(input.expectedCompletionAtMillis)) {
    push(
      'deadline_approaching',
      input.expectedCompletionAtMillis!,
      'Recorded completion date approaching',
      `Your ${refLabel} on ${street} is approaching the completion date you recorded.`
    );
  }
  if (deadline.state === 'past' && isValidMillis(input.expectedCompletionAtMillis)) {
    push(
      'deadline_passed',
      input.expectedCompletionAtMillis!,
      'Recorded completion date passed',
      `Your ${refLabel} on ${street} is past the completion date you recorded. Consider a follow-up.`
    );
  }

  // Personal reminder (never labeled as a government deadline).
  if (isValidMillis(input.personalFollowUpAtMillis) && input.nowMillis >= input.personalFollowUpAtMillis!) {
    push(
      'personal_reminder',
      input.personalFollowUpAtMillis!,
      'Your reminder',
      `Your personal reminder about ${street} is due. This is your own note, not a government deadline.`
    );
  }

  // Agency closure recorded by the user.
  if (input.status === 'resolved' && isValidMillis(input.agencyClosedAtMillis)) {
    push(
      'agency_closed',
      input.agencyClosedAtMillis!,
      'Agency closure recorded',
      `You recorded that the agency closed the case on ${street}.`
    );
  }

  // Physical repair verified by PatchUp evidence.
  if (input.potholeStatus === 'repaired' && isValidMillis(input.potholeUpdatedAtMillis)) {
    push(
      'repair_verified',
      input.potholeUpdatedAtMillis!,
      'Repair verified',
      `PatchUp evidence shows the pothole on ${street} was repaired.`
    );
  }

  // Follow-up reference saved.
  if (isValidMillis(input.followUpRefSavedAtMillis)) {
    push(
      'followup_ref_saved',
      input.followUpRefSavedAtMillis!,
      'Follow-up reference saved',
      `You saved a new reference for ${street}.`
    );
  }

  return out;
}

/** Shared string sanitizer mirroring /api/cases/log's externalCaseRef rule. */
export function sanitizeCaseText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\w\s#/\-.,:()'&]/g, '').trim().slice(0, maxLen);
}

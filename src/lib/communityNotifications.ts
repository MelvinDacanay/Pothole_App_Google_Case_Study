export const COMMUNITY_NOTIFICATION_TYPES = ['friend_request','friend_accepted','badge_unlocked','leaderboard_milestone'] as const;
export type CommunityNotificationType = typeof COMMUNITY_NOTIFICATION_TYPES[number];
export function isCommunityNotification(type: unknown): type is CommunityNotificationType { return COMMUNITY_NOTIFICATION_TYPES.some(value => value === type); }

/** Resident case alerts. Kept separate from community notifications so social filters stay strict. */
export const CASE_NOTIFICATION_TYPES = [
  'case_awaiting_ref',
  'case_deadline_approaching',
  'case_deadline_passed',
  'case_personal_reminder',
  'case_agency_closed',
  'case_repair_verified',
  'case_followup_ref_saved',
] as const;
export type CaseNotificationType = typeof CASE_NOTIFICATION_TYPES[number];
export function isCaseNotification(type: unknown): type is CaseNotificationType {
  return CASE_NOTIFICATION_TYPES.some((value) => value === type);
}
export function isReadableNotification(type: unknown): boolean {
  return isCommunityNotification(type) || isCaseNotification(type);
}

export const COMMUNITY_NOTIFICATION_TYPES = ['friend_request','friend_accepted','badge_unlocked','leaderboard_milestone'] as const;
export type CommunityNotificationType = typeof COMMUNITY_NOTIFICATION_TYPES[number];
export function isCommunityNotification(type: unknown): type is CommunityNotificationType { return COMMUNITY_NOTIFICATION_TYPES.some(value => value === type); }

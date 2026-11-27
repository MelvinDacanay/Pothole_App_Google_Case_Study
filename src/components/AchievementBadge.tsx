import React from 'react';

export type AchievementBadgeState = 'locked' | 'in-progress' | 'earned';

const BADGE_ASSET_NAMES = {
  first_spot: 'first-spot',
  neighborhood_watch: 'neighborhood-watch',
  road_scout: 'road-scout',
  pothole_hunter: 'pothole-hunter',
  asphalt_detective: 'asphalt-detective',
  atlanta_road_warrior: 'atlanta-road-warrior',
  community_champion: 'community-champion',
} as const;

type AchievementBadgeType = keyof typeof BADGE_ASSET_NAMES;

interface AchievementBadgeProps {
  badgeType: string;
  state: AchievementBadgeState;
  title?: string;
  className?: string;
}

export function getAchievementBadgeState({
  progress,
  unlocked,
}: {
  progress: number;
  unlocked: boolean;
}): AchievementBadgeState {
  if (unlocked) return 'earned';
  return progress > 0 ? 'in-progress' : 'locked';
}

function isAchievementBadgeType(badgeType: string): badgeType is AchievementBadgeType {
  return badgeType in BADGE_ASSET_NAMES;
}

export const AchievementBadge: React.FC<AchievementBadgeProps> = ({
  badgeType,
  state,
  title,
  className = '',
}) => {
  if (!isAchievementBadgeType(badgeType)) return null;

  const assetName = BADGE_ASSET_NAMES[badgeType];
  const stateLabel = state === 'in-progress' ? 'in progress' : state;

  return (
    <img
      src={`/assets/badges/${assetName}-${state}.png`}
      alt={`${title ?? assetName.replaceAll('-', ' ')} badge, ${stateLabel}`}
      width={512}
      height={512}
      draggable={false}
      className={`block shrink-0 object-contain ${className}`}
    />
  );
};

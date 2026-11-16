import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineBanner: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="w-full bg-[#D97706] text-white px-4 py-2 text-xs sm:text-sm font-medium flex items-center justify-center gap-2"
    >
      <WifiOff className="w-4 h-4 shrink-0" />
      <span>
        Offline Mode — Cached shell loaded. Submissions, map tiles, and live data require a
        connection.
      </span>
    </div>
  );
};

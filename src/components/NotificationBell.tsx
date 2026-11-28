import React, { useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { Bell, Check } from 'lucide-react';
import { useNotifications } from '../hooks/useSocial';

interface NotificationBellProps {
  user: User | null;
  onViewCase: (caseId: string) => void;
  onReviewFriends: () => void;
}

/**
 * Header bell that surfaces the SAME notification collection as Home — this is
 * not a second inbox. Items can be marked read; case alerts deep-link to the
 * related case. Notifications themselves are created server-side, never here.
 */
export const NotificationBell: React.FC<NotificationBellProps> = ({
  user,
  onViewCase,
  onReviewFriends,
}) => {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications(user);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (!user) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        className="relative min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#F7F7F8] text-[#2D2B35]"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#e7421e] text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white rounded-2xl border border-[#E8DFC5] shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#E8DFC5]">
            <span className="font-display text-sm font-bold text-[#2D2B35]">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-[11px] font-semibold text-[#536159] hover:text-[#2D2B35]"
              >
                Mark all read
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[#6E6978]">
              You’re all caught up.
            </div>
          ) : (
            <div className="divide-y divide-[#E8DFC5] max-h-96 overflow-y-auto">
              {notifications.slice(0, 20).map((item) => {
                const isCase = item.type.startsWith('case_');
                return (
                  <div
                    key={item.notificationId}
                    className={`px-4 py-3 flex items-start justify-between gap-2 text-xs ${
                      item.read ? 'opacity-70' : 'bg-[#4CB729]/[0.04]'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-[#2D2B35]">{item.title}</div>
                      <p className="text-[#4B4646] mt-0.5 leading-relaxed">{item.body}</p>
                      {isCase && item.relatedId && (
                        <button
                          type="button"
                          onClick={() => {
                            onViewCase(item.relatedId!);
                            setOpen(false);
                          }}
                          className="mt-1.5 text-[11px] font-semibold text-[#4CB729] hover:underline"
                        >
                          View related case →
                        </button>
                      )}
                      {item.type === 'friend_request' && (
                        <button
                          type="button"
                          onClick={() => {
                            onReviewFriends();
                            setOpen(false);
                          }}
                          className="mt-1.5 text-[11px] font-semibold text-[#4CB729] hover:underline"
                        >
                          Review in Friends →
                        </button>
                      )}
                    </div>
                    {!item.read && (
                      <button
                        type="button"
                        onClick={() => void markRead(item.notificationId)}
                        aria-label="Mark notification read"
                        className="min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 shrink-0"
                      >
                        <Check className="w-3.5 h-3.5 text-[#4CB729]" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

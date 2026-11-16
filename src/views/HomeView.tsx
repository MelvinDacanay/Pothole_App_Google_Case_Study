import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Bell,
  Camera,
  Check,
  CheckCircle2,
  FileText,
  Gamepad2,
  Info,
  MapPin,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCommunityPotholes, useMySubmissions } from '../hooks/usePotholes';
import { useActivityFeed, useFriends, useNotifications } from '../hooks/useSocial';
import {
  COORDINATE_SOURCE_LABELS,
  POTHOLE_STATUS_LABELS,
  PotholeRecord,
} from '../lib/maps';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { PWAInstallButton } from '../components/PWAInstallButton';
import { NavTab } from '../components/AppShell';

interface HomeViewProps {
  onNavigate: (tab: NavTab) => void;
  onInspectPothole: (pothole: PotholeRecord) => void;
  onOpenCivic: () => void;
  onOpenGames: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  onNavigate,
  onInspectPothole,
  onOpenCivic,
  onOpenGames,
}) => {
  const { user, publicProfile, isSigningIn, signIn, isAdmin } = useAuth();
  const { potholes, loading } = useCommunityPotholes();
  const { submissions } = useMySubmissions(user?.uid ?? null);
  const { acceptedFriends, incomingRequests } = useFriends(user);
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications(user);
  const { events: feedEvents, loading: loadingFeed } = useActivityFeed();

  const [feedScope, setFeedScope] = useState<'all' | 'friends'>('all');
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolveMessage, setResolveMessage] = useState<string | null>(null);

  const pendingReviews = submissions.filter((s) => s.duplicateStatus === 'pending_review');

  const friendUidSet = useMemo(
    () => new Set(acceptedFriends.map((f) => f.otherUid)),
    [acceptedFriends]
  );

  const visibleFeedEvents = useMemo(() => {
    if (feedScope === 'friends' && user) {
      return feedEvents.filter((ev) => friendUidSet.has(ev.actorUid) || ev.actorUid === user.uid);
    }
    return feedEvents;
  }, [feedEvents, feedScope, friendUidSet, user]);

  const handleResolvePending = async (
    submissionId: string,
    resolution: 'confirm_distinct' | 'merge_evidence',
    targetPotholeId?: string
  ) => {
    if (!user) return;
    setResolvingId(submissionId);
    setResolveMessage(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/submissions/${encodeURIComponent(submissionId)}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ resolution, targetPotholeId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Unable to resolve duplicate review.');
      }
      setResolveMessage(
        data.duplicateStatus === 'distinct'
          ? 'Confirmed as distinct pothole and credited to your profile.'
          : 'Linked as supporting evidence on existing pothole.'
      );
    } catch (err) {
      setResolveMessage(err instanceof Error ? err.message : 'Unable to resolve review.');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero Overview */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-8 shadow-xs">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
          <div className="lg:col-span-8 space-y-4">
            <div className="text-xs font-medium text-[#6E6978] flex flex-wrap items-center gap-2">
              <span>Atlanta, Georgia</span>
              <span aria-hidden="true">·</span>
              <span>Community Road-Safety PWA</span>
              <span aria-hidden="true">·</span>
              <span>Live Map & Social Network</span>
            </div>

            <h1 className="font-display text-2xl sm:text-4xl font-extrabold tracking-tight text-[#2D2B35] text-balance">
              Document Atlanta potholes, verify corridors, and build cleaner streets together.
            </h1>

            <p className="text-sm sm:text-base text-[#4B4646] max-w-2xl leading-relaxed">
              PatchUp pairs GPS-verified street evidence with confidence-based duplicate review,
              interactive Atlanta mapping, friend connections, and distinct-pothole rankings.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {user ? (
                <button
                  type="button"
                  onClick={() => onNavigate('capture')}
                  className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition whitespace-nowrap shrink-0"
                >
                  <Camera className="w-4 h-4 shrink-0" />
                  <span>Capture a Pothole</span>
                </button>
              ) : (
                <GoogleSignInButton onClick={() => void signIn()} disabled={isSigningIn} />
              )}
              <button
                type="button"
                onClick={() => onNavigate('map')}
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold transition whitespace-nowrap shrink-0"
              >
                <MapPin className="w-4 h-4 text-[#4CB729] shrink-0" />
                <span>Explore Atlanta Map</span>
              </button>
              <button
                type="button"
                onClick={onOpenCivic}
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/30 text-[#2D2B35] text-sm font-semibold transition whitespace-nowrap shrink-0"
              >
                <FileText className="w-4 h-4 text-[#4CB729] shrink-0" />
                <span>{isAdmin ? 'Corridors & Admin Queue' : 'Corridors & 5-Pothole Reports'}</span>
              </button>
              <button
                type="button"
                onClick={onOpenGames}
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/30 text-[#2D2B35] text-sm font-semibold transition whitespace-nowrap shrink-0"
              >
                <Gamepad2 className="w-4 h-4 text-[#4CB729] shrink-0" />
                <span>Play Minigames</span>
              </button>
              <PWAInstallButton />
            </div>
          </div>

          <div className="lg:col-span-4 flex items-center justify-center bg-[#F7F7F8] rounded-2xl border border-[#E8DFC5] p-6">
            <img
              src="/assets/aistudio/PatchUp-Logo_18e66d4c.png"
              alt="PatchUp Atlanta street illustration"
              referrerPolicy="no-referrer"
              className="w-44 h-44 sm:w-52 sm:h-52 object-contain"
            />
          </div>
        </div>
      </section>

      {/* Personal Metrics + Community Pothole Records */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-5 bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">Personal Overview</h2>
            <span className="text-xs font-mono text-[#6E6978]">
              {user ? `@${publicProfile?.username ?? 'loading'}` : 'Guest view'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-[#F7F7F8] p-3.5 border border-[#E8DFC5]/70">
              <div className="text-xs text-[#6E6978]">Distinct Spots</div>
              <div className="mt-1 font-mono text-2xl font-bold text-[#2D2B35] tabular-nums">
                {publicProfile?.distinctPotholeCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl bg-[#F7F7F8] p-3.5 border border-[#E8DFC5]/70">
              <div className="text-xs text-[#6E6978]">Evidence</div>
              <div className="mt-1 font-mono text-2xl font-bold text-[#2D2B35] tabular-nums">
                {publicProfile?.evidenceCount ?? 0}
              </div>
            </div>
            <div className="rounded-xl bg-[#F7F7F8] p-3.5 border border-[#E8DFC5]/70">
              <div className="text-xs text-[#6E6978]">Badges</div>
              <div className="mt-1 font-mono text-2xl font-bold text-[#4CB729] tabular-nums">
                {publicProfile?.unlockedBadgesCount ?? 0}
              </div>
            </div>
          </div>

          {user && (
            <div className="pt-2 border-t border-[#E8DFC5] flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="text-[#4B4646] tabular-nums">
                {acceptedFriends.length} connected friends · {incomingRequests.length} incoming
                requests
              </span>
              <button
                type="button"
                onClick={() => onNavigate('profile')}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 font-semibold text-[#2D2B35] inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Users className="w-3.5 h-3.5 text-[#4CB729]" />
                <span>Manage Friends</span>
              </button>
            </div>
          )}

          <p className="text-xs text-[#6E6978] leading-relaxed">
            {user
              ? 'Distinct Spots credit unique accepted potholes; Evidence credits supporting verification photos without inflating distinct totals.'
              : 'Sign in with Google to connect with Atlanta contributors, unlock achievements, and track distinct-pothole rankings.'}
          </p>
        </section>

        <section className="lg:col-span-7 bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">
              Recent Atlanta Potholes
            </h2>
            <span className="text-xs text-[#6E6978] tabular-nums">
              {loading ? 'Loading...' : `${potholes.length} live records`}
            </span>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-[#6E6978]">
              Loading live Atlanta road-condition records...
            </div>
          ) : potholes.length === 0 ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-6 text-center space-y-2">
              <MapPin className="w-7 h-7 text-[#6E6978] mx-auto" />
              <h3 className="text-sm font-semibold text-[#2D2B35]">No pothole submissions yet</h3>
              <p className="text-xs text-[#6E6978] max-w-md mx-auto leading-relaxed">
                PatchUp displays real accepted community records only—no synthetic demo pins. Tap
                Capture to document the first Atlanta street defect.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[#E8DFC5]">
              {potholes.slice(0, 5).map((item) => (
                <button
                  key={item.potholeId}
                  type="button"
                  onClick={() => onInspectPothole(item)}
                  className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F7F7F8] px-2 -mx-2 rounded-xl transition min-h-[56px]"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={item.primaryPhotoUrl}
                      alt={item.streetName}
                      referrerPolicy="no-referrer"
                      className="w-12 h-12 rounded-xl object-cover border border-[#E8DFC5] shrink-0 bg-[#F7F7F8]"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#2D2B35] truncate">
                        {item.streetName}
                      </div>
                      <div className="text-xs text-[#6E6978] truncate">
                        {POTHOLE_STATUS_LABELS[item.status] ?? item.status} ·{' '}
                        {COORDINATE_SOURCE_LABELS[item.coordinateSource]} · @
                        {item.primaryContributorUsername}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm font-bold text-[#2D2B35] tabular-nums">
                      {item.evidenceCount}
                    </div>
                    <div className="text-[11px] text-[#6E6978]">evidence</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-[#E8DFC5] flex items-start gap-2.5 text-xs text-[#6E6978]">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#4B4646]" />
            <span>
              PatchUp is an independent civic-social platform and is not operated by or officially
              integrated with the City of Atlanta, ATL311, or GDOT.
            </span>
          </div>
        </section>
      </div>

      {/* Social Activity Feed & In-App Notifications */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-bold text-[#2D2B35]">
                Community Activity Feed
              </h2>
              <p className="text-xs text-[#6E6978]">
                Street-level milestones and badge unlocks—no private locations exposed.
              </p>
            </div>

            {user && (
              <div className="inline-flex items-center gap-1 p-1 bg-[#F7F7F8] border border-[#E8DFC5] rounded-xl">
                <button
                  type="button"
                  onClick={() => setFeedScope('all')}
                  className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                    feedScope === 'all'
                      ? 'bg-white text-[#2D2B35] shadow-xs'
                      : 'text-[#6E6978] hover:text-[#2D2B35]'
                  }`}
                >
                  All Atlanta
                </button>
                <button
                  type="button"
                  onClick={() => setFeedScope('friends')}
                  className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                    feedScope === 'friends'
                      ? 'bg-white text-[#2D2B35] shadow-xs'
                      : 'text-[#6E6978] hover:text-[#2D2B35]'
                  }`}
                >
                  Friends
                </button>
              </div>
            )}
          </div>

          {loadingFeed ? (
            <div className="py-6 text-xs text-[#6E6978]">Loading community activity...</div>
          ) : visibleFeedEvents.length === 0 ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
              {feedScope === 'friends'
                ? 'No recent activity from connected friends yet. Search for contributors on Profile to connect.'
                : 'No community events recorded yet. Document a pothole or unlock your first badge to start the feed.'}
            </div>
          ) : (
            <div className="divide-y divide-[#E8DFC5]">
              {visibleFeedEvents.slice(0, 8).map((ev) => {
                const matchingPothole = ev.potholeId
                  ? potholes.find((p) => p.potholeId === ev.potholeId)
                  : undefined;
                return (
                  <div
                    key={ev.eventId}
                    className="py-3 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-[#2D2B35]">{ev.summary}</div>
                      <div className="text-[11px] text-[#6E6978] mt-0.5">
                        {ev.actorDisplayName}
                        {ev.neighborhood ? ` · ${ev.neighborhood}` : ''}
                      </div>
                    </div>
                    {matchingPothole && (
                      <button
                        type="button"
                        onClick={() => onInspectPothole(matchingPothole)}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 font-semibold text-[#2D2B35] whitespace-nowrap shrink-0"
                      >
                        View Pin
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="lg:col-span-5 bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bell className="w-5 h-5 text-[#4CB729]" />
              <h2 className="font-display text-lg font-bold text-[#2D2B35]">Notifications</h2>
              {user && unreadCount > 0 && (
                <span className="font-mono text-xs font-bold text-[#4CB729] tabular-nums">
                  ({unreadCount} unread)
                </span>
              )}
            </div>
            {user && unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] whitespace-nowrap"
              >
                Mark all read
              </button>
            )}
          </div>

          {!user ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
              Sign in with Google to receive in-app notifications for friend requests, badge
              unlocks, and street milestones.
            </div>
          ) : notifications.length === 0 ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
              You are all caught up. Friend requests, badge unlocks, and milestone alerts appear
              here.
            </div>
          ) : (
            <div className="divide-y divide-[#E8DFC5] max-h-72 overflow-y-auto pr-1">
              {notifications.slice(0, 12).map((item) => (
                <div
                  key={item.notificationId}
                  className={`py-3 flex items-start justify-between gap-3 text-xs ${
                    item.read ? 'opacity-70' : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-[#2D2B35]">{item.title}</div>
                    <p className="text-[#4B4646] mt-0.5 leading-relaxed">{item.body}</p>
                    {item.type === 'friend_request' && (
                      <button
                        type="button"
                        onClick={() => onNavigate('profile')}
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
                      className="min-w-[38px] min-h-[38px] flex items-center justify-center rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] shrink-0"
                    >
                      <Check className="w-4 h-4 text-[#4CB729]" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Pending Duplicate Reviews for Signed-In Contributor */}
      {user && pendingReviews.length > 0 && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-[#D97706]" />
              <h2 className="font-display text-lg font-bold text-[#2D2B35]">
                Your Provisional Duplicate Reviews ({pendingReviews.length})
              </h2>
            </div>
            <span className="text-xs text-[#6E6978]">Excluded from counts until resolved</span>
          </div>

          {resolveMessage && (
            <div className="rounded-xl bg-[#4CB729]/10 border border-[#4CB729]/30 px-4 py-2.5 text-xs text-[#2D2B35] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-[#4CB729] shrink-0" />
              <span>{resolveMessage}</span>
            </div>
          )}

          <div className="divide-y divide-[#E8DFC5]">
            {pendingReviews.map((sub) => {
              const firstCandidateId = sub.candidatePotholeIds?.[0];
              return (
                <div
                  key={sub.submissionId}
                  className="py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={sub.photoUrl}
                      alt={sub.streetName}
                      referrerPolicy="no-referrer"
                      className="w-12 h-12 rounded-xl object-cover border border-[#E8DFC5] shrink-0 bg-[#F7F7F8]"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#2D2B35] truncate">
                        {sub.formattedAddress}
                      </div>
                      <div className="text-xs text-[#6E6978]">
                        Hold reason: nearby candidate within 25m · Confidence{' '}
                        {Math.round(sub.duplicateConfidence * 100)}%
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {firstCandidateId && (
                      <button
                        type="button"
                        disabled={resolvingId === sub.submissionId}
                        onClick={() =>
                          void handleResolvePending(
                            sub.submissionId,
                            'merge_evidence',
                            firstCandidateId
                          )
                        }
                        className="min-h-[40px] px-3 py-1.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] whitespace-nowrap disabled:opacity-50"
                      >
                        Merge as Evidence
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={resolvingId === sub.submissionId}
                      onClick={() =>
                        void handleResolvePending(sub.submissionId, 'confirm_distinct')
                      }
                      className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-xs font-semibold text-white whitespace-nowrap disabled:opacity-50"
                    >
                      Confirm Separate Pothole
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
};

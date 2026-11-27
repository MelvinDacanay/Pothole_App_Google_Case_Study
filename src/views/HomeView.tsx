import { ProtectedImage } from '../components/ProtectedImage';
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Award,
  Bell,
  Camera,
  Check,
  CheckCircle2,
  Flame,
  Info,
  MapPin,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCommunityPotholes, useMySubmissions } from '../hooks/usePotholes';
import { useActivityFeed, useFriends, useNotifications } from '../hooks/useSocial';
import {
  loadMapsClientConfig,
  MapsClientConfig,
  POTHOLE_STATUS_LABELS,
  PotholeRecord,
} from '../lib/maps';
import { NavTab } from '../components/AppShell';
import { AtlantaMap } from '../components/AtlantaMap';
import { AchievementBadge } from '../components/AchievementBadge';

interface HomeViewProps {
  onNavigate: (tab: NavTab) => void;
  onInspectPothole: (pothole: PotholeRecord) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  onNavigate,
  onInspectPothole,
}) => {
  const { user, publicProfile } = useAuth();
  const { potholes, loading } = useCommunityPotholes();
  const { submissions } = useMySubmissions(user?.uid ?? null);
  const { acceptedFriends, incomingRequests } = useFriends(user);
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications(user);
  const { events: feedEvents, loading: loadingFeed } = useActivityFeed();

  const [feedScope, setFeedScope] = useState<'all' | 'friends'>('all');
  const [mapsConfig, setMapsConfig] = useState<MapsClientConfig>({
    configured: false,
    apiKey: '',
    mapId: 'DEMO_MAP_ID',
  });

  useEffect(() => {
    loadMapsClientConfig().then(setMapsConfig);
  }, []);

  const classifierAppeals = submissions.filter(s=>s.duplicateStatus==='pending_review');
  const gallerySubmissions = submissions.filter(
    (s) => s.duplicateStatus !== 'pending_review' && s.duplicateStatus !== 'rejected'
  );
  const communityGalleryPotholes = potholes.filter((pothole) => pothole.status !== 'provisional');
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  today.setUTCDate(today.getUTCDate() - 1);
  const yesterdayKey = today.toISOString().slice(0, 10);
  const dailyStreak =
    publicProfile?.lastCollectedDate === todayKey ||
    publicProfile?.lastCollectedDate === yesterdayKey
      ? publicProfile.dailyStreak
      : 0;

  const visibleFeedEvents=feedEvents;

  return (
    <div className="city-page city-home editorial-home signed-in-home space-y-6">
      <section className="home-command">
        <div className="home-command-copy">
          <span className="page-banner-index">FOUND A POTHOLE?</span>
          <h1>TAKE A PHOTO.<br /><em>WE’LL HANDLE<br />THE REST.</em></h1>
          <p>
            PatchUp verifies the image, captures the location, checks nearby reports, and puts the
            result on the map.
          </p>
          <button type="button" onClick={() => onNavigate('capture')} className="home-snap-action">
            <Camera className="w-5 h-5" />
            <span>Take a pothole photo</span>
            <ArrowRight className="w-5 h-5" />
          </button>
        </div>
        <div className="home-live-map">
          <div className="home-map-label">
            <span>LIVE ATLANTA STREET MAP</span>
            <strong>{loading ? '—' : potholes.length} reports</strong>
          </div>
          <AtlantaMap
            mapsConfig={mapsConfig}
            potholes={potholes}
            selectedPotholeId={null}
            onSelectPothole={(pothole) => {
              if (pothole) onInspectPothole(pothole);
            }}
            focusCoords={null}
          />
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

          <div className="personal-kpi-grid">
            <div className="personal-kpi-card">
              <span className="personal-kpi-icon personal-kpi-icon-capture">
                <Camera aria-hidden="true" />
              </span>
              <div>
                <div className="personal-kpi-label">Potholes Collected</div>
                <div className="personal-kpi-value tabular-nums">
                  {publicProfile?.potholesCollectedCount ?? gallerySubmissions.length}
                </div>
              </div>
            </div>
            <div className="personal-kpi-card">
              <span className="personal-kpi-icon personal-kpi-icon-badge">
                <Award aria-hidden="true" />
              </span>
              <div>
                <div className="personal-kpi-label">Badges Earned</div>
                <div className="personal-kpi-value tabular-nums">
                  {publicProfile?.unlockedBadgesCount ?? 0}
                </div>
              </div>
            </div>
            <div className="personal-kpi-card">
              <span className="personal-kpi-icon personal-kpi-icon-streak">
                <Flame aria-hidden="true" />
              </span>
              <div>
                <div className="personal-kpi-label">Daily Streak</div>
                <div className="personal-kpi-value tabular-nums">
                  {dailyStreak}
                  <small>{dailyStreak === 1 ? ' day' : ' days'}</small>
                </div>
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
                className="min-h-[44px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 font-semibold text-[#2D2B35] inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Users className="w-3.5 h-3.5 text-[#4CB729]" />
                <span>Manage Friends</span>
              </button>
            </div>
          )}

          <p className="text-xs text-[#6E6978] leading-relaxed">
            {user
              ? 'Collected potholes include every photo approved by PatchUp or an admin. Your streak grows when at least one capture is approved on consecutive days.'
              : 'Sign in with Google to connect with Atlanta Patchers, unlock achievements, and track distinct-pothole rankings.'}
          </p>
        </section>

        <section className="community-gallery lg:col-span-7 bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="page-banner-index">FROM PATCHERS ACROSS ATLANTA</span>
              <h2 className="font-display text-lg font-bold text-[#2D2B35]">
                Community Gallery
              </h2>
            </div>
            <span className="text-xs text-[#6E6978] tabular-nums">
              {loading ? 'Loading...' : `${communityGalleryPotholes.length} captures`}
            </span>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-[#6E6978]">
              Loading the community gallery...
            </div>
          ) : communityGalleryPotholes.length === 0 ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-6 text-center space-y-2">
              <MapPin className="w-7 h-7 text-[#6E6978] mx-auto" />
              <h3 className="text-sm font-semibold text-[#2D2B35]">No community captures yet</h3>
              <p className="text-xs text-[#6E6978] max-w-md mx-auto leading-relaxed">
                Approved potholes captured by Patchers across Atlanta will appear here.
              </p>
            </div>
          ) : (
            <div className="community-polaroid-grid">
              {communityGalleryPotholes.slice(0, 6).map((item) => (
                <button
                  key={item.potholeId}
                  type="button"
                  onClick={() => onInspectPothole(item)}
                  className="community-polaroid"
                >
                  <span className="community-polaroid-photo">
                    <ProtectedImage publicPhoto src={item.primaryPhotoUrl+'?variant=thumb'} alt={item.streetName} referrerPolicy="no-referrer" />
                  </span>
                  <span className="community-polaroid-caption">
                    <span className="community-polaroid-location">{item.streetName}</span>
                    <span className="community-polaroid-author">
                      <span className="community-polaroid-avatar">
                        {item.primaryContributorPhotoURL ? (
                          <img
                            src={item.primaryContributorPhotoURL}
                            alt=""
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          item.primaryContributorDisplayName.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="community-polaroid-identity">
                        <strong>@{item.primaryContributorUsername}</strong>
                        <small>{POTHOLE_STATUS_LABELS[item.status] ?? item.status}</small>
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-[#E8DFC5] flex items-start gap-2.5 text-xs text-[#6E6978]">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#4B4646]" />
            <span>
              PatchUp is an independent community-social platform and is not operated by or officially
              integrated with the City of Atlanta, ATL311, or GDOT.
            </span>
          </div>
        </section>
      </div>

      <section className="home-gallery bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="home-section-heading">
          <div>
            <span className="page-banner-index">YOUR CAMERA ROLL</span>
            <h2 className="font-display text-xl font-bold text-[#2D2B35]">Potholes you’ve captured</h2>
            <p>Only verified captures appear here, organized for quick scanning.</p>
          </div>
          <span className="home-gallery-count tabular-nums">
            <strong>{gallerySubmissions.length}</strong>
            approved {gallerySubmissions.length === 1 ? 'capture' : 'captures'}
          </span>
        </div>
        {gallerySubmissions.length === 0 ? (
          <div className="home-gallery-empty">
            <Camera className="w-7 h-7" />
            <div>
              <strong>Your gallery starts with one snap.</strong>
              <p>Photograph a pothole and it will appear here after processing.</p>
            </div>
            <button type="button" onClick={() => onNavigate('capture')}>Take your first photo</button>
          </div>
        ) : (
          <div className="home-photo-grid">
            {gallerySubmissions.slice(0, 8).map((submission) => (
              <figure key={submission.submissionId}>
                <div className="home-photo-frame">
                  <ProtectedImage
                    src={submission.photoUrl+'?variant=thumb'}
                    alt={`Pothole submission at ${submission.streetName}`}
                    referrerPolicy="no-referrer"
                  />
                </div>
                <figcaption>
                  <strong>{submission.streetName}</strong>
                  <span>
                    {submission.duplicateStatus === 'distinct'
                      ? 'New pothole'
                      : 'Supporting evidence'}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

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


          </div>

          {loadingFeed ? (
            <div className="py-6 text-xs text-[#6E6978]">Loading community activity...</div>
          ) : visibleFeedEvents.length === 0 ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
              {feedScope === 'friends'
                ? 'No recent activity from connected friends yet. Search for Patchers on Profile to connect.'
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
                        className="min-h-[44px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 font-semibold text-[#2D2B35] whitespace-nowrap shrink-0"
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
                className="min-h-[44px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] whitespace-nowrap"
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
                  <div className="min-w-0 flex items-start gap-2.5">
                    {item.type === 'badge_unlocked' && item.relatedId && (
                      <AchievementBadge
                        badgeType={item.relatedId}
                        state="earned"
                        title={item.title.replace(/^Badge Unlocked:\s*/i, '')}
                        className="w-12 h-12 -my-1"
                      />
                    )}
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

      {user && classifierAppeals.length > 0 && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5 text-[#D97706]" />
              <h2 className="font-display text-lg font-bold text-[#2D2B35]">
                Photos awaiting admin review ({classifierAppeals.length})
              </h2>
            </div>
            <span className="text-xs text-[#6E6978]">Not counted while under review</span>
          </div>
          <div className="divide-y divide-[#E8DFC5]">
            {classifierAppeals.map((sub) => (
              <div
                key={sub.submissionId}
                className="py-3.5 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <ProtectedImage
                    src={sub.photoUrl+'?variant=thumb'}
                    alt={sub.streetName}
                    referrerPolicy="no-referrer"
                    className="w-12 h-12 rounded-xl object-cover border border-[#E8DFC5] shrink-0 bg-[#F7F7F8]"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#2D2B35] truncate">
                      {sub.formattedAddress}
                    </div>
                    <div className="text-xs text-[#6E6978]">
                      An admin will review your photo before it can be counted.
                    </div>
                  </div>
                </div>
                <span className="font-mono text-[11px] font-bold uppercase text-[#6E6978]">
                  In review
                </span>
              </div>
            ))}
          </div>
        </section>
      )}



    </div>
  );
};

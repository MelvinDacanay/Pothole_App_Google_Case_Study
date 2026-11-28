import React, { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Loader2, MapPin, UserX } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import type { PublicContributorProfile } from '../lib/maps';
import { formatDate } from '../lib/caseFormat';

interface PublicProfileViewProps {
  uid: string;
  onBack: () => void;
}

type LoadState = 'loading' | 'ready' | 'not_found' | 'error' | 'unavailable';

export const PublicProfileView: React.FC<PublicProfileViewProps> = ({ uid, onBack }) => {
  const { user } = useAuth();
  const [profile, setProfile] = useState<PublicContributorProfile | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setState('loading');
    user
      .getIdToken()
      .then((token) =>
        fetch(`/api/profile/${encodeURIComponent(uid)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 503) return setState('unavailable');
        if (res.status === 404) return setState('not_found');
        if (!res.ok) return setState('error');
        const data = (await res.json()) as { profile?: PublicContributorProfile };
        if (!data.profile) return setState('error');
        setProfile(data.profile);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [user, uid]);

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-[#536159] hover:text-[#2D2B35]"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      {state === 'loading' && (
        <div className="py-16 text-center text-sm text-[#6E6978]">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-3 text-[#4CB729]" />
          Loading profile…
        </div>
      )}

      {(state === 'not_found' || state === 'unavailable' || state === 'error') && (
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-10 text-center space-y-2">
          <UserX className="w-8 h-8 text-[#6E6978] mx-auto" />
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">
            {state === 'unavailable' ? 'Profiles unavailable here' : 'Profile not available'}
          </h2>
          <p className="text-sm text-[#6E6978]">
            {state === 'unavailable'
              ? 'The profile service is offline in this environment.'
              : state === 'error'
                ? 'Something went wrong loading this profile.'
                : 'This contributor isn’t sharing a public profile.'}
          </p>
        </div>
      )}

      {state === 'ready' && profile && (
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-6 sm:p-8 space-y-6">
          <div className="flex items-center gap-4">
            {profile.photoURL ? (
              <img
                src={profile.photoURL}
                alt={profile.displayName}
                referrerPolicy="no-referrer"
                className="w-16 h-16 rounded-full object-cover border border-[#E8DFC5]"
              />
            ) : (
              <span className="w-16 h-16 rounded-full bg-[#3A3535] text-white text-xl font-bold flex items-center justify-center">
                {profile.displayName.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="font-display text-2xl font-bold text-[#2D2B35] truncate">
                {profile.displayName}
              </h1>
              <p className="text-sm text-[#6E6978] font-mono truncate">@{profile.username}</p>
              {profile.homeNeighborhood && (
                <p className="text-xs text-[#536159] inline-flex items-center gap-1 mt-0.5">
                  <MapPin className="w-3 h-3" /> {profile.homeNeighborhood}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Stat value={profile.distinctPotholeCount} label="Potholes reported" accent />
            <Stat value={profile.evidenceCount} label="Evidence" />
            <Stat value={profile.unlockedBadgesCount} label="Badges" />
          </div>

          <p className="text-[11px] text-[#6E6978] inline-flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-[#4CB729]" />
            Counts are server-verified distinct reports — drafts and private cases aren’t shown.
          </p>

          {profile.joinedAtMillis && (
            <p className="text-xs text-[#6E6978] pt-1 border-t border-[#E8DFC5]">
              Joined {formatDate(profile.joinedAtMillis)}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

const Stat: React.FC<{ value: number; label: string; accent?: boolean }> = ({
  value,
  label,
  accent,
}) => (
  <div
    className={`rounded-xl border p-4 text-center ${
      accent ? 'border-[#4CB729]/50 bg-[#4CB729]/5' : 'border-[#E8DFC5] bg-[#F7F7F8]'
    }`}
  >
    <div className="font-mono text-2xl font-bold text-[#2D2B35] tabular-nums">{value}</div>
    <div className="text-[11px] text-[#6E6978] mt-0.5">{label}</div>
  </div>
);

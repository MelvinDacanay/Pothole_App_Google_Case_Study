import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Camera,
  Check,
  Database,
  FileText,
  Gamepad2,
  HardDrive,
  LogOut,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useMySubmissions } from '../hooks/usePotholes';
import { FriendSearchUser, useFriends } from '../hooks/useSocial';
import { compressImageForUpload, uploadImageWithRetry } from '../lib/imageUpload';
import { COORDINATE_SOURCE_LABELS } from '../lib/maps';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { PWAInstallButton } from '../components/PWAInstallButton';

interface ServerHealth {
  ok: boolean;
  service: string;
  phase: number;
  firebaseConfigured: boolean;
  firebaseProjectId: string | null;
  firestoreDatabaseId: string | null;
  firebaseStorageEnabled: boolean;
  mediaStoreMode: string;
  mapsConfigured: boolean;
  adminSdkMode: string;
  adminAuthVerifyReady: boolean;
  adminFirestoreReady: boolean;
  geminiConfigured: boolean;
  geminiModel: string;
}

interface ProfileViewProps {
  onOpenCivic: () => void;
  onOpenGames: () => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({ onOpenCivic, onOpenGames }) => {
  const {
    user,
    publicProfile,
    privateAccount,
    isAdmin,
    firestoreStatus,
    authError,
    isSigningIn,
    signIn,
    signOut,
    updateProfile,
    updateNotificationsPref,
  } = useAuth();

  const { submissions, loading: loadingSubmissions } = useMySubmissions(user?.uid ?? null);
  const {
    acceptedFriends,
    incomingRequests,
    outgoingRequests,
    sendFriendRequest,
    respondToFriend,
    searchUsers,
  } = useFriends(user);

  const [displayNameInput, setDisplayNameInput] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [neighborhoodInput, setNeighborhoodInput] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Avatar upload via Spark-tier isolated /mediaObjects
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // Friends search & action feedback
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<FriendSearchUser[]>([]);
  const [friendFeedback, setFriendFeedback] = useState<string | null>(null);

  // Web Push / Browser Notification capability check
  const [browserPushPermission, setBrowserPushPermission] = useState<string>(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? window.Notification.permission
      : 'unsupported'
  );

  const [serverHealth, setServerHealth] = useState<ServerHealth | null>(null);
  const [tokenSessionStatus, setTokenSessionStatus] = useState<string>('Not checked');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (publicProfile) {
      setDisplayNameInput(publicProfile.displayName);
      setUsernameInput(publicProfile.username);
      setNeighborhoodInput(publicProfile.homeNeighborhood ?? '');
    }
  }, [publicProfile]);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data: ServerHealth) => setServerHealth(data))
      .catch(() => setServerHealth(null));
  }, []);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    setSaveMessage(null);
    setSaving(true);
    try {
      await updateProfile({
        displayName: displayNameInput,
        username: usernameInput,
        homeNeighborhood: neighborhoodInput,
      });
      setSaveMessage('Profile updated and synced with leaderboard.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to save profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setSaveError(null);
    setSaveMessage(null);
    setUploadingAvatar(true);
    try {
      const compressed = await compressImageForUpload(file);
      const mediaId = `avt_${user.uid.slice(0, 8)}_${Date.now()}`;
      const res = await uploadImageWithRetry({
        uid: user.uid,
        fileId: mediaId,
        compressed,
      });
      await updateProfile({ photoURL: res.downloadUrl });
      setSaveMessage('Profile avatar updated.');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Avatar upload failed.');
    } finally {
      setUploadingAvatar(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const handleFriendSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim().length < 2) {
      setFriendFeedback('Enter at least 2 characters to search by username or display name.');
      return;
    }
    setSearching(true);
    setFriendFeedback(null);
    try {
      const users = await searchUsers(searchQuery);
      setSearchResults(users);
      if (users.length === 0) {
        setFriendFeedback('No matching contributors found.');
      }
    } catch {
      setFriendFeedback('Search failed. Please try again.');
    } finally {
      setSearching(false);
    }
  };

  const handleSendFriendRequest = async (targetUid: string) => {
    setFriendFeedback(null);
    try {
      const res = await sendFriendRequest(targetUid);
      setFriendFeedback(
        res.status === 'accepted' ? 'Friend connection accepted.' : 'Friend request sent.'
      );
      if (searchQuery.trim().length >= 2) {
        const refreshed = await searchUsers(searchQuery);
        setSearchResults(refreshed);
      }
    } catch (err) {
      setFriendFeedback(err instanceof Error ? err.message : 'Unable to send request.');
    }
  };

  const handleFriendAction = async (
    friendshipId: string,
    action: 'accept' | 'decline' | 'remove'
  ) => {
    setFriendFeedback(null);
    try {
      await respondToFriend(friendshipId, action);
      setFriendFeedback(
        action === 'accept'
          ? 'Friend request accepted.'
          : action === 'decline'
            ? 'Friend request declined.'
            : 'Connection removed.'
      );
    } catch (err) {
      setFriendFeedback(err instanceof Error ? err.message : 'Unable to update friendship.');
    }
  };

  const handleRequestBrowserNotifications = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setBrowserPushPermission('unsupported');
      return;
    }
    try {
      const permission = await window.Notification.requestPermission();
      setBrowserPushPermission(permission);
    } catch {
      // Ignore permission rejection
    }
  };

  const verifyBackendToken = async () => {
    if (!user) return;
    setTokenSessionStatus('Checking...');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch('/api/auth/session', {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json();
      if (res.ok) {
        setTokenSessionStatus(`Verified (${data.uid}, admin=${String(data.admin)})`);
      } else {
        setTokenSessionStatus(`Server returned ${res.status}: ${data.error}`);
      }
    } catch (err) {
      setTokenSessionStatus(err instanceof Error ? err.message : 'Request failed');
    }
  };

  const handleDeleteAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || deleteConfirmInput.trim() !== 'DELETE') return;
    setDeletingAccount(true);
    setDeleteError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/account', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirmText: 'DELETE' }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Unable to delete account.');
      }
      setShowDeleteConfirm(false);
      setDeleteConfirmInput('');
      await signOut();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Account deletion failed.');
    } finally {
      setDeletingAccount(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="relative">
              {publicProfile?.photoURL ? (
                <img
                  src={publicProfile.photoURL}
                  alt={publicProfile.displayName}
                  referrerPolicy="no-referrer"
                  className="w-16 h-16 rounded-2xl object-cover border border-[#E8DFC5]"
                />
              ) : (
                <div className="w-16 h-16 rounded-2xl bg-[#F7F7F8] border border-[#E8DFC5] flex items-center justify-center font-display text-2xl font-bold text-[#3A3535]">
                  {(publicProfile?.displayName || 'P').slice(0, 1).toUpperCase()}
                </div>
              )}
              {user && (
                <>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => void handleAvatarUpload(e)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    disabled={uploadingAvatar}
                    onClick={() => avatarInputRef.current?.click()}
                    aria-label="Update profile photo"
                    className="mt-1.5 text-[11px] font-semibold text-[#4CB729] hover:underline inline-flex items-center gap-1"
                  >
                    <Camera className="w-3 h-3" />
                    <span>{uploadingAvatar ? 'Uploading...' : 'Change photo'}</span>
                  </button>
                </>
              )}
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
                {user ? publicProfile?.displayName || 'Signed-in Contributor' : 'Guest Profile'}
              </h1>
              <div className="text-xs text-[#6E6978] flex flex-wrap items-center gap-2 mt-1">
                <span>{user ? `@${publicProfile?.username ?? '...'}` : 'Not signed in'}</span>
                {publicProfile?.shareNeighborhood && publicProfile.homeNeighborhood && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{publicProfile.homeNeighborhood}</span>
                  </>
                )}
                {isAdmin && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-semibold text-[#4CB729]">Admin Claim Active</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onOpenGames}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/30 text-xs font-semibold text-[#2D2B35] transition whitespace-nowrap"
            >
              <Gamepad2 className="w-4 h-4 text-[#4CB729]" />
              <span>PatchUp Arcade</span>
            </button>
            <button
              type="button"
              onClick={onOpenCivic}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/30 text-xs font-semibold text-[#2D2B35] transition whitespace-nowrap"
            >
              <FileText className="w-4 h-4 text-[#4CB729]" />
              <span>{isAdmin ? 'Admin Civic Queue' : 'Corridors & Reports'}</span>
            </button>
            <PWAInstallButton compact />
            {user ? (
              <button
                type="button"
                onClick={() => void signOut()}
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-sm font-semibold text-[#3A3535] transition whitespace-nowrap"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign out</span>
              </button>
            ) : (
              <GoogleSignInButton onClick={() => void signIn()} disabled={isSigningIn} />
            )}
          </div>
        </div>

        {authError && (
          <div className="rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/30 px-4 py-3 text-sm text-[#DC2626]">
            {authError}
          </div>
        )}

        {user && publicProfile && (
          <form
            onSubmit={(e) => void handleSaveProfile(e)}
            className="space-y-5 pt-2 border-t border-[#E8DFC5]"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-[#4B4646]">Display Name (Public)</span>
                <input
                  type="text"
                  maxLength={64}
                  required
                  value={displayNameInput}
                  onChange={(e) => setDisplayNameInput(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-[#4B4646]">Username (Public)</span>
                <input
                  type="text"
                  maxLength={32}
                  required
                  pattern="^[a-z0-9_]{3,32}$"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value.toLowerCase())}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm font-mono text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-semibold text-[#4B4646]">
                  Atlanta Neighborhood (Optional)
                </span>
                <input
                  type="text"
                  maxLength={64}
                  placeholder="e.g., Midtown"
                  value={neighborhoodInput}
                  onChange={(e) => setNeighborhoodInput(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
                />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] cursor-pointer min-h-[44px]">
                <span className="text-sm font-medium text-[#3A3535]">Show on Leaderboard</span>
                <input
                  type="checkbox"
                  checked={publicProfile.showOnLeaderboard}
                  onChange={(e) => void updateProfile({ showOnLeaderboard: e.target.checked })}
                  className="w-5 h-5 accent-[#4CB729]"
                />
              </label>

              <label className="flex items-center justify-between gap-3 p-3.5 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] cursor-pointer min-h-[44px]">
                <span className="text-sm font-medium text-[#3A3535]">Share Neighborhood</span>
                <input
                  type="checkbox"
                  checked={publicProfile.shareNeighborhood}
                  onChange={(e) => void updateProfile({ shareNeighborhood: e.target.checked })}
                  className="w-5 h-5 accent-[#4CB729]"
                />
              </label>
            </div>

            {privateAccount && (
              <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#4B4646]">
                    Private Account Record (Owner-Only Subcollection)
                  </span>
                  <span className="text-xs font-mono text-[#6E6978]">{privateAccount.email}</span>
                </div>
                <label className="flex items-center justify-between gap-3 cursor-pointer min-h-[44px]">
                  <span className="text-sm text-[#3A3535]">In-App Notifications Enabled</span>
                  <input
                    type="checkbox"
                    checked={privateAccount.notificationsEnabled}
                    onChange={(e) => void updateNotificationsPref(e.target.checked)}
                    className="w-5 h-5 accent-[#4CB729]"
                  />
                </label>

                <div className="pt-2 border-t border-[#E8DFC5] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2 text-[#4B4646]">
                    <Bell className="w-4 h-4 text-[#6E6978]" />
                    <span>
                      Browser Push Status:{' '}
                      <span className="font-mono font-semibold text-[#2D2B35]">
                        {browserPushPermission}
                      </span>{' '}
                      (in-app inbox always active)
                    </span>
                  </div>
                  {browserPushPermission === 'default' && (
                    <button
                      type="button"
                      onClick={() => void handleRequestBrowserNotifications()}
                      className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/40 font-semibold text-[#2D2B35]"
                    >
                      Enable Browser Alerts
                    </button>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={saving}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Save Profile'}
              </button>
              {saveMessage && <span className="text-xs font-medium text-[#4CB729]">{saveMessage}</span>}
              {saveError && <span className="text-xs font-medium text-[#DC2626]">{saveError}</span>}
            </div>
          </form>
        )}
      </section>

      {/* Friends & Community Connections */}
      {user && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-lg font-bold text-[#2D2B35]">
                Friends & Connections ({acceptedFriends.length})
              </h2>
              <p className="text-xs text-[#6E6978] mt-0.5">
                Search contributors by username to connect, filter the Atlanta map, and follow
                street-level progress.
              </p>
            </div>
            <Users className="w-5 h-5 text-[#4CB729] shrink-0" />
          </div>

          <form onSubmit={(e) => void handleFriendSearch(e)} className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search username or display name..."
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
            />
            <button
              type="submit"
              disabled={searching}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#2D2B35] hover:bg-[#3A3535] text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Search className="w-4 h-4" />
              <span>{searching ? 'Searching...' : 'Search'}</span>
            </button>
          </form>

          {friendFeedback && (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] px-3.5 py-2.5 text-xs text-[#2D2B35]">
              {friendFeedback}
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-[#4B4646]">Search Results</div>
              <div className="divide-y divide-[#E8DFC5] rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] px-3">
                {searchResults.map((match) => (
                  <div key={match.uid} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[#2D2B35] truncate">
                        {match.displayName}
                      </div>
                      <div className="text-[11px] font-mono text-[#6E6978] truncate">
                        @{match.username} · {match.distinctPotholeCount} distinct
                      </div>
                    </div>

                    {match.friendshipStatus === 'accepted' ? (
                      <span className="text-xs font-semibold text-[#4CB729] shrink-0">Friends</span>
                    ) : match.friendshipStatus === 'pending' ? (
                      <span className="text-xs font-semibold text-[#D97706] shrink-0">
                        {match.direction === 'incoming' ? 'Requested you' : 'Pending'}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSendFriendRequest(match.uid)}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1.5 shrink-0"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>Add Friend</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {incomingRequests.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-[#2D2B35]">
                Incoming Friend Requests ({incomingRequests.length})
              </div>
              <div className="divide-y divide-[#E8DFC5] rounded-xl border border-[#E8DFC5] px-3">
                {incomingRequests.map((reqItem) => (
                  <div
                    key={reqItem.friendshipId}
                    className="py-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[#2D2B35] truncate">
                        {reqItem.displayName}
                      </div>
                      <div className="text-[11px] font-mono text-[#6E6978] truncate">
                        @{reqItem.username}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleFriendAction(reqItem.friendshipId, 'accept')}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Accept</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleFriendAction(reqItem.friendshipId, 'decline')}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] text-xs font-semibold text-[#2D2B35]"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {acceptedFriends.length > 0 ? (
            <div className="divide-y divide-[#E8DFC5]">
              {acceptedFriends.map((fr) => (
                <div key={fr.friendshipId} className="py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {fr.photoURL ? (
                      <img
                        src={fr.photoURL}
                        alt={fr.displayName}
                        referrerPolicy="no-referrer"
                        className="w-9 h-9 rounded-full object-cover border border-[#E8DFC5] shrink-0"
                      />
                    ) : (
                      <span className="w-9 h-9 rounded-full bg-[#3A3535] text-white text-xs font-bold flex items-center justify-center shrink-0">
                        {fr.displayName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#2D2B35] truncate">
                        {fr.displayName}
                      </div>
                      <div className="text-xs font-mono text-[#6E6978] truncate">
                        @{fr.username} · {fr.distinctPotholeCount} distinct · {fr.evidenceCount}{' '}
                        evidence
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleFriendAction(fr.friendshipId, 'remove')}
                    aria-label={`Remove ${fr.username}`}
                    className="min-w-[38px] min-h-[38px] flex items-center justify-center rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#DC2626]/10 text-[#6E6978] hover:text-[#DC2626] shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-4 text-xs text-[#6E6978]">
              No accepted friends yet. Search by username above to send your first request.
            </div>
          )}

          {outgoingRequests.length > 0 && (
            <div className="text-xs text-[#6E6978]">
              Outgoing requests pending:{' '}
              {outgoingRequests.map((o) => `@${o.username}`).join(', ')}
            </div>
          )}
        </section>
      )}

      {/* Personal Pothole & Evidence Collection */}
      {user && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">
              Your Pothole Submissions ({submissions.length})
            </h2>
            <span className="text-xs text-[#6E6978]">Live Personal Collection</span>
          </div>

          {loadingSubmissions ? (
            <div className="text-sm text-[#6E6978] py-4">Loading submission history...</div>
          ) : submissions.length === 0 ? (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
              You have not submitted any pothole photographs yet.
            </div>
          ) : (
            <div className="divide-y divide-[#E8DFC5]">
              {submissions.map((sub) => (
                <div key={sub.submissionId} className="py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={sub.photoUrl}
                      alt={sub.streetName}
                      referrerPolicy="no-referrer"
                      className="w-12 h-12 rounded-xl object-cover border border-[#E8DFC5] shrink-0 bg-[#F7F7F8]"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#2D2B35] truncate">
                        {sub.streetName}
                      </div>
                      <div className="text-xs text-[#6E6978] truncate">
                        {COORDINATE_SOURCE_LABELS[sub.coordinateSource]} ·{' '}
                        {sub.duplicateStatus === 'distinct'
                          ? 'Distinct Spot'
                          : sub.duplicateStatus === 'evidence_added'
                            ? 'Evidence Added'
                            : 'Pending Duplicate Review'}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs font-mono text-[#6E6978] shrink-0">
                    {sub.aiSeverityLabel}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Phase 3 Infrastructure Readout */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">
            Platform Service Verification
          </h2>
          <ShieldCheck className="w-5 h-5 text-[#4CB729]" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3.5 space-y-1">
            <div className="flex items-center gap-2 font-semibold text-[#2D2B35]">
              <Database className="w-4 h-4 text-[#4CB729]" />
              <span>Firestore Boot Probe</span>
            </div>
            <div className="text-[#4B4646]">
              {firestoreStatus ? firestoreStatus.message : 'Checking connection...'}
            </div>
          </div>

          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3.5 space-y-1">
            <div className="flex items-center gap-2 font-semibold text-[#2D2B35]">
              <HardDrive className="w-4 h-4 text-[#4CB729]" />
              <span>Express Media, Maps & Admin SDK</span>
            </div>
            <div className="font-mono text-[#4B4646] truncate">
              {serverHealth
                ? `${serverHealth.firebaseProjectId ?? 'No project'} · Admin DB: ${
                    serverHealth.adminFirestoreReady ? 'Ready' : 'Pending'
                  } · Maps: ${serverHealth.mapsConfigured ? 'Ready' : 'Unset'}`
                : 'Checking /api/health...'}
            </div>
          </div>
        </div>

        {user && (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#E8DFC5]">
            <div className="text-xs font-mono text-[#4B4646]">
              ID Token Verification: {tokenSessionStatus}
            </div>
            <button
              type="button"
              onClick={() => void verifyBackendToken()}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35]"
            >
              Verify Backend Session
            </button>
          </div>
        )}
      </section>

      {/* Privacy Policy & Account Deletion Controls */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">
            Location Privacy & Data Controls
          </h2>
          <ShieldCheck className="w-5 h-5 text-[#6E6978]" />
        </div>

        <p className="text-xs text-[#4B4646] leading-relaxed">
          PatchUp requests GPS location only on demand when you initiate Capture or tap Locate Me—no
          background location tracking ever runs. Email addresses remain strictly inside your private
          owner-only subcollection and are never published to leaderboards, feeds, or public profiles.
        </p>

        {user && (
          <div className="pt-2 border-t border-[#E8DFC5] space-y-3">
            {!showDeleteConfirm ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-[#6E6978]">
                  Delete your personal profile, private account, friendships, and game records.
                  Accepted street potholes stay anonymized so corridor reports remain accurate.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setShowDeleteConfirm(true);
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-[#DC2626]/40 bg-[#DC2626]/5 hover:bg-[#DC2626]/10 text-xs font-semibold text-[#DC2626] inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Delete Account & Personal Data</span>
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => void handleDeleteAccount(e)}
                className="rounded-xl bg-[#DC2626]/5 border border-[#DC2626]/30 p-4 space-y-3"
              >
                <div className="text-xs font-semibold text-[#DC2626]">
                  Confirm Permanent Account Deletion
                </div>
                <p className="text-xs text-[#4B4646]">
                  Type <span className="font-mono font-bold text-[#2D2B35]">DELETE</span> below to
                  permanently delete your PatchUp account, private email record, notifications, and
                  minigame stats.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={deleteConfirmInput}
                    onChange={(e) => setDeleteConfirmInput(e.target.value)}
                    placeholder="Type DELETE"
                    className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#DC2626]/40 bg-white text-sm font-mono text-[#2D2B35] focus:outline-2 focus:outline-[#DC2626]"
                  />
                  <button
                    type="submit"
                    disabled={deletingAccount || deleteConfirmInput.trim() !== 'DELETE'}
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#DC2626] hover:bg-[#B91C1C] text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {deletingAccount ? 'Deleting...' : 'Confirm Deletion'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteConfirmInput('');
                      setDeleteError(null);
                    }}
                    className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-white text-xs font-semibold text-[#2D2B35]"
                  >
                    Cancel
                  </button>
                </div>
                {deleteError && <p className="text-xs text-[#DC2626]">{deleteError}</p>}
              </form>
            )}
          </div>
        )}
      </section>
    </div>
  );
};

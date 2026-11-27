import React, { useEffect, useRef, useState } from 'react';
import { Camera, Check, LogOut, MapPin, Pencil, RefreshCw, Search, ShieldCheck, UserPlus, Users, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { FriendSearchUser, useFriends } from '../hooks/useSocial';
import { compressImageForUpload, uploadImageWithRetry } from '../lib/imageUpload';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { readApiJson } from '../lib/apiResponse';

interface ProfileViewProps {
  onOpenGames: () => void;
}

function Avatar({ src, name, large = false }: { src?: string; name: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border-4 border-[#fffaf0] bg-[#ffcf35] text-[#17231d] ${large ? 'h-28 w-28 sm:h-32 sm:w-32' : 'h-14 w-14'}`}>
      {src && !failed ? <img src={src} alt={name} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-cover" /> :
        <svg viewBox="0 0 48 48" className="h-full w-full" role="img" aria-label={`${name}'s default avatar`}>
          <circle cx="24" cy="18" r="9" fill="#17231d" />
          <path d="M7 48v-6a17 17 0 0 1 34 0v6" fill="#17231d" />
        </svg>}
    </span>
  );
}

const button = 'min-h-11 rounded-full px-5 py-2 text-sm font-semibold transition focus-visible:ring-2 focus-visible:ring-[#17231d] disabled:cursor-not-allowed';
const field = 'min-h-11 w-full rounded-xl border border-[#c8c5b9] bg-[#fffdf7] px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-[#17231d]';
const panel = 'rounded-2xl border border-[#d7d2c4] bg-[#fffaf0] p-5 sm:p-7';

export const ProfileView: React.FC<ProfileViewProps> = () => {
  const { user, publicProfile, privateAccount, authError, isSigningIn, signIn, signOut, updateProfile, updateNotificationsPref } = useAuth();
  const { acceptedFriends, incomingRequests, outgoingRequests, sendFriendRequest, respondToFriend, searchUsers, error: friendsError } = useFriends(user);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ displayName: '', username: '', homeNeighborhood: '', bio: '', showOnLeaderboard: false, shareNeighborhood: false });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatarConsent,setAvatarConsent]=useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const avatarInput = useRef<HTMLInputElement>(null);
  const displayInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FriendSearchUser[]>([]);
  const [recommendations, setRecommendations] = useState<FriendSearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingRecommendations, setLoadingRecommendations] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [tab, setTab] = useState('Discover');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');

  useEffect(() => {
    if (!publicProfile) return;
    setForm({
      displayName: publicProfile.displayName, username: publicProfile.username,
      homeNeighborhood: publicProfile.homeNeighborhood || '', bio: publicProfile.bio || '',
      showOnLeaderboard: publicProfile.showOnLeaderboard, shareNeighborhood: publicProfile.shareNeighborhood,
    });
  }, [publicProfile]);
  useEffect(() => { if (editing) displayInput.current?.focus(); }, [editing]);

  useEffect(() => {
    if (!user) { setRecommendations([]); return; }
    let active = true;
    setLoadingRecommendations(true);
    setDiscoveryError('');
    searchUsers('', true).then((items) => { if (active) setRecommendations(items.slice(0, 6)); })
      .catch((err) => { if (active) setDiscoveryError(err.message); })
      .finally(() => { if (active) setLoadingRecommendations(false); });
    return () => { active = false; };
  }, [user, searchUsers, refresh]);

  useEffect(() => {
    let active = true;
    setResults([]);
    if (!query.trim() || !user) { setSearching(false); return; }
    setSearching(true);
    setDiscoveryError('');
    const timer = window.setTimeout(() => {
      searchUsers(query).then((items) => { if (active) setResults(items); })
        .catch((err) => { if (active) setDiscoveryError(err.message); })
        .finally(() => { if (active) setSearching(false); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, user, searchUsers, refresh]);

  const perform = async (key: string, action: () => Promise<unknown>, success: string) => {
    setPending(key); setError(''); setMessage('');
    try { await action(); setMessage(success); setRefresh((value) => value + 1); }
    catch (err) { setError(err instanceof Error ? err.message : 'Please try again.'); }
    finally { setPending(null); }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setMessage('');
    try { await updateProfile(form); setEditing(false); setMessage('Your profile is updated.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to save profile.'); }
    finally { setSaving(false); }
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user || !avatarConsent) return;
    setUploading(true); setError('');
    try {
      const compressed = await compressImageForUpload(file);
      const media = await uploadImageWithRetry({ uid: user.uid, fileId: `avt_${user.uid.slice(0, 8)}_${Date.now()}`, compressed,privacyConfirmed:avatarConsent });
      await updateProfile({ photoURL: media.downloadUrl });
      setMessage('Profile photo updated.');
    } catch (err) { setError(err instanceof Error ? err.message : 'Photo upload failed.'); }
    finally { setUploading(false); event.target.value = ''; }
  };

  const name = publicProfile?.displayName || 'Your Patcher profile';
  const isSearching = query.trim().length > 0;
  const people = isSearching ? results : recommendations;
  const relatedIds = new Set([...acceptedFriends, ...incomingRequests, ...outgoingRequests].map((friend) => friend.otherUid));

  function PersonCard({ person }: { person: FriendSearchUser }) {
    const related = relatedIds.has(person.uid) || ['pending', 'accepted'].includes(person.friendshipStatus);
    return (
      <article className="min-w-0 rounded-xl border border-[#ded9ca] bg-[#f7f3e9] p-4">
        <div className="flex items-center gap-3">
          <Avatar src={person.photoURL} name={person.displayName} />
          <div className="min-w-0">
            <h3 className="truncate font-sans text-sm font-bold">{person.displayName}</h3>
            <p className="truncate text-sm text-slate-600">@{person.username}</p>
          </div>
        </div>
        <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-slate-600">{person.bio || 'This Patcher hasn’t added a bio yet.'}</p>
        <button disabled={related || pending !== null} onClick={() => void perform(person.uid, () => sendFriendRequest(person.uid), 'Friend request sent.')} className={`${button} mt-4 flex w-full items-center justify-center gap-2 ${related ? 'border border-[#c8c5b9]' : 'bg-[#17231d] text-white hover:bg-[#314b3e]'}`}>
          {related ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : <UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />}
          {pending === person.uid ? 'Sending…' : person.friendshipStatus === 'accepted' ? 'Friends' : related ? 'Request pending' : 'Add friend'}
        </button>
      </article>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5 overflow-x-hidden pb-8 text-[#17231d]">
      <header className="overflow-hidden rounded-2xl border border-[#d7d2c4] bg-[#fffaf0]">
        <div className="flex h-28 items-start justify-between bg-[#b9d8c4] px-6 py-5 sm:h-36 sm:px-8">
          <span className="text-xs font-bold tracking-[.18em]">YOUR CORNER OF ATLANTA</span>
          <span className="rounded-full border border-[#17231d] px-3 py-1 text-xs font-bold">PATCHER PROFILE</span>
        </div>
        <div className="px-5 pb-6 sm:px-8">
          <div className="-mt-12 flex flex-wrap items-end justify-between gap-4">
            <div className="relative">
              <Avatar src={publicProfile?.photoURL} name={name} large />
              {user && <button disabled={uploading||!avatarConsent} onClick={() => avatarInput.current?.click()} aria-label="Upload profile picture" className="absolute -bottom-1 -right-1 flex h-11 w-11 items-center justify-center rounded-full border-4 border-[#fffaf0] bg-[#17231d] text-white focus-visible:ring-2">
                <Camera className="h-5 w-5 shrink-0" aria-hidden="true" />
              </button>}
              <input ref={avatarInput} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose profile photo" className="hidden" onChange={(event) => void upload(event)} />
            </div>
            {user ? <div className="flex flex-wrap gap-2">
              <button onClick={() => setEditing((value) => !value)} aria-expanded={editing} className={`${button} flex items-center gap-2 border border-[#17231d] hover:bg-[#ede8da]`}><Pencil className="h-4 w-4 shrink-0" aria-hidden="true" />Edit profile</button>
              <button onClick={() => { setTab('Discover'); searchInput.current?.focus(); searchInput.current?.scrollIntoView({ block: 'center' }); }} className={`${button} flex items-center gap-2 bg-[#17231d] text-white hover:bg-[#314b3e]`}><UserPlus className="h-4 w-4 shrink-0" aria-hidden="true" />Find friends</button>
            </div> : <GoogleSignInButton onClick={() => void signIn()} disabled={isSigningIn} />}
          </div>
          <h1 className="mt-5 text-2xl sm:text-3xl">{name}</h1>
          <p className="mt-1 text-sm text-slate-600">{user ? `@${publicProfile?.username || 'patcher'}` : 'Sign in to make this space yours and meet other Patchers.'}</p>
          {publicProfile?.bio && <p className="mt-3 max-w-2xl whitespace-pre-line text-sm leading-6">{publicProfile.bio}</p>}
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {publicProfile?.shareNeighborhood && publicProfile.homeNeighborhood && <span className="flex items-center gap-1.5 text-slate-600"><MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />{publicProfile.homeNeighborhood}, Atlanta</span>}
            <span><strong>{acceptedFriends.length}</strong> friends</span>
            <span><strong>{incomingRequests.length}</strong> incoming requests</span>
          </div>
          {user&&<label className="mt-3 flex gap-2 text-sm"><input type="checkbox" checked={avatarConsent} onChange={e=>setAvatarConsent(e.target.checked)}/> I have permission to share my public profile photo.</label>}
          {uploading && <p role="status" className="mt-3 text-sm">Uploading your photo…</p>}
        </div>
      </header>

      <div aria-live="polite">
        {(error || authError) && <p role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error || authError}</p>}
        {message && <p role="status" className="rounded-xl border border-green-300 bg-green-50 p-4 text-sm text-green-900">{message}</p>}
      </div>

      {user && editing && <form onSubmit={(event) => void save(event)} className={`${panel} space-y-5`}>
        <div><h2 className="text-xl">Edit profile</h2><p className="mt-1 text-sm text-slate-600">Let Atlanta get to know the Patcher behind the pin.</p></div>
        <button type="button" disabled={uploading||!avatarConsent} onClick={() => avatarInput.current?.click()} className={`${button} border border-[#17231d]`}>{uploading ? 'Uploading…' : 'Upload profile picture'}</button>
        <p className="text-sm text-slate-600">JPEG, PNG, or WebP · up to 10 MB</p>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm font-semibold"><span>Display name</span><input ref={displayInput} required maxLength={64} className={field} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
          <label className="space-y-2 text-sm font-semibold"><span>Username</span><input required pattern="[a-z0-9_]{3,32}" maxLength={32} className={field} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })} /><span className="block text-sm font-normal text-slate-600">3–32 lowercase letters, numbers, or underscores.</span></label>
          <label className="space-y-2 text-sm font-semibold md:col-span-2"><span>Bio</span><textarea rows={3} maxLength={160} placeholder="A little about you and your corner of the city…" className={field} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /><span className="block text-right text-xs text-slate-600">{form.bio.length}/160</span></label>
          <label className="space-y-2 text-sm font-semibold md:col-span-2"><span>Atlanta neighborhood <span className="font-normal text-slate-600">(optional)</span></span><input maxLength={64} placeholder="e.g., Midtown" className={field} value={form.homeNeighborhood} onChange={(e) => setForm({ ...form, homeNeighborhood: e.target.value })} /></label>
        </div>
        {[['showOnLeaderboard', 'Show me on the leaderboard'], ['shareNeighborhood', 'Show my neighborhood publicly']].map(([key, label]) => <label key={key} className="flex min-h-11 cursor-pointer items-center justify-between gap-4 text-sm">
          {label}<input type="checkbox" className="h-5 w-5 accent-[#17231d]" checked={form[key as 'shareNeighborhood' | 'showOnLeaderboard']} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
        </label>)}
        <button disabled={saving || uploading} className={`${button} bg-[#17231d] text-white`}>{saving ? 'Saving…' : 'Save changes'}</button>
      </form>}

      {user && <section className={`${panel} space-y-5`} aria-labelledby="connections-title">
        <div className="flex items-start justify-between gap-3"><div><h2 id="connections-title" className="text-xl">Friends & connections</h2><p className="mt-2 text-sm text-slate-600">Good neighbors. Better streets. Find your people.</p></div><Users className="h-6 w-6 shrink-0" aria-hidden="true" /></div>
        <div className="flex flex-wrap gap-1 border-b border-[#ded9ca]" role="tablist" aria-label="Connections">
          {['Discover', 'Friends', 'Requests'].map((item) => <button key={item} role="tab" aria-selected={tab === item} aria-controls="connections-panel" id={`tab-${item}`} onClick={() => setTab(item)} className={`${button} rounded-none border-b-2 ${tab === item ? 'border-[#17231d]' : 'border-transparent text-slate-600'}`}>{item}{item === 'Friends' ? ` (${acceptedFriends.length})` : item === 'Requests' ? ` (${incomingRequests.length})` : ''}</button>)}
        </div>
        {friendsError && <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{friendsError}</p>}
        <div id="connections-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'Discover' ? <div className="space-y-5">
            <div className="relative"><Search className="pointer-events-none absolute left-4 top-3.5 h-5 w-5 shrink-0 text-slate-600" aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search Patchers by display name or username" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find Patchers by name or @username" className={`${field} min-h-12 pl-12`} /></div>
            <div className="flex items-center justify-between gap-3"><h3 className="font-sans text-base font-bold">{isSearching ? 'Search results' : 'Recommended for you'}</h3>{!isSearching && <button aria-label="Refresh recommended Patchers" disabled={loadingRecommendations} onClick={() => setRefresh((value) => value + 1)} className={`${button} flex items-center gap-2 border border-[#c8c5b9]`}><RefreshCw className="h-4 w-4 shrink-0" aria-hidden="true" />Refresh</button>}</div>
            <div aria-live="polite">
              {discoveryError ? <p role="alert" className="text-sm text-red-800">{discoveryError}</p> : (isSearching ? searching : loadingRecommendations) ? <p className="py-6 text-sm text-slate-600">Finding Patchers…</p> : people.length ? <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{people.map((person) => <PersonCard key={person.uid} person={person} />)}</div> : <div className="rounded-xl bg-[#f0ecdf] p-6 text-sm text-slate-600">{isSearching ? 'No Patchers found. Try a shorter name or a different spelling.' : 'No new Patchers to recommend yet. Try searching for someone you know or check back soon.'}</div>}
            </div>
          </div> : <div className="divide-y divide-[#ded9ca]">
            {(tab === 'Friends' ? acceptedFriends : incomingRequests).map((friend) => <div key={friend.friendshipId} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="flex min-w-0 items-center gap-3"><Avatar src={friend.photoURL} name={friend.displayName} /><div className="min-w-0"><p className="truncate text-sm font-bold">{friend.displayName}</p><p className="truncate text-sm text-slate-600">@{friend.username}</p></div></div>
              <div className="flex gap-2">{tab === 'Requests' && <button disabled={pending !== null} onClick={() => void perform(friend.friendshipId, () => respondToFriend(friend.friendshipId, 'accept'), 'You’re now friends!')} className={`${button} bg-[#17231d] text-white`}>Accept</button>}<button disabled={pending !== null} onClick={() => void perform(friend.friendshipId, () => respondToFriend(friend.friendshipId, tab === 'Friends' ? 'remove' : 'decline'), 'Connection updated.')} className={`${button} border border-[#c8c5b9]`}>{tab === 'Friends' ? 'Remove' : 'Decline'}</button></div>
            </div>)}
            {(tab === 'Friends' ? acceptedFriends : incomingRequests).length === 0 && <p className="py-6 text-sm text-slate-600">{tab === 'Friends' ? 'Your community starts with a hello. Discover Patchers to send your first request.' : 'You’re all caught up. New friend requests will appear here.'}</p>}
            {tab === 'Requests' && outgoingRequests.length > 0 && <p className="py-4 text-sm text-slate-600">Sent requests: {outgoingRequests.map((friend) => `@${friend.username}`).join(', ')}</p>}
          </div>}
        </div>
      </section>}

      {user && <details className={panel}>
        <summary className="min-h-11 cursor-pointer py-2 text-base font-semibold">Account & privacy</summary>
        <div className="mt-4 space-y-5 text-sm">
          <p className="flex items-start gap-2 text-slate-600"><ShieldCheck className="h-5 w-5 shrink-0" aria-hidden="true" />Your email stays private. Location is requested only when you choose to capture a pothole or center the map.</p>
          {privateAccount && <label className="flex min-h-11 items-center justify-between gap-4">In-app notifications<input type="checkbox" className="h-5 w-5 accent-[#17231d]" checked={privateAccount.notificationsEnabled} onChange={(e) => void perform('notifications', () => updateNotificationsPref(e.target.checked), 'Notification preference updated.')} disabled={pending !== null} /></label>}
          <button onClick={() => void perform('signout', signOut, 'Signed out.')} className={`${button} inline-flex items-center gap-2 border border-[#c8c5b9]`}><LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />Sign out</button>
          <div className="border-t border-[#ded9ca] pt-5">
            {!deleteOpen ? <button onClick={() => setDeleteOpen(true)} className={`${button} text-red-800`}>Delete account & personal data</button> : <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              void perform('delete', async () => {
                const token = await user.getIdToken();
                const response = await fetch('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ confirmText: deleteText }) });
                await readApiJson<{ ok: boolean }>(response);
                await signOut();
              }, 'Account deleted.');
            }}>
              <p className="text-red-800">This permanently deletes your profile, friendships, and personal records. Accepted street potholes remain anonymized.</p>
              <label className="block space-y-2"><span>Type DELETE to confirm</span><input value={deleteText} onChange={(e) => setDeleteText(e.target.value)} className={field} /></label>
              <div className="flex flex-wrap gap-2"><button disabled={deleteText !== 'DELETE' || pending !== null} className={`${button} bg-red-800 text-white`}>{pending === 'delete' ? 'Deleting…' : 'Permanently delete account'}</button><button type="button" onClick={() => { setDeleteOpen(false); setDeleteText(''); }} className={button}>Cancel</button></div>
            </form>}
          </div>
        </div>
      </details>}
    </div>
  );
};

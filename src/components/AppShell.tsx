import React from 'react';
import { Award, Camera, Gamepad2, Home, ShieldCheck, User as UserIcon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { GoogleSignInButton } from './GoogleSignInButton';
import { OfflineBanner } from './OfflineBanner';

export type NavTab = 'home' | 'map' | 'capture' | 'leaderboard' | 'arcade' | 'profile' | 'admin';

interface AppShellProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  children: React.ReactNode;
}

const DESKTOP_NAV_ITEMS: { id: NavTab; label: string; mobileLabel: string; icon: React.FC<{ className?: string }> }[] = [
  { id: 'home', label: 'Home', mobileLabel: 'Home', icon: Home },
  { id: 'leaderboard', label: 'Leaderboard', mobileLabel: 'Ranks', icon: Award },
  { id: 'arcade', label: 'Arcade', mobileLabel: 'Arcade', icon: Gamepad2 },
  { id: 'profile', label: 'Profile', mobileLabel: 'Profile', icon: UserIcon },
];

const MOBILE_NAV_ITEMS: typeof DESKTOP_NAV_ITEMS = [
  { id: 'home', label: 'Home', mobileLabel: 'Home', icon: Home },
  { id: 'leaderboard', label: 'Leaderboard', mobileLabel: 'Ranks', icon: Award },
  { id: 'capture', label: 'Capture', mobileLabel: 'Snap', icon: Camera },
  { id: 'arcade', label: 'Arcade', mobileLabel: 'Arcade', icon: Gamepad2 },
  { id: 'profile', label: 'Profile', mobileLabel: 'Profile', icon: UserIcon },
];

export const AppShell: React.FC<AppShellProps> = ({ activeTab, onSelectTab, children }) => {
  const { user, publicProfile, isSigningIn, signIn, isAdmin } = useAuth();

  return (
    <div className="patchup-shell min-h-dvh flex flex-col bg-[#F7F7F8] text-[#3A3535]">
      <OfflineBanner />

      <header className="hidden lg:block sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-[#E8DFC5]">
        <div className="shell-topline">
          <span>ATLANTA'S COMMUNITY ROAD WATCH</span>
        </div>
        <div className="shell-header-inner max-w-[1440px] mx-auto px-5 xl:px-8 h-[76px] flex items-center justify-between gap-4 xl:gap-8">
          <button
            type="button"
            onClick={() => onSelectTab('home')}
            className="patchup-wordmark flex items-center whitespace-nowrap shrink-0 min-h-[44px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#ff5833]"
          >
            <img
              src="/patchup-logo.png"
              alt="PatchUp"
              className="patchup-logo patchup-logo-desktop"
            />
          </button>

          <nav className="flex items-center gap-3 xl:gap-6" aria-label="Primary">
            {(isAdmin ? [...DESKTOP_NAV_ITEMS, {id: 'admin' as NavTab,label: 'Admin Hub',mobileLabel: 'Admin Hub',icon:ShieldCheck}] : DESKTOP_NAV_ITEMS).map((item) => {
              const isActive = activeTab === item.id;
              const isCapture = item.id === 'capture';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectTab(item.id)}
                  className={`shell-nav-link min-h-[44px] px-2 text-xs font-bold uppercase tracking-[0.12em] whitespace-nowrap shrink-0 transition ${
                    isActive
                      ? 'is-active text-[#2D2B35]'
                      : isCapture
                        ? 'text-[#e7421e] hover:text-[#b92c10]'
                        : 'text-[#536159] hover:text-[#17231d]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="shrink-0">
            {user ? (
              <button
                type="button"
                onClick={() => onSelectTab('profile')}
                className="account-chip inline-flex items-center gap-2.5 min-h-[44px] px-3 py-1.5 bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 border border-[#E8DFC5] text-sm font-semibold text-[#2D2B35] whitespace-nowrap shrink-0 transition"
              >
                {publicProfile?.photoURL ? (
                  <img
                    src={publicProfile.photoURL}
                    alt={publicProfile.displayName}
                    referrerPolicy="no-referrer"
                    className="w-7 h-7 rounded-full object-cover border border-[#E8DFC5]"
                  />
                ) : (
                  <span className="w-7 h-7 rounded-full bg-[#4CB729] text-white text-xs font-bold flex items-center justify-center">
                    {(publicProfile?.displayName || user.email || 'P').slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="max-w-[140px] truncate">
                  {publicProfile?.displayName || 'Account'}
                </span>
              </button>
            ) : (
              <GoogleSignInButton onClick={() => void signIn()} disabled={isSigningIn} />
            )}
          </div>
        </div>
      </header>

      <header className="lg:hidden sticky top-0 z-30 pt-safe bg-white/95 backdrop-blur-md border-b border-[#E8DFC5]">
        <div className="px-3 min-[380px]:px-4 h-12 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onSelectTab('home')}
            className="patchup-wordmark flex items-center min-h-[44px] whitespace-nowrap shrink-0"
          >
            <img
              src="/patchup-logo.png"
              alt="PatchUp"
              className="patchup-logo patchup-logo-mobile"
            />
          </button>

          {user ? (
            <button
              type="button"
              onClick={() => onSelectTab('profile')}
              className="inline-flex items-center gap-2 min-h-[44px] px-2 text-xs font-semibold text-[#3A3535] whitespace-nowrap shrink-0"
            >
              {publicProfile?.photoURL ? (
                <img
                  src={publicProfile.photoURL}
                  alt={publicProfile.displayName}
                  referrerPolicy="no-referrer"
                  className="w-7 h-7 rounded-full object-cover border border-[#E8DFC5]"
                />
              ) : (
                <span className="w-7 h-7 rounded-full bg-[#4CB729] text-white text-xs font-bold flex items-center justify-center">
                  {(publicProfile?.displayName || user.email || 'P').slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="hidden min-[360px]:inline max-w-[110px] truncate">
                @{publicProfile?.username || 'profile'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={isSigningIn}
              className="min-h-[44px] px-3 text-xs font-bold text-[#4CB729] hover:text-[#3FA31F] whitespace-nowrap shrink-0"
            >
              {isSigningIn ? 'Signing in...' : 'Sign in'}
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 min-w-0 w-full max-w-[1440px] mx-auto px-3 min-[380px]:px-4 sm:px-6 lg:px-8 py-4 sm:py-8 pb-[calc(5.75rem+env(safe-area-inset-bottom))] lg:pb-12">
        {children}
      </main>

      <nav
        aria-label="Mobile navigation"
        className="mobile-dock lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-[#E8DFC5] pb-safe px-safe"
      >
        <div className={`grid ${isAdmin ? 'grid-cols-6' : 'grid-cols-5'} items-center h-16 px-1`}>
          {(isAdmin ? [...MOBILE_NAV_ITEMS, {id: 'admin' as NavTab,label: 'Admin Hub',mobileLabel: 'Admin Hub',icon:ShieldCheck}] : MOBILE_NAV_ITEMS).map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const isCapture = item.id === 'capture';

            if (isCapture) {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectTab('capture')}
                  aria-label="Capture pothole"
                  aria-current={isActive ? 'page' : undefined}
                  className="flex flex-col items-center justify-center min-h-[44px] min-w-[44px] -mt-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3A3535]"
                >
                  <span
                    className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-md transition-transform active:scale-95 ${
                      isActive
                        ? 'bg-[#2D2B35] text-white ring-2 ring-[#4CB729]'
                        : 'bg-[#4CB729] text-white'
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </span>
                  <span
                    className={`text-[10px] font-semibold tracking-tight mt-0.5 whitespace-nowrap ${
                      isActive ? 'text-[#2D2B35]' : 'text-[#4CB729]'
                    }`}
                  >
                    {item.mobileLabel}
                  </span>
                </button>
              );
            }

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex flex-col items-center justify-center min-h-[44px] min-w-[44px] rounded-xl transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4CB729] ${
                  isActive ? 'text-[#4CB729]' : 'text-[#6E6978] hover:text-[#3A3535]'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-[10px] font-semibold tracking-tight mt-1 whitespace-nowrap">
                  {item.mobileLabel}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
};

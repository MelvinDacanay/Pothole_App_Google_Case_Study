import React, { Component, useEffect, useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import { AppShell, NavTab } from './components/AppShell';
import { PotholeRecord } from './lib/maps';
import { HomeView } from './views/HomeView';
import { MapView } from './views/MapView';
import { CaptureView } from './views/CaptureView';
import { LeaderboardView } from './views/LeaderboardView';
import { ProfileView } from './views/ProfileView';
import { CivicReportsView } from './views/CivicReportsView';
import { MinigamesView } from './views/MinigamesView';
import { firebaseClientConfigured } from './lib/firebase';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class AppErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message || 'An unexpected error occurred.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-dvh flex items-center justify-center bg-[#F7F7F8] p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-[#E8DFC5] p-6 space-y-4">
            <h1 className="font-display text-xl font-bold text-[#2D2B35]">
              PatchUp encountered an error
            </h1>
            <p className="text-xs font-mono text-[#DC2626] break-all bg-[#F7F7F8] p-3 rounded-xl border border-[#E8DFC5]">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full min-h-[44px] rounded-xl bg-[#4CB729] text-white text-sm font-semibold hover:bg-[#3FA31F]"
            >
              Reload PatchUp
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('home');
  const [subView, setSubView] = useState<'none' | 'civic' | 'games'>('none');
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);
  const [selectedPothole, setSelectedPothole] = useState<PotholeRecord | null>(null);
  const [pendingFocusPotholeId, setPendingFocusPotholeId] = useState<string | null>(null);
  const [preselectedEvidenceTarget, setPreselectedEvidenceTarget] =
    useState<PotholeRecord | null>(null);

  useEffect(() => {
    const onQuotaExceeded = () => setMapsQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
  }, []);

  const handleSelectTab = (tab: NavTab) => {
    setSubView('none');
    setActiveTab(tab);
  };

  const handleInspectPothole = (pothole: PotholeRecord) => {
    setSubView('none');
    setSelectedPothole(pothole);
    setActiveTab('map');
  };

  const handleAddEvidence = (pothole: PotholeRecord) => {
    setSubView('none');
    setPreselectedEvidenceTarget(pothole);
    setActiveTab('capture');
  };

  const handleSubmittedToMap = (potholeId: string) => {
    setSubView('none');
    setPreselectedEvidenceTarget(null);
    setPendingFocusPotholeId(potholeId);
    setActiveTab('map');
  };

  return (
    <AppErrorBoundary>
      <AuthProvider>
        {!firebaseClientConfigured && (
          <div className="bg-sky-50 border-b border-sky-200 text-sky-950 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50">
            Local preview mode: add Firebase web <code className="font-mono">apiKey</code> and{' '}
            <code className="font-mono">appId</code> to{' '}
            <code className="font-mono">firebase-applet-config.json</code> (or{' '}
            <code className="font-mono">VITE_FIREBASE_*</code> in <code className="font-mono">.env</code>)
            to enable sign-in and live data.
          </div>
        )}
        {mapsQuotaExceeded && (
          <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
            <span>
              Google Maps Platform quota reached. If you are the app owner, visit{' '}
              <a
                href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold text-amber-950 hover:text-amber-800"
              >
                maps developer site
              </a>{' '}
              for instructions to update your account.
            </span>
          </div>
        )}

        <AppShell activeTab={activeTab} onSelectTab={handleSelectTab}>
          {subView === 'civic' ? (
            <CivicReportsView
              onBack={() => setSubView('none')}
              onInspectPothole={handleInspectPothole}
            />
          ) : subView === 'games' ? (
            <MinigamesView onBack={() => setSubView('none')} />
          ) : (
            <>
              {activeTab === 'home' && (
                <HomeView
                  onNavigate={handleSelectTab}
                  onInspectPothole={handleInspectPothole}
                  onOpenCivic={() => setSubView('civic')}
                  onOpenGames={() => setSubView('games')}
                />
              )}
              {activeTab === 'map' && (
                <MapView
                  selectedPothole={selectedPothole}
                  pendingFocusPotholeId={pendingFocusPotholeId}
                  onClearPendingFocus={() => setPendingFocusPotholeId(null)}
                  onSelectPothole={setSelectedPothole}
                  onAddEvidence={handleAddEvidence}
                  onStartCapture={() => {
                    setPreselectedEvidenceTarget(null);
                    handleSelectTab('capture');
                  }}
                  onOpenCivic={() => setSubView('civic')}
                />
              )}
              {activeTab === 'capture' && (
                <CaptureView
                  preselectedPothole={preselectedEvidenceTarget}
                  onClearPreselected={() => setPreselectedEvidenceTarget(null)}
                  onSubmittedToMap={handleSubmittedToMap}
                />
              )}
              {activeTab === 'leaderboard' && <LeaderboardView />}
              {activeTab === 'profile' && (
                <ProfileView
                  onOpenCivic={() => setSubView('civic')}
                  onOpenGames={() => setSubView('games')}
                />
              )}
            </>
          )}
        </AppShell>
      </AuthProvider>
    </AppErrorBoundary>
  );
}

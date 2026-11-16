import React, { useState } from 'react';
import { Download, PlusSquare, Share, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3A3535]"
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>{compact ? 'Install' : 'Install App'}</span>
      </button>
    );
  }

  if (isIOS || !compact) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/40 text-[#3A3535] text-sm font-semibold transition whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4CB729]"
        >
          <Smartphone className="w-4 h-4 shrink-0 text-[#4CB729]" />
          <span>{isIOS ? 'Add to Home Screen' : 'Install Guide'}</span>
        </button>

        {showGuide && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[#2D2B35]/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pwa-install-title"
          >
            <div className="w-full max-w-md rounded-2xl bg-white border border-[#E8DFC5] p-6 shadow-xl">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <img
                    src="/pwa-192x192.png"
                    alt="PatchUp icon"
                    referrerPolicy="no-referrer"
                    className="w-12 h-12 rounded-xl border border-[#E8DFC5] object-contain bg-white"
                  />
                  <div>
                    <h3
                      id="pwa-install-title"
                      className="text-lg font-bold text-[#2D2B35] font-display"
                    >
                      Install PatchUp on Home Screen
                    </h3>
                    <p className="text-xs text-[#6E6978]">
                      Launch full-screen from iPhone Safari or Android Chrome
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  aria-label="Close install guide"
                  className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-[#6E6978] hover:bg-[#F7F7F8] hover:text-[#3A3535]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {isIOS ? (
                <ol className="mt-5 space-y-3 text-sm text-[#3A3535]">
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-lg bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono font-semibold flex items-center justify-center shrink-0">
                      1
                    </span>
                    <span>
                      Tap the <Share className="inline w-4 h-4 mx-0.5 text-[#4CB729]" />{' '}
                      <strong>Share</strong> button in the Safari toolbar.
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-lg bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono font-semibold flex items-center justify-center shrink-0">
                      2
                    </span>
                    <span>
                      Scroll down and tap{' '}
                      <PlusSquare className="inline w-4 h-4 mx-0.5 text-[#4CB729]" />{' '}
                      <strong>Add to Home Screen</strong>.
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-lg bg-[#F7F7F8] border border-[#E8DFC5] text-xs font-mono font-semibold flex items-center justify-center shrink-0">
                      3
                    </span>
                    <span>
                      Tap <strong>Add</strong> in the upper right to open PatchUp as a standalone app.
                    </span>
                  </li>
                </ol>
              ) : (
                <p className="mt-4 text-sm text-[#4B4646] leading-relaxed">
                  Open your browser menu and select <strong>Install app</strong> or{' '}
                  <strong>Add to Home Screen</strong> when supported by your browser. Note that
                  camera, GPS, and push capabilities depend on browser permissions and platform
                  support.
                </p>
              )}

              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="mt-6 w-full min-h-[44px] rounded-xl bg-[#3A3535] text-white text-sm font-semibold hover:bg-[#2D2B35] transition"
              >
                Got It
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

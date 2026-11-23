import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Crosshair,
  Loader2,
  MapPin,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CameraCaptureModal } from './CameraCaptureModal';
import { GoogleSignInButton } from './GoogleSignInButton';
import { PinPickerMap } from './PinPickerMap';
import { extractExifGpsFromFile } from '../lib/exif';
import { validateRawImageFile } from '../lib/imageUpload';
import {
  COORDINATE_SOURCE_LABELS,
  CoordinateSource,
  loadMapsClientConfig,
  MapsClientConfig,
} from '../lib/maps';
import { setPendingCapture } from '../lib/pendingCapture';

interface LandingCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Pre-auth reporting entry. Runs every step that is honestly possible before
 * sign-in — take/choose a photo, validate it, read genuine EXIF GPS, request a
 * one-time device fix, or drop a manual pin — then gates at sign-in. Address
 * lookup, duplicate checks, photo verification, and publishing all require an
 * authenticated account, so we say so plainly and hand the confirmed photo +
 * location to the real capture pipeline once the visitor signs in. Nothing is
 * fabricated and no location is assumed on the visitor's behalf.
 */
export const LandingCaptureModal: React.FC<LandingCaptureModalProps> = ({ isOpen, onClose }) => {
  const { signIn, isSigningIn, authError } = useAuth();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);

  const [mapsConfig, setMapsConfig] = useState<MapsClientConfig>({
    configured: false,
    apiKey: '',
    mapId: 'DEMO_MAP_ID',
  });

  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordinateSource, setCoordinateSource] = useState<CoordinateSource>('manual_pin');
  const [locationUserCorrected, setLocationUserCorrected] = useState(false);
  const [exifFound, setExifFound] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsStatusMsg, setGpsStatusMsg] = useState<string | null>(null);
  const [showPin, setShowPin] = useState(false);

  useEffect(() => {
    loadMapsClientConfig().then(setMapsConfig);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Lock body scroll while the overlay is open.
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  const resetDraft = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFile(null);
    setRawError(null);
    setCoords(null);
    setCoordinateSource('manual_pin');
    setLocationUserCorrected(false);
    setExifFound(false);
    setGpsLoading(false);
    setGpsStatusMsg(null);
    setShowPin(false);
  };

  const handleClose = () => {
    resetDraft();
    onClose();
  };

  const processFile = async (incoming: File) => {
    const validationError = validateRawImageFile(incoming);
    if (validationError) {
      setRawError(validationError);
      return;
    }
    setRawError(null);

    const exifGps = await extractExifGpsFromFile(incoming);

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const nextPreview = URL.createObjectURL(incoming);
    setPreviewUrl(nextPreview);
    setFile(incoming);

    if (exifGps) {
      setCoords(exifGps);
      setCoordinateSource('exif_extracted');
      setLocationUserCorrected(false);
      setExifFound(true);
      setGpsStatusMsg('Location read from your photo’s GPS metadata. Adjust it below if needed.');
    } else {
      setCoords(null);
      setExifFound(false);
      setGpsStatusMsg('No location in this photo. Use your current location or drop a pin.');
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const incoming = e.target.files?.[0];
    if (!incoming) return;
    try {
      await processFile(incoming);
    } finally {
      e.target.value = '';
    }
  };

  const handleUseCurrentGps = () => {
    if (!('geolocation' in navigator)) {
      setGpsStatusMsg('Location isn’t available in this browser. Drop a pin on the map instead.');
      setShowPin(true);
      return;
    }
    setGpsLoading(true);
    setGpsStatusMsg('Requesting a one-time location fix…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        });
        setCoordinateSource('gps_verified');
        setLocationUserCorrected(false);
        setExifFound(false);
        setGpsLoading(false);
        setGpsStatusMsg(
          `Location set (~${Math.round(position.coords.accuracy || 0)}m accuracy). Drag the pin to refine.`
        );
        setShowPin(true);
      },
      (geoErr) => {
        setGpsLoading(false);
        setShowPin(true);
        setGpsStatusMsg(
          geoErr.code === geoErr.PERMISSION_DENIED
            ? 'Location permission declined. Drop a pin on the map instead.'
            : 'Couldn’t get a location fix. Drop a pin on the map instead.'
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
  };

  const handlePinChange = (next: { lat: number; lng: number }) => {
    setCoords(next);
    setCoordinateSource('manual_pin');
    setLocationUserCorrected(true);
    setExifFound(false);
    setGpsStatusMsg('Pin placed. This is the location we’ll carry into your report.');
  };

  const handleContinue = () => {
    if (!file || !coords) return;
    // Stash the confirmed photo + location, then open Google sign-in. On success
    // the landing view unmounts and CaptureView ingests this draft on mount.
    setPendingCapture({ file, coords, coordinateSource, locationUserCorrected });
    void signIn();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-40 bg-[#1B1A22]/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Report a pothole"
    >
      <div className="w-full sm:max-w-2xl bg-[#F7F7F8] sm:rounded-2xl border border-[#E8DFC5] shadow-xl min-h-dvh sm:min-h-0 pt-safe pb-safe">
        <header className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-[#E8DFC5] sticky top-0 bg-[#F7F7F8]/95 backdrop-blur-sm sm:rounded-t-2xl z-10">
          <div>
            <div className="font-mono text-[11px] font-bold tracking-[0.12em] text-[#4CB729]">
              REPORT A POTHOLE
            </div>
            <h2 className="font-display text-xl font-bold text-[#2D2B35] leading-tight">
              Snap it. Place it.
            </h2>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/40 text-[#2D2B35]"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="px-5 sm:px-6 py-5 space-y-5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => void handleFileInput(e)}
            className="hidden"
          />
          <input
            ref={nativeCameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={(e) => void handleFileInput(e)}
            className="hidden"
          />

          {/* Step 1 — photo */}
          {!previewUrl ? (
            <div className="rounded-2xl border-2 border-dashed border-[#E8DFC5] bg-white p-6 flex flex-col items-center justify-center gap-4 text-center">
              <Camera className="w-9 h-9 text-[#4CB729]" />
              <div className="space-y-1">
                <div className="text-sm font-semibold text-[#2D2B35]">
                  Take a photo or choose one from your library
                </div>
                <div className="text-xs text-[#6E6978]">JPG, PNG, or WebP · up to 10 MB</div>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setCameraModalOpen(true)}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold inline-flex items-center gap-2 shadow-sm"
                >
                  <Camera className="w-4 h-4" />
                  <span>Open camera</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="min-h-[44px] px-5 py-2.5 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/40 text-[#2D2B35] text-sm font-semibold inline-flex items-center gap-2"
                >
                  <Upload className="w-4 h-4 text-[#4CB729]" />
                  <span>Upload photo</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl overflow-hidden border border-[#E8DFC5] bg-white aspect-video flex items-center justify-center">
                <img src={previewUrl} alt="Pothole preview" className="w-full h-full object-cover" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCameraModalOpen(true)}
                  className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Retake</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/40 text-xs font-semibold text-[#2D2B35]"
                >
                  Replace photo
                </button>
              </div>
            </div>
          )}

          {rawError && (
            <div className="rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/30 px-3.5 py-2.5 text-xs text-[#DC2626] flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{rawError}</span>
            </div>
          )}

          {/* Step 2 — location (only after a photo is chosen) */}
          {previewUrl && (
            <section className="rounded-2xl border border-[#E8DFC5] bg-white p-5 space-y-3.5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-display text-base font-bold text-[#2D2B35]">
                  Confirm the location
                </h3>
                {exifFound && (
                  <span className="font-mono text-[10px] font-bold tracking-wide text-[#4CB729] bg-[#4CB729]/10 px-2 py-1 rounded-full">
                    FROM PHOTO GPS
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseCurrentGps}
                  disabled={gpsLoading}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#2D2B35] hover:bg-[#3A3535] text-white text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60"
                >
                  {gpsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Crosshair className="w-4 h-4" />
                  )}
                  <span>Use my location</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowPin((open) => !open)}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-2"
                >
                  <MapPin className="w-4 h-4 text-[#4CB729]" />
                  <span>{showPin ? 'Hide map' : 'Drop a pin'}</span>
                </button>
              </div>

              {gpsStatusMsg && (
                <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] px-3.5 py-2.5 text-xs text-[#4B4646]">
                  {gpsStatusMsg}
                </div>
              )}

              {showPin && (
                <PinPickerMap mapsConfig={mapsConfig} coords={coords} onChangeCoords={handlePinChange} />
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 px-3 py-2">
                  Source:{' '}
                  <span className="font-semibold text-[#2D2B35]">
                    {coords ? COORDINATE_SOURCE_LABELS[coordinateSource] : 'Not set yet'}
                  </span>
                </div>
                <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 px-3 py-2 font-mono tabular-nums">
                  {coords
                    ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`
                    : 'Use location or drop a pin'}
                </div>
              </div>
            </section>
          )}

          {/* Honesty note — what sign-in unlocks */}
          {previewUrl && (
            <div className="rounded-xl bg-[#4CB729]/5 border border-[#4CB729]/25 px-4 py-3 text-xs text-[#4B4646] leading-relaxed">
              After you sign in, PatchUp looks up the street address, checks for nearby reports,
              verifies the photo shows a pothole, and publishes it to the Atlanta community map —
              credited to you. Your photo and location are kept until then and never submitted
              automatically.
            </div>
          )}

          {authError && (
            <div className="rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/30 px-3.5 py-2.5 text-xs text-[#DC2626]">
              {authError}
            </div>
          )}
        </div>

        {/* Footer CTA */}
        {previewUrl && (
          <footer className="px-5 sm:px-6 py-4 border-t border-[#E8DFC5] bg-white sm:rounded-b-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sticky bottom-0">
            <p className="text-xs text-[#6E6978] max-w-xs">
              {coords
                ? 'Location confirmed. Continue with Google to verify and submit.'
                : 'Set the pothole’s location above to continue.'}
            </p>
            <div className="shrink-0">
              {coords ? (
                <GoogleSignInButton
                  onClick={handleContinue}
                  disabled={isSigningIn}
                  label="Continue with Google"
                />
              ) : (
                <button
                  type="button"
                  disabled
                  className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[#E8DFC5]/60 text-[#9A948A] text-sm font-semibold cursor-not-allowed"
                >
                  Confirm location first
                </button>
              )}
            </div>
          </footer>
        )}
      </div>

      <CameraCaptureModal
        isOpen={cameraModalOpen}
        onClose={() => setCameraModalOpen(false)}
        onCapture={(captured) => void processFile(captured)}
        onOpenNativeCamera={() => nativeCameraInputRef.current?.click()}
        onOpenFilePicker={() => fileInputRef.current?.click()}
      />
    </div>
  );
};

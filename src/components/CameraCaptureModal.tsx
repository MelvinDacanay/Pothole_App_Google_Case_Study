import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Loader2,
  RefreshCw,
  SwitchCamera,
  Upload,
  X,
} from 'lucide-react';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  onOpenNativeCamera: () => void;
  onOpenFilePicker: () => void;
}

type FacingMode = 'environment' | 'user';

function stopStreamTracks(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function describeCameraError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name?: string }).name || '');
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Camera permission was declined or blocked by this browser. Allow camera access in site settings, or launch your device native camera below.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No internal camera was detected on this device. You can still select an image or use a native mobile camera.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Your camera appears to be in use by another app or tab. Close the other camera session and retry.';
    }
    if (name === 'SecurityError') {
      return 'Live camera access requires HTTPS or localhost.';
    }
  }
  return 'Unable to open live camera preview. Use your device native camera or choose a photo from your library.';
}

export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({
  isOpen,
  onClose,
  onCapture,
  onOpenNativeCamera,
  onOpenFilePicker,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [facingMode, setFacingMode] = useState<FacingMode>('environment');
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const cleanupStream = useCallback(() => {
    stopStreamTracks(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsVideoReady(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      cleanupStream();
      setCameraError(null);
      setIsCapturing(false);
      return;
    }

    let cancelled = false;

    const startCamera = async () => {
      cleanupStream();
      setIsStarting(true);
      setCameraError(null);

      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== 'function'
      ) {
        if (!cancelled) {
          setIsStarting(false);
          setCameraError(
            'Live in-browser camera preview is unavailable in this browser. Launch your device native camera or choose a photo instead.'
          );
        }
        return;
      }

      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: facingMode },
              width: { ideal: 1280 },
              height: { ideal: 960 },
            },
            audio: false,
          });
        } catch (primaryErr) {
          const errName =
            primaryErr && typeof primaryErr === 'object' && 'name' in primaryErr
              ? String((primaryErr as { name?: string }).name)
              : '';
          if (errName === 'OverconstrainedError' || errName === 'ConstraintNotSatisfiedError') {
            stream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } else {
            throw primaryErr;
          }
        }

        if (cancelled) {
          stopStreamTracks(stream);
          return;
        }

        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            // Autoplay may resolve after loadedmetadata fires
          });
        }

        if (navigator.mediaDevices.enumerateDevices) {
          navigator.mediaDevices
            .enumerateDevices()
            .then((devices) => {
              if (!cancelled) {
                const videoInputs = devices.filter((d) => d.kind === 'videoinput');
                setHasMultipleCameras(videoInputs.length > 1);
              }
            })
            .catch(() => {
              // Ignore enumerateDevices failure on restricted browsers
            });
        }
      } catch (err) {
        if (!cancelled) {
          setCameraError(describeCameraError(err));
        }
      } finally {
        if (!cancelled) {
          setIsStarting(false);
        }
      }
    };

    void startCamera();

    return () => {
      cancelled = true;
      cleanupStream();
    };
  }, [isOpen, facingMode, retryToken, cleanupStream]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cleanupStream();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, cleanupStream, onClose]);

  const handleClose = () => {
    cleanupStream();
    onClose();
  };

  const handleSnapPhoto = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0 || isCapturing) {
      return;
    }

    setIsCapturing(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Unable to read frame from camera.');
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.92)
      );
      if (!blob) {
        throw new Error('Failed to capture photograph from camera stream.');
      }

      const file = new File([blob], `patchup_camera_${Date.now()}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });

      cleanupStream();
      onCapture(file);
      onClose();
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : 'Unable to save captured frame.');
      setIsCapturing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Take pothole photograph"
      className="fixed inset-0 z-50 bg-[#1B1A22]/95 text-white flex flex-col justify-between gap-3 p-3 sm:p-6 pt-safe pb-safe overflow-y-auto overscroll-contain"
    >
      {/* Top Bar */}
      <div className="max-w-3xl mx-auto w-full flex items-start justify-between gap-3 shrink-0">
        <div>
          <h2 className="font-display text-lg font-bold text-white">Camera Viewfinder</h2>
          <p className="hidden min-[380px]:block text-xs text-white/75">
            Frame the pothole clearly with surrounding pavement for street context.
          </p>
        </div>

        <button
          type="button"
          onClick={handleClose}
          aria-label="Close camera"
          className="min-h-[44px] min-w-[44px] px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition focus-visible:outline-2 focus-visible:outline-[#4CB729]"
        >
          <X className="w-4 h-4" />
          <span>Close</span>
        </button>
      </div>

      {/* Live Video Preview Frame */}
      <div className="max-w-3xl mx-auto w-full flex-1 flex items-center justify-center min-h-[220px]">
        <div className="relative w-full h-full min-h-[220px] max-h-[64dvh] rounded-2xl overflow-hidden bg-black border border-white/15 flex items-center justify-center">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onLoadedMetadata={() => {
              if (videoRef.current && videoRef.current.videoWidth > 0) {
                setIsVideoReady(true);
              }
            }}
            onCanPlay={() => {
              if (videoRef.current && videoRef.current.videoWidth > 0) {
                setIsVideoReady(true);
              }
            }}
            className={`w-full h-full object-contain ${
              facingMode === 'user' ? 'scale-x-[-1]' : ''
            } ${cameraError ? 'hidden' : 'block'}`}
          />

          {/* Subtle corner framing marks */}
          {!cameraError && isVideoReady && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-6 sm:inset-10 border border-white/25 rounded-xl"
            />
          )}

          {isStarting && !cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/70 text-xs text-white/85 p-4 text-center">
              <Loader2 className="w-7 h-7 animate-spin text-[#4CB729]" />
              <span>Opening device camera...</span>
            </div>
          )}

          {cameraError && (
            <div className="p-6 max-w-md text-center space-y-4">
              <AlertTriangle className="w-9 h-9 text-[#D97706] mx-auto" />
              <div className="space-y-1.5">
                <h3 className="font-display text-base font-bold text-white">
                  Live Camera Unavailable
                </h3>
                <p className="text-xs text-white/80 leading-relaxed">{cameraError}</p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setRetryToken((prev) => prev + 1)}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Retry Camera</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleClose();
                    onOpenNativeCamera();
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Camera className="w-4 h-4" />
                  <span>Use Device Native Camera</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleClose();
                    onOpenFilePicker();
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-white/25 hover:bg-white/10 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Upload className="w-4 h-4" />
                  <span>Choose Photo</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Shutter & Camera Controls (Thumb Zone) */}
      <div className="max-w-3xl mx-auto w-full grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center sm:justify-between gap-2 sm:gap-3 shrink-0">
        <div className="contents sm:flex sm:items-center sm:gap-2">
          <button
            type="button"
            onClick={() =>
              setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))
            }
            disabled={isStarting || Boolean(cameraError)}
            aria-label="Switch front or rear camera"
            className="min-h-[44px] px-2.5 sm:px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 disabled:opacity-45 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap transition"
          >
            <SwitchCamera className="w-4 h-4" />
            <span>{hasMultipleCameras ? 'Flip Camera' : 'Switch Lens'}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              handleClose();
              onOpenNativeCamera();
            }}
            className="min-h-[44px] px-2.5 sm:px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white/90 text-xs font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition"
          >
            <Camera className="w-4 h-4" />
            <span>Native Camera</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() => void handleSnapPhoto()}
          disabled={!isVideoReady || isCapturing || Boolean(cameraError)}
          className="col-span-2 sm:col-span-1 min-h-[48px] px-6 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] disabled:opacity-45 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 shadow-lg transition active:scale-[0.98]"
        >
          {isCapturing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Camera className="w-4 h-4" />
          )}
          <span>{isCapturing ? 'Capturing...' : 'Take Photo'}</span>
        </button>
      </div>
    </div>
  );
};

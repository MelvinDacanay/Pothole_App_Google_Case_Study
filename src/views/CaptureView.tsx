import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Crosshair,
  Loader2,
  MapPin,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CameraCaptureModal } from '../components/CameraCaptureModal';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { PinPickerMap } from '../components/PinPickerMap';
import { extractExifGpsFromFile } from '../lib/exif';
import {
  CompressedImageResult,
  compressImageForUpload,
  uploadImageWithRetry,
} from '../lib/imageUpload';
import {
  COORDINATE_SOURCE_LABELS,
  CoordinateSource,
  dispatchMapsQuotaWarning,
  DuplicateCandidateSummary,
  loadMapsClientConfig,
  MapsClientConfig,
  SeverityLabel,
} from '../lib/maps';
import { consumePendingCapture } from '../lib/pendingCapture';
import { OfficialReportPanel } from '../components/OfficialReportPanel';

interface CaptureViewProps {
  preselectedPothole: {
    potholeId: string;
    lat: number;
    lng: number;
    formattedAddress: string;
    streetName: string;
    primaryMediaId?: string;
    primaryPhotoUrl?: string;
  } | null;
  onClearPreselected: () => void;
  onSubmittedToMap: (potholeId: string, coords: { lat: number; lng: number }) => void;
}

interface ReverseGeocodeResponse {
  formattedAddress: string;
  streetName: string;
  normalizedStreet: string;
  neighborhood?: string;
  city: string;
  state: string;
  postalCode?: string;
  placeId?: string;
  jurisdiction: 'atldot' | 'gdot' | 'unknown';
  source: 'google_geocoding' | 'cache' | 'coordinate_fallback';
  inAtlantaMetro: boolean;
}

interface GeminiAnalysisState {
  available: boolean;
  status: 'completed' | 'unavailable' | 'skipped';
  model?: string;
  isRoadDefect: boolean;
  severityLabel: SeverityLabel;
  confidence: number;
  summary: string;
  duplicateAssessment?: 'same_pothole' | 'uncertain' | 'likely_different';
  duplicateReason?: string;
  error?: string;
}

function createDraftSubmissionId(): string {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createMediaId(): string {
  return `med_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const CaptureView: React.FC<CaptureViewProps> = ({
  preselectedPothole,
  onClearPreselected,
  onSubmittedToMap,
}) => {
  const { user, isSigningIn, signIn } = useAuth();

  const [mapsConfig, setMapsConfig] = useState<MapsClientConfig>({
    configured: false,
    apiKey: '',
    mapId: 'DEMO_MAP_ID',
  });

  // Step 1: Photo compression & isolated mediaObjects upload state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [cameraModalOpen, setCameraModalOpen] = useState(false);
  const [manualLocationOpen, setManualLocationOpen] = useState(false);
  const [classificationAppealed, setClassificationAppealed] = useState(false);
  const [compressedPhoto, setCompressedPhoto] = useState<CompressedImageResult | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string>(() => createDraftSubmissionId());
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [exifCoordsFound, setExifCoordsFound] = useState<{ lat: number; lng: number } | null>(null);

  // Step 2: Explicit GPS / EXIF / Manual pin state (never continuous tracking)
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(() =>
    preselectedPothole ? { lat: preselectedPothole.lat, lng: preselectedPothole.lng } : null
  );
  const [coordinateSource, setCoordinateSource] = useState<CoordinateSource>('manual_pin');
  const [accuracyMeters, setAccuracyMeters] = useState<number | undefined>(undefined);
  const [locationUserCorrected, setLocationUserCorrected] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsStatusMsg, setGpsStatusMsg] = useState<string | null>(null);

  // Reverse geocoding & street metadata
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeSource, setGeocodeSource] = useState<string | null>(null);
  const [inAtlantaMetro, setInAtlantaMetro] = useState<boolean>(true);
  const [formattedAddress, setFormattedAddress] = useState(
    preselectedPothole?.formattedAddress ?? ''
  );
  const [streetName, setStreetName] = useState(preselectedPothole?.streetName ?? '');
  const [neighborhood, setNeighborhood] = useState('');
  const [city, setCity] = useState('Atlanta');
  const [stateCode, setStateCode] = useState('GA');
  const [postalCode, setPostalCode] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [jurisdiction, setJurisdiction] = useState<'atldot' | 'gdot' | 'unknown'>('unknown');
  const [notes, setNotes] = useState('');

  // Step 3: 25m Duplicate candidates + optional Gemini check
  const [searchingCandidates, setSearchingCandidates] = useState(false);
  const [candidates, setCandidates] = useState<DuplicateCandidateSummary[]>([]);
  const [actionType, setActionType] = useState<
    'new_pothole' | 'add_evidence' | 'provisional_review'
  >(preselectedPothole ? 'add_evidence' : 'new_pothole');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>(
    preselectedPothole?.potholeId ?? ''
  );

  const [analyzingAi, setAnalyzingAi] = useState(false);
  const [aiResult, setAiResult] = useState<GeminiAnalysisState>({
    available: true,
    status: 'skipped',
    isRoadDefect: true,
    severityLabel: 'unclassified',
    confidence: 0,
    summary: '',
  });

  // Step 4: Submit state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedResult, setSubmittedResult] = useState<{
    potholeId: string;
    submissionId: string;
    duplicateStatus: string;
    coords: { lat: number; lng: number };
  } | null>(null);

  const geocodeSeqRef = useRef(0);
  const candidateSeqRef = useRef(0);
  const pendingConsumedRef = useRef(false);

  // Ingest a pre-auth landing capture once, as soon as the signed-in view mounts.
  useEffect(() => {
    if (pendingConsumedRef.current || !user || preselectedPothole) return;
    const draft = consumePendingCapture();
    if (!draft) return;
    pendingConsumedRef.current = true;
    void processSelectedFile(
      draft.file,
      'file',
      draft.coords
        ? {
            coords: draft.coords,
            coordinateSource: draft.coordinateSource,
            locationUserCorrected: draft.locationUserCorrected,
          }
        : null
    );
    // Runs once on mount for the landing handoff; processSelectedFile is stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    loadMapsClientConfig().then(setMapsConfig);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      uploadAbortRef.current?.abort();
    };
  }, [previewUrl]);

  // Sync if preselectedPothole prop changes from MapView "Add Evidence Photo"
  useEffect(() => {
    if (preselectedPothole) {
      setCoords({ lat: preselectedPothole.lat, lng: preselectedPothole.lng });
      setCoordinateSource('manual_pin');
      setAccuracyMeters(undefined);
      setFormattedAddress(preselectedPothole.formattedAddress);
      setStreetName(preselectedPothole.streetName);
      setActionType('add_evidence');
      setSelectedCandidateId(preselectedPothole.potholeId);
      setSubmittedResult(null);
    }
  }, [preselectedPothole]);

  const runReverseGeocode = useCallback(
    async (target: { lat: number; lng: number }, forceOverwriteText = false) => {
      if (!user) return;
      const seq = ++geocodeSeqRef.current;
      setGeocoding(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/geocode/reverse', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(target),
        });
        const data = (await res.json()) as ReverseGeocodeResponse & {
          quotaExceeded?: boolean;
          error?: string;
        };
        if (seq !== geocodeSeqRef.current) return;

        if (res.status === 429 || data.quotaExceeded) {
          dispatchMapsQuotaWarning();
          return;
        }
        if (!res.ok) return;

        setGeocodeSource(data.source);
        setInAtlantaMetro(Boolean(data.inAtlantaMetro));
        setJurisdiction(data.jurisdiction || 'unknown');
        setNeighborhood(data.neighborhood || '');
        setCity(data.city || 'Atlanta');
        setStateCode(data.state || 'GA');
        setPostalCode(data.postalCode || '');
        setPlaceId(data.placeId || '');

        if (forceOverwriteText || !locationUserCorrected) {
          setFormattedAddress(data.formattedAddress || '');
          setStreetName(data.streetName || '');
        }
      } catch {
        // Non-fatal fallback: coordinates remain valid even if reverse geocode fails
      } finally {
        if (seq === geocodeSeqRef.current) {
          setGeocoding(false);
        }
      }
    },
    [user, locationUserCorrected]
  );

  const runCandidateSearch = useCallback(
    async (target: { lat: number; lng: number }, currentStreet: string) => {
      if (!user) return;
      const seq = ++candidateSeqRef.current;
      setSearchingCandidates(true);
      try {
        const token = await user.getIdToken();
        const res = await fetch('/api/potholes/candidates', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            lat: target.lat,
            lng: target.lng,
            streetName: currentStreet,
          }),
        });
        const data = (await res.json()) as { candidates?: DuplicateCandidateSummary[] };
        if (seq !== candidateSeqRef.current) return;

        const nextCandidates = Array.isArray(data.candidates) ? data.candidates : [];
        setCandidates(nextCandidates);

        if (preselectedPothole) {
          setActionType('add_evidence');
          setSelectedCandidateId(preselectedPothole.potholeId);
        } else if (nextCandidates.length > 0) {
          const top = nextCandidates[0];
          setSelectedCandidateId((prev) =>
            nextCandidates.some((c) => c.potholeId === prev) ? prev : top.potholeId
          );
          if (top.recommendation === 'likely_same') {
            setActionType('add_evidence');
          } else if (top.recommendation === 'uncertain') {
            setActionType('provisional_review');
          } else {
            setActionType('new_pothole');
          }
        } else {
          setSelectedCandidateId('');
          setActionType('new_pothole');
        }
      } catch {
        if (seq === candidateSeqRef.current) {
          setCandidates([]);
        }
      } finally {
        if (seq === candidateSeqRef.current) {
          setSearchingCandidates(false);
        }
      }
    },
    [user, preselectedPothole]
  );

  // Debounce reverse geocode & 25m search when coordinates change
  useEffect(() => {
    if (!user || !coords) return;
    const timer = window.setTimeout(() => {
      void runReverseGeocode(coords, false);
      void runCandidateSearch(coords, streetName);
    }, 350);
    return () => window.clearTimeout(timer);
    // Intentionally triggered on coordinate change; streetName is read as latest snapshot
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, user]);

  const startUpload = async (compressed: CompressedImageResult) => {
    if (!user) return;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;

    const nextMediaId = createMediaId();
    setUploading(true);
    setUploadProgress(5);
    setUploadError(null);
    setMediaId(null);

    try {
      await uploadImageWithRetry({
        uid: user.uid,
        fileId: nextMediaId,
        compressed,
        onProgress: setUploadProgress,
        signal: controller.signal,
      });
      setMediaId(nextMediaId);
      setSubmissionId(createDraftSubmissionId());
      setAiResult({
        available: true,
        status: 'skipped',
        isRoadDefect: true,
        severityLabel: 'unclassified',
        confidence: 0,
        summary: '',
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Photo upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const processSelectedFile = async (
    file: File,
    _source: 'camera' | 'file',
    seededLocation?: {
      coords: { lat: number; lng: number };
      coordinateSource: CoordinateSource;
      locationUserCorrected: boolean;
    } | null
  ) => {
    setUploadError(null);
    setSubmittedResult(null);

    try {
      const [compressed, exifGps] = await Promise.all([
        compressImageForUpload(file),
        extractExifGpsFromFile(file),
      ]);

      if (previewUrl) URL.revokeObjectURL(previewUrl);
      const nextPreview = URL.createObjectURL(compressed.blob);
      setPreviewUrl(nextPreview);
      setCompressedPhoto(compressed);
      setExifCoordsFound(exifGps);
      setClassificationAppealed(false);

      if (seededLocation) {
        // Location the visitor already confirmed on the landing page — honor it
        // as-is rather than re-deriving from EXIF or device GPS.
        setCoords(seededLocation.coords);
        setCoordinateSource(seededLocation.coordinateSource);
        setAccuracyMeters(undefined);
        setLocationUserCorrected(seededLocation.locationUserCorrected);
        setGpsStatusMsg('Using the location you set before signing in. Drag the pin to refine.');
      } else if (exifGps && !preselectedPothole && !coords) {
        setCoords(exifGps);
        setCoordinateSource('exif_extracted');
        setAccuracyMeters(undefined);
        setLocationUserCorrected(false);
        setGpsStatusMsg('Loaded genuine GPS coordinates from photograph EXIF metadata.');
      } else if (!coords && !exifGps) {
        handleUseCurrentGps();
      }

      await startUpload(compressed);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Unable to process image.');
    }
  };

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
    source: 'camera' | 'file'
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await processSelectedFile(file, source);
    } finally {
      e.target.value = '';
    }
  };

  function handleUseCurrentGps() {
    if (!('geolocation' in navigator)) {
      setGpsStatusMsg('Browser geolocation is unavailable here. Tap the map to place a manual pin.');
      return;
    }

    setGpsLoading(true);
    setGpsStatusMsg('Requesting one-time browser GPS fix...');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextCoords = {
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        };
        setCoords(nextCoords);
        setCoordinateSource('gps_verified');
        setAccuracyMeters(
          Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : undefined
        );
        setLocationUserCorrected(false);
        setGpsLoading(false);
        setGpsStatusMsg(
          `One-time GPS fix acquired (~${Math.round(position.coords.accuracy || 0)}m accuracy). Drag pin to refine if needed.`
        );
      },
      (geoErr) => {
        setGpsLoading(false);
        if (geoErr.code === geoErr.PERMISSION_DENIED) {
          setGpsStatusMsg(
            'Location permission declined. Tap the Atlanta map below to place a manual pin.'
          );
        } else {
          setGpsStatusMsg(
            'Unable to acquire GPS fix. Tap the Atlanta map below to place a manual pin.'
          );
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 15000,
      }
    );
  }

  const handleManualPinChange = (nextCoords: { lat: number; lng: number }) => {
    setCoords(nextCoords);
    setCoordinateSource('manual_pin');
    setAccuracyMeters(undefined);
    setLocationUserCorrected(true);
    setGpsStatusMsg('Manual pin updated. Reverse geocoding and 25m check refreshed.');
  };

  const handleOptionalAiCheck = async () => {
    if (!user || !mediaId) return;
    setAnalyzingAi(true);
    try {
      const token = await user.getIdToken();
      const chosenCandidate = candidates.find((c) => c.potholeId === selectedCandidateId);
      const candidateMediaId =
        preselectedPothole?.primaryMediaId || chosenCandidate?.primaryMediaId || undefined;

      const res = await fetch('/api/potholes/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mediaId,
          candidateMediaId,
          notes,
        }),
      });
      const data = (await res.json()) as GeminiAnalysisState;
      setAiResult({
        available: Boolean(data.available),
        status: data.status ?? (data.available ? 'completed' : 'unavailable'),
        model: data.model,
        isRoadDefect: typeof data.isRoadDefect === 'boolean' ? data.isRoadDefect : true,
        severityLabel: data.severityLabel ?? 'unclassified',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0,
        summary: data.summary ?? 'Optional photo analysis unavailable.',
        duplicateAssessment: data.duplicateAssessment,
        duplicateReason: data.duplicateReason,
        error: data.error,
      });
    } catch {
      setAiResult({
        available: false,
        status: 'unavailable',
        isRoadDefect: true,
        severityLabel: 'unclassified',
        confidence: 0,
        summary: 'Optional image analysis unavailable; capture continues normally.',
      });
    } finally {
      setAnalyzingAi(false);
    }
  };

  useEffect(() => {
    if (!mediaId || aiResult.status !== 'skipped' || analyzingAi) return;
    void handleOptionalAiCheck();
    // The uploaded media ID is the trigger; the classifier runs once per new photo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  const topCandidateConfidence = useMemo(() => {
    const match = candidates.find((c) => c.potholeId === selectedCandidateId) ?? candidates[0];
    return match ? match.confidence : 0;
  }, [candidates, selectedCandidateId]);

  const canSubmit = Boolean(
    user &&
      user.emailVerified &&
      mediaId &&
      !uploading &&
      coords &&
      streetName.trim().length > 0 &&
      aiResult.status === 'completed' &&
      (aiResult.isRoadDefect || classificationAppealed) &&
      (actionType !== 'add_evidence' || selectedCandidateId)
  );
  const submissionActionType = classificationAppealed ? 'provisional_review' : actionType;

  const handleSubmitPothole = async () => {
    if (!user || !mediaId || !coords || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const token = await user.getIdToken();
      const candidateIds = preselectedPothole
        ? [preselectedPothole.potholeId]
        : candidates.map((c) => c.potholeId);

      const res = await fetch('/api/potholes/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          submissionId,
          mediaId,
          lat: coords.lat,
          lng: coords.lng,
          coordinateSource,
          accuracyMeters,
          actionType: submissionActionType,
          targetPotholeId: submissionActionType === 'add_evidence' ? selectedCandidateId : undefined,
          candidatePotholeIds: candidateIds,
          formattedAddress:
            formattedAddress.trim() || `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}, Atlanta, GA`,
          streetName: streetName.trim(),
          neighborhood: neighborhood.trim() || undefined,
          city: city.trim() || 'Atlanta',
          state: stateCode.trim() || 'GA',
          postalCode: postalCode.trim() || undefined,
          placeId: placeId.trim() || undefined,
          locationUserCorrected,
          notes: notes.trim() || undefined,
          duplicateConfidence: topCandidateConfidence,
          aiClassificationStatus: aiResult.status,
          aiIsRoadDefect: aiResult.isRoadDefect,
          aiSeverityLabel: aiResult.severityLabel,
          aiSummary: aiResult.summary || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Submission failed.');
      }

      setSubmittedResult({
        potholeId: data.potholeId,
        submissionId: data.submissionId,
        duplicateStatus: data.duplicateStatus,
        coords,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to save submission.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetCapture = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setCompressedPhoto(null);
    setMediaId(null);
    setSubmissionId(createDraftSubmissionId());
    setUploadProgress(0);
    setUploadError(null);
    setClassificationAppealed(false);
    setExifCoordsFound(null);
    setNotes('');
    setSubmittedResult(null);
    setSubmitError(null);
    setAiResult({
      available: true,
      status: 'skipped',
      isRoadDefect: true,
      severityLabel: 'unclassified',
      confidence: 0,
      summary: '',
    });
    if (preselectedPothole) {
      onClearPreselected();
    }
    setCoords(null);
    setFormattedAddress('');
    setStreetName('');
    setCandidates([]);
    setSelectedCandidateId('');
    setActionType('new_pothole');
  };

  if (!user) {
    return (
      <div className="max-w-2xl mx-auto bg-white rounded-2xl border border-[#E8DFC5] p-6 sm:p-8 text-center space-y-4">
        <Camera className="w-10 h-10 text-[#4CB729] mx-auto" />
        <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
          Sign in to Document Potholes
        </h1>
        <p className="text-sm text-[#4B4646] max-w-md mx-auto leading-relaxed">
          Sign in to photograph a pothole, verify it, and add it to Atlanta’s community map.
        </p>
        <div className="pt-2 flex justify-center">
          <GoogleSignInButton onClick={() => void signIn()} disabled={isSigningIn} />
        </div>
      </div>
    );
  }

  if (submittedResult) {
    return (
      <div className="city-page city-capture capture-success max-w-2xl mx-auto space-y-5">
        <div className="bg-white rounded-2xl border border-[#E8DFC5] p-6 sm:p-8 space-y-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-8 h-8 text-[#4CB729] shrink-0" />
          <div>
            <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
              {submittedResult.duplicateStatus === 'distinct'
                ? 'Distinct Pothole Recorded'
                : submittedResult.duplicateStatus === 'evidence_added'
                  ? 'Supporting Evidence Linked'
                  : 'Provisional Review Saved'}
            </h1>
            <p className="text-sm text-[#4B4646] mt-1">
              {submittedResult.duplicateStatus === 'distinct'
                ? 'Your verified submission is now live on the Atlanta community map and credited to your profile.'
                : submittedResult.duplicateStatus === 'evidence_added'
                  ? 'Your photo was added as supporting evidence without inflating distinct pothole counts.'
                  : 'Your submission is preserved for review on Home and excluded from distinct counts until resolved.'}
            </p>
          </div>
        </div>

        <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-[#6E6978]">Street</div>
            <div className="font-semibold text-[#2D2B35] mt-0.5">{streetName}</div>
          </div>
          <div>
            <div className="text-[#6E6978]">Location Source</div>
            <div className="font-semibold text-[#2D2B35] mt-0.5">
              {COORDINATE_SOURCE_LABELS[coordinateSource]}
            </div>
          </div>
          <div>
            <div className="text-[#6E6978]">Pothole ID</div>
            <div className="font-mono text-[#2D2B35] mt-0.5 truncate">
              {submittedResult.potholeId}
            </div>
          </div>
          <div>
            <div className="text-[#6E6978]">Coordinates</div>
            <div className="font-mono text-[#2D2B35] mt-0.5 tabular-nums">
              {submittedResult.coords.lat.toFixed(5)}, {submittedResult.coords.lng.toFixed(5)}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => onSubmittedToMap(submittedResult.potholeId, submittedResult.coords)}
            className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition flex items-center gap-2"
          >
            <MapPin className="w-4 h-4" />
            <span>View on Atlanta Map</span>
          </button>
          <button
            type="button"
            onClick={handleResetCapture}
            className="min-h-[44px] px-4 py-2.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35] text-sm font-semibold transition flex items-center gap-2"
          >
            <Camera className="w-4 h-4" />
            <span>Capture Another</span>
          </button>
        </div>
        </div>

        {submittedResult.duplicateStatus === 'distinct' && mediaId && streetName.trim() && (
          <OfficialReportPanel
            input={{
              potholeId: submittedResult.potholeId,
              streetName: streetName.trim(),
              formattedAddress: formattedAddress.trim() || streetName.trim(),
              lat: submittedResult.coords.lat,
              lng: submittedResult.coords.lng,
              jurisdiction,
              agencyName:
                jurisdiction === 'gdot'
                  ? 'Georgia Department of Transportation (GDOT)'
                  : 'City of Atlanta — ATL311',
              severityLabel: aiResult.severityLabel,
              coordinateSource,
              notes: notes.trim() || undefined,
              reportedAtISO: new Date().toISOString(),
              photoUrl: `/api/media/${mediaId}`,
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`city-page city-capture max-w-6xl mx-auto space-y-6 ${manualLocationOpen ? 'manual-location-open' : ''}`}>
      <div className="page-banner page-banner-capture">
        <div>
          <span className="page-banner-index">FIELD TOOL / 03</span>
          <h1>SNAP THE<br /><em>EVIDENCE.</em></h1>
          <p>Take the picture. PatchUp handles location, verification, nearby-report checks, and publishing.</p>
        </div>
        <Camera className="page-banner-icon" aria-hidden="true" />
      </div>
      {/* Header */}
      <div className="capture-toolbelt bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
            {preselectedPothole ? 'Add Evidence Photo' : 'Capture & Verify Pothole'}
          </h1>
          <p className="text-xs sm:text-sm text-[#6E6978] mt-1">
            Take one clear photo of the pothole. We’ll process the image and capture its location
            automatically.
          </p>
        </div>
        {preselectedPothole && (
          <button
            type="button"
            onClick={() => {
              onClearPreselected();
              setActionType('new_pothole');
              setSelectedCandidateId('');
            }}
            className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5 shrink-0"
          >
            <X className="w-4 h-4" />
            <span>Switch to New Spot</span>
          </button>
        )}
        {!preselectedPothole && (
          <button
            type="button"
            onClick={() => setManualLocationOpen((open) => !open)}
            className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35]"
          >
            {manualLocationOpen ? 'Hide manual map pin' : 'Pin a location instead'}
          </button>
        )}
      </div>

      {!user.emailVerified && (
        <div className="rounded-xl bg-[#D97706]/10 border border-[#D97706]/30 p-4 text-xs text-[#2D2B35] flex items-center gap-2.5">
          <AlertTriangle className="w-5 h-5 text-[#D97706] shrink-0" />
          <span>Your account email is unverified. Verified email is required to submit potholes.</span>
        </div>
      )}

      {preselectedPothole && (
        <div className="rounded-2xl bg-white border border-[#4CB729]/40 p-4 flex items-center gap-3">
          {preselectedPothole.primaryPhotoUrl && (
            <img
              src={preselectedPothole.primaryPhotoUrl}
              alt={preselectedPothole.streetName}
              referrerPolicy="no-referrer"
              className="w-12 h-12 rounded-xl object-cover border border-[#E8DFC5] shrink-0"
            />
          )}
          <div className="text-xs">
            <div className="font-semibold text-[#2D2B35]">
              Adding supporting evidence to {preselectedPothole.streetName}
            </div>
            <div className="text-[#6E6978]">{preselectedPothole.formattedAddress}</div>
          </div>
        </div>
      )}

      {/* Step 1: Photo Capture & Compression Upload */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">
            Take a pothole photo
          </h2>
          {compressedPhoto && (
            <span className="font-mono text-xs text-[#6E6978]">PHOTO READY</span>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => void handleFileChange(e, 'file')}
          className="hidden"
        />

        <input
          ref={nativeCameraInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={(e) => void handleFileChange(e, 'camera')}
          className="hidden"
        />

        {!previewUrl ? (
          <div className="rounded-2xl border-2 border-dashed border-[#E8DFC5] bg-[#F7F7F8] p-5 sm:p-6 flex flex-col items-center justify-center gap-4 text-center">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[#2D2B35]">
                Take a Photo or Choose from Library
              </div>
              <div className="text-xs text-[#6E6978]">JPG, PNG, or WebP · Up to 10 MB</div>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => setCameraModalOpen(true)}
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 shadow-sm"
              >
                <Camera className="w-4 h-4" />
                <span>Open Camera</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[44px] px-5 py-2.5 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/40 text-[#2D2B35] text-sm font-semibold transition inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
              >
                <Upload className="w-4 h-4 text-[#4CB729]" />
                <span>Choose Photo</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
            <div className="sm:col-span-5 rounded-xl overflow-hidden border border-[#E8DFC5] bg-[#F7F7F8] aspect-video flex items-center justify-center">
              <img
                src={previewUrl}
                alt="Compressed pothole preview"
                className="w-full h-full object-cover"
              />
            </div>
            <div className="sm:col-span-7 space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium text-[#2D2B35]">
                  <span>
                    {uploading
                      ? 'Uploading photo...'
                      : mediaId
                        ? 'Photo uploaded'
                        : 'Upload incomplete'}
                  </span>
                  <span className="font-mono tabular-nums">{uploadProgress}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-[#F7F7F8] border border-[#E8DFC5] overflow-hidden">
                  <div
                    className={`h-full transition-[width] duration-200 ${
                      uploadError ? 'bg-[#DC2626]' : 'bg-[#4CB729]'
                    }`}
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>

              {uploadError && (
                <div className="text-xs text-[#DC2626] bg-[#DC2626]/10 border border-[#DC2626]/25 rounded-xl p-2.5">
                  {uploadError}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {uploading ? (
                  <button
                    type="button"
                    onClick={() => uploadAbortRef.current?.abort()}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-xs font-semibold text-[#2D2B35] whitespace-nowrap shrink-0"
                  >
                    Cancel Upload
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setCameraModalOpen(true)}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>Retake with Camera</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] whitespace-nowrap shrink-0"
                    >
                      Replace Photo
                    </button>
                    {uploadError && compressedPhoto && (
                      <button
                        type="button"
                        onClick={() => void startUpload(compressedPhoto)}
                        className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Retry Upload</span>
                      </button>
                    )}
                  </>
                )}
                {exifCoordsFound && (
                  <button
                    type="button"
                    onClick={() => {
                      setCoords(exifCoordsFound);
                      setCoordinateSource('exif_extracted');
                      setAccuracyMeters(undefined);
                      setLocationUserCorrected(false);
                      setGpsStatusMsg('Applied EXIF GPS coordinates from photo.');
                    }}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#F7F7F8] text-xs font-semibold text-[#2D2B35] whitespace-nowrap shrink-0"
                  >
                    Use Photo EXIF GPS
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Step 2: Explicit Location & Pin Verification */}
      <section className="capture-location-details bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">
              Report with a map pin instead
            </h2>
            <p className="text-xs text-[#6E6978] mt-0.5">
              Use this fallback when you need to place or correct the location manually. PatchUp
              never tracks your location in the background.
            </p>
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
              <span>Use Current GPS</span>
            </button>
            {coords && (
              <button
                type="button"
                onClick={() => void runReverseGeocode(coords, true)}
                disabled={geocoding}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${geocoding ? 'animate-spin' : ''}`} />
                <span>Refresh Address</span>
              </button>
            )}
          </div>
        </div>

        {gpsStatusMsg && (
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] px-3.5 py-2.5 text-xs text-[#4B4646]">
            {gpsStatusMsg}
          </div>
        )}

        <PinPickerMap
          mapsConfig={mapsConfig}
          coords={coords}
          onChangeCoords={handleManualPinChange}
        />

        {coords && !inAtlantaMetro && (
          <div className="rounded-xl bg-[#D97706]/10 border border-[#D97706]/30 px-3.5 py-2.5 text-xs text-[#2D2B35] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0" />
            <span>
              Selected pin falls outside typical Atlanta Metro bounds. Double-check the map pin
              before publishing.
            </span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-[#4B4646]">
              Street Name {geocoding ? '(Looking up...)' : ''}
            </span>
            <input
              type="text"
              maxLength={128}
              value={streetName}
              placeholder="e.g., Peachtree St NE"
              onChange={(e) => {
                setStreetName(e.target.value);
                setLocationUserCorrected(true);
              }}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-[#4B4646]">Formatted Street Address</span>
            <input
              type="text"
              maxLength={256}
              value={formattedAddress}
              placeholder="e.g., 600 Peachtree St NE, Atlanta, GA 30308"
              onChange={(e) => {
                setFormattedAddress(e.target.value);
                setLocationUserCorrected(true);
              }}
              className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-[#6E6978]">
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 px-3 py-2">
            Source:{' '}
            <span className="font-semibold text-[#2D2B35]">
              {COORDINATE_SOURCE_LABELS[coordinateSource]}
            </span>
          </div>
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 px-3 py-2 font-mono tabular-nums">
            Coords:{' '}
            {coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : 'Tap map or use GPS'}
          </div>
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 px-3 py-2">
            Geocode:{' '}
            <span className="font-semibold text-[#2D2B35]">
              {geocodeSource === 'google_geocoding'
                ? 'Google Geocoding API'
                : geocodeSource === 'cache'
                  ? 'Cached Address'
                  : geocodeSource === 'coordinate_fallback'
                    ? 'Manual Entry'
                    : 'Pending pin'}
            </span>
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-[#4B4646]">
            Hazard Notes (Optional, max 400 chars)
          </span>
          <textarea
            rows={2}
            maxLength={400}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Lane position, standing water, exposed rebar, or nearby cross street..."
            className="w-full px-3.5 py-2.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
          />
        </label>
      </section>

      {/* Step 3: 25m Duplicate Review & Optional AI Check */}
      <section className="capture-internal-checks bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">
              3. 25m Duplicate Check & Optional Photo Analysis
            </h2>
            <p className="text-xs text-[#6E6978] mt-0.5">
              Candidates within 25m are reviewed by confidence so separate nearby craters are never
              blindly merged.
            </p>
          </div>
          {coords && (
            <button
              type="button"
              onClick={() => void runCandidateSearch(coords, streetName)}
              disabled={searchingCandidates}
              className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5 shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${searchingCandidates ? 'animate-spin' : ''}`} />
              <span>Recheck 25m Radius</span>
            </button>
          )}
        </div>

        {searchingCandidates ? (
          <div className="text-xs text-[#6E6978] py-2">Searching within 25 meters...</div>
        ) : candidates.length === 0 ? (
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3.5 text-xs text-[#4B4646]">
            {coords
              ? 'No existing pothole records found within 25 meters of this pin.'
              : 'Set a map pin or GPS fix above to scan the 25m radius.'}
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="text-xs font-semibold text-[#2D2B35]">
              Nearby Potholes Within 25m ({candidates.length})
            </div>
            {candidates.map((cand) => {
              const selected = selectedCandidateId === cand.potholeId;
              return (
                <button
                  key={cand.potholeId}
                  type="button"
                  onClick={() => setSelectedCandidateId(cand.potholeId)}
                  className={`w-full p-3 rounded-xl border text-left flex items-center justify-between gap-3 transition ${
                    selected
                      ? 'border-[#4CB729] bg-[#4CB729]/5'
                      : 'border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/30'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={cand.primaryPhotoUrl}
                      alt={cand.streetName}
                      referrerPolicy="no-referrer"
                      className="w-12 h-12 rounded-lg object-cover border border-[#E8DFC5] shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-[#2D2B35] truncate">
                        {cand.streetName} · {cand.distanceMeters}m away
                      </div>
                      <div className="text-[11px] text-[#6E6978] truncate">
                        {cand.recommendation === 'likely_same'
                          ? 'Likely Same Pothole'
                          : cand.recommendation === 'uncertain'
                            ? 'Uncertain Match'
                            : 'Close Nearby Defect'}{' '}
                        · {Math.round(cand.confidence * 100)}% confidence · {cand.evidenceCount}{' '}
                        evidence
                      </div>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-semibold text-[#2D2B35] shrink-0">
                    {selected ? 'Selected' : 'Select'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Classification action choice */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {!preselectedPothole && (
            <button
              type="button"
              onClick={() => setActionType('new_pothole')}
              className={`p-3.5 rounded-xl border text-left transition min-h-[44px] ${
                actionType === 'new_pothole'
                  ? 'border-[#4CB729] bg-[#4CB729]/10'
                  : 'border-[#E8DFC5] bg-[#F7F7F8]'
              }`}
            >
              <div className="text-xs font-bold text-[#2D2B35]">Distinct Pothole</div>
              <div className="text-[11px] text-[#6E6978] mt-1">
                Separate physical crater from nearby records.
              </div>
            </button>
          )}

          <button
            type="button"
            disabled={!selectedCandidateId}
            onClick={() => setActionType('add_evidence')}
            className={`p-3.5 rounded-xl border text-left transition min-h-[44px] disabled:opacity-45 ${
              actionType === 'add_evidence'
                ? 'border-[#4CB729] bg-[#4CB729]/10'
                : 'border-[#E8DFC5] bg-[#F7F7F8]'
            }`}
          >
            <div className="text-xs font-bold text-[#2D2B35]">Add Supporting Evidence</div>
            <div className="text-[11px] text-[#6E6978] mt-1">
              Same pothole—adds proof without inflating distinct count.
            </div>
          </button>

          {!preselectedPothole && (
            <button
              type="button"
              onClick={() => setActionType('provisional_review')}
              className={`p-3.5 rounded-xl border text-left transition min-h-[44px] ${
                actionType === 'provisional_review'
                  ? 'border-[#D97706] bg-[#D97706]/10'
                  : 'border-[#E8DFC5] bg-[#F7F7F8]'
              }`}
            >
              <div className="text-xs font-bold text-[#2D2B35]">Hold for Duplicate Review</div>
              <div className="text-[11px] text-[#6E6978] mt-1">
                Uncertain—saved provisionally and excluded from counts until resolved.
              </div>
            </button>
          )}
        </div>

        {/* Optional Gemini Photo Analysis */}
        <div className="pt-3 border-t border-[#E8DFC5] space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-[#4B4646]">
              Optional AI Classification & Visual Comparison (never blocks submission; never infers GPS)
            </div>
            <button
              type="button"
              disabled={!mediaId || analyzingAi}
              onClick={() => void handleOptionalAiCheck()}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-2 disabled:opacity-50"
            >
              {analyzingAi ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 text-[#4CB729]" />
              )}
              <span>Run Optional AI Photo Check</span>
            </button>
          </div>

          {aiResult.status !== 'skipped' && (
            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3.5 space-y-1 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-[#2D2B35]">
                <span>
                  {aiResult.available
                    ? `${aiResult.isRoadDefect ? 'Road Defect Verified' : 'Non-Road Photo Warning'} · Severity: ${aiResult.severityLabel}`
                    : 'AI Check Unavailable (Non-Blocking)'}
                </span>
                {aiResult.model && (
                  <span className="font-mono text-[11px] text-[#6E6978]">{aiResult.model}</span>
                )}
              </div>
              <p className="text-[#4B4646]">{aiResult.summary}</p>
              {aiResult.duplicateReason && (
                <p className="text-[#6E6978]">
                  Visual comparison ({aiResult.duplicateAssessment}): {aiResult.duplicateReason}
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="capture-verification bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4" aria-live="polite">
        <div>
          <span className="page-banner-index">AUTOMATIC PHOTO CHECK</span>
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">We verify every photo for you</h2>
          <p className="text-sm text-[#4B4646] mt-1">
            You only need to take the picture. PatchUp checks whether it shows a pothole before it
            can appear on the community map.
          </p>
        </div>

        {!mediaId ? (
          <div className="capture-check-state">Take or choose a photo to begin automatic verification.</div>
        ) : analyzingAi || aiResult.status === 'skipped' ? (
          <div className="capture-check-state is-processing">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span>Checking your photo…</span>
          </div>
        ) : aiResult.status === 'unavailable' ? (
          <div className="capture-check-state is-warning">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <strong>We couldn’t verify this photo yet.</strong>
              <p>Try the check again before submitting.</p>
            </div>
            <button type="button" onClick={() => void handleOptionalAiCheck()}>Try verification again</button>
          </div>
        ) : aiResult.isRoadDefect ? (
          <div className="capture-check-state is-approved">
            <CheckCircle2 className="w-5 h-5" />
            <div>
              <strong>Pothole confirmed.</strong>
              <p>Your photo is ready to submit.</p>
            </div>
          </div>
        ) : (
          <div className="capture-check-state is-rejected">
            <AlertTriangle className="w-5 h-5" />
            <div>
              <strong>
                Hm, we determined that this photo isn't of a pothole. Make sure you're only
                snapping pictures of potholes!
              </strong>
            </div>
            {!classificationAppealed ? (
              <button
                type="button"
                onClick={() => {
                  setClassificationAppealed(true);
                  setActionType('provisional_review');
                }}
              >
                Did we get this wrong?
              </button>
            ) : (
              <span className="capture-review-queued">This photo will be sent for admin review.</span>
            )}
          </div>
        )}
      </section>

      {/* Step 4: Submit Footer */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-3">
        {submitError && (
          <div className="rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/30 px-4 py-3 text-xs text-[#DC2626]">
            {submitError}
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-[#6E6978]">
            {!mediaId
              ? 'Take or choose a pothole photo to continue.'
              : analyzingAi || aiResult.status === 'skipped'
                ? 'We’re checking whether this photo shows a pothole.'
                : aiResult.status === 'unavailable'
                  ? 'Photo verification must finish before submission.'
                  : !aiResult.isRoadDefect && !classificationAppealed
                    ? 'Use “Did we get this wrong?” to request a manual review.'
              : !coords
                ? 'Waiting for the photo location. You can also open the manual map pin above.'
                : !streetName.trim()
                  ? 'Looking up the street name from the photo location.'
                  : classificationAppealed
                    ? 'Ready to send this photo for admin review.'
                    : 'Your verified pothole is ready to publish.'}
          </div>

          <button
            type="button"
            disabled={!canSubmit || submitting}
            onClick={() => void handleSubmitPothole()}
            className="min-h-[48px] px-6 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition inline-flex items-center justify-center gap-2 disabled:opacity-50 shrink-0"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4" />
            )}
            <span>
              {submitting
                  ? 'Submitting…'
                : submissionActionType === 'add_evidence'
                  ? 'Submit photo evidence'
                  : submissionActionType === 'provisional_review'
                    ? 'Send for review'
                    : 'Publish pothole'}
            </span>
          </button>
        </div>
      </section>

      <CameraCaptureModal
        isOpen={cameraModalOpen}
        onClose={() => setCameraModalOpen(false)}
        onCapture={(file) => void processSelectedFile(file, 'camera')}
        onOpenNativeCamera={() => nativeCameraInputRef.current?.click()}
        onOpenFilePicker={() => fileInputRef.current?.click()}
      />
    </div>
  );
};

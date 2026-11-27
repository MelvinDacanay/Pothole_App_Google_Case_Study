import { ProtectedImage } from '../components/ProtectedImage';
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
  cropPhoto,
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
  source: 'city_centerline' | 'coordinate_fallback';
  inAtlantaMetro: boolean;
}

interface GeminiAnalysisState {
  verificationId?: string;
  mediaId?: string;
  classificationDecision?: 'verified' | 'not_pothole' | 'needs_review' | null;
  available: boolean;
  status: 'completed' | 'unavailable' | 'skipped';
  model?: string;
  isRoadDefect: boolean;
  severityLabel: SeverityLabel;
  confidence: number;
  summary: string;
  duplicateLikelihood?: 'likely_same' | 'uncertain' | 'likely_different' | 'not_compared';
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
  const photoSeqRef=useRef(0),analysisSeqRef=useRef(0),gpsSeqRef=useRef(0);
  const previewRef=useRef<string|null>(null);
  const analysisAbortRef=useRef<AbortController|null>(null);
  const [compressedPhoto, setCompressedPhoto] = useState<CompressedImageResult | null>(null);
  const [privacyChecked,setPrivacyChecked]=useState(false);
  const [cropping,setCropping]=useState(false);
  const [streetSource,setStreetSource]=useState<'city_centerline'|'user_observed'>('user_observed');
  const [confirmedLocation,setConfirmedLocation]=useState('');
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
    isRoadDefect: false,
    severityLabel: 'unclassified',
    confidence: 0,
    summary: '',
  });

  // Step 4: Submit state
  const [submitting, setSubmitting] = useState(false);
  const analysisStarted = useRef<string | null>(null);
  const submissionLock = useRef(false);
  const submittedPayload = useRef<Record<string, unknown> | null>(null);
  const [lookupKey, setLookupKey] = useState('');
  const [lookupError, setLookupError] = useState(false);
  const [lookupRetry, setLookupRetry] = useState(0);
  const coordinateKey = coords ? `${coords.lat},${coords.lng}` : '';
  const withinAtlanta = Boolean(coords && coords.lat >= 33.35 && coords.lat <= 34.2 && coords.lng >= -84.85 && coords.lng <= -84.0);
  const confirmationKey=JSON.stringify([photoSeqRef.current,coordinateKey,streetName.trim(),streetSource]);
  const lookupReady = Boolean(coordinateKey && lookupKey === coordinateKey && !gpsLoading && !geocoding && !searchingCandidates && !lookupError && streetName.trim() && withinAtlanta);
  const locationReady=lookupReady&&confirmedLocation===confirmationKey;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedResult, setSubmittedResult] = useState<{
    potholeId: string;
    submissionId: string;
    duplicateStatus: string;
    coords: { lat: number; lng: number };
  } | null>(null);

  const geocodeSeqRef = useRef(0);
  const candidateSeqRef = useRef(0);

  useEffect(() => {
    loadMapsClientConfig().then(setMapsConfig);
  }, []);

  useEffect(() => {
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      uploadAbortRef.current?.abort(); analysisAbortRef.current?.abort();
      photoSeqRef.current++;analysisSeqRef.current++;
    };
  }, []);

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
        setNeighborhood(data.neighborhood || '');
        setCity(data.city || 'Atlanta');
        setStateCode(data.state || 'GA');
        setPostalCode(data.postalCode || '');
        setPlaceId(data.placeId || '');

        if (forceOverwriteText || !locationUserCorrected) {
          setFormattedAddress(data.formattedAddress || '');
          setStreetName(current=>data.streetName||current);
          if(data.streetName)setStreetSource(data.source==='city_centerline'?'city_centerline':'user_observed');
        }
        return data.streetName || '';
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

        if (!res.ok || !Array.isArray(data.candidates)) throw new Error('Nearby photo lookup failed.');
        const nextCandidates = data.candidates;
        setCandidates(nextCandidates);

        if (preselectedPothole) {
          setActionType('add_evidence');
          setSelectedCandidateId(preselectedPothole.potholeId);
        } else if (nextCandidates.length > 0) {
          const top = nextCandidates[0];
          setSelectedCandidateId(top.potholeId);
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
        return true;
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

  // Resolve an independent street suggestion only when the pin changes.
  useEffect(()=>{
    setConfirmedLocation('');setLookupKey('');setLookupError(false);geocodeSeqRef.current++;candidateSeqRef.current++;
    setGeocoding(false);setSearchingCandidates(false);
    if(!user||!coords)return;
    const timer=window.setTimeout(()=>void runReverseGeocode(coords,true),350);
    return()=>{window.clearTimeout(timer);geocodeSeqRef.current++;};
  },[coordinateKey,user,lookupRetry]);
  // Recheck nearby potholes after street edits; stale results cannot enable publishing.
  useEffect(()=>{
    setConfirmedLocation('');setLookupKey('');setLookupError(false);candidateSeqRef.current++;setSearchingCandidates(false);
    if(!user||!coords||!streetName.trim()||geocoding)return;
    let canceled=false;
    const timer=window.setTimeout(async()=>{const ok=await runCandidateSearch(coords,streetName.trim());if(!canceled){setLookupKey(ok?coordinateKey:'');setLookupError(!ok);}},350);
    return()=>{canceled=true;window.clearTimeout(timer);candidateSeqRef.current++;};
  },[coordinateKey,streetName,geocoding,lookupRetry,user,preselectedPothole]);

  const startUpload = async (compressed: CompressedImageResult, photoSeq=photoSeqRef.current) => {
    if (!user || !privacyChecked) {setUploading(false);return;}
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
        privacyConfirmed:privacyChecked,
        onProgress: setUploadProgress,
        signal: controller.signal,
      });
      if(controller.signal.aborted||photoSeq!==photoSeqRef.current)return;
      setMediaId(nextMediaId);
      setSubmissionId(createDraftSubmissionId());
      setAiResult({
        available: true,
        status: 'skipped',
        isRoadDefect: false,
        severityLabel: 'unclassified',
        confidence: 0,
        summary: '',
      });
    } catch (err) {
      if(photoSeq===photoSeqRef.current&&!controller.signal.aborted) setUploadError(err instanceof Error ? err.message : 'Photo upload failed.');
    } finally {
      if(photoSeq===photoSeqRef.current&&uploadAbortRef.current===controller)setUploading(false);
    }
  };

  const processSelectedFile = async (file: File, source: 'camera' | 'file') => {
    if (submissionLock.current || submittedPayload.current) return;
    const photoSeq=++photoSeqRef.current;
    gpsSeqRef.current++;setPrivacyChecked(false);setConfirmedLocation('');setManualLocationOpen(true);setLookupKey('');setCoords(null);setStreetName('');setFormattedAddress('');setStreetSource('user_observed');
    analysisStarted.current=null; setSubmitError(null);setCompressedPhoto(null);setPreviewUrl(null);setExifCoordsFound(null);if(previewRef.current){URL.revokeObjectURL(previewRef.current);previewRef.current=null;}
    analysisSeqRef.current++;analysisAbortRef.current?.abort();uploadAbortRef.current?.abort();
    setGpsLoading(false);setMediaId(null);setAnalyzingAi(false);setUploading(true);setClassificationAppealed(false);
    setAiResult({available:false,status:'skipped',isRoadDefect:false,severityLabel:'unclassified',confidence:0,summary:''});
    setUploadError(null);
    setSubmittedResult(null);

    try {
      const [compressed, exifGps] = await Promise.all([
        compressImageForUpload(file),
        extractExifGpsFromFile(file),
      ]);

      if(photoSeq!==photoSeqRef.current)return;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      const nextPreview = URL.createObjectURL(compressed.blob);
      previewRef.current=nextPreview;
      setPreviewUrl(nextPreview);
      setCompressedPhoto(compressed);
      setExifCoordsFound(exifGps);
      setClassificationAppealed(false);

      if (exifGps && !preselectedPothole) {
        setCoords(exifGps);
        setCoordinateSource('exif_extracted');
        setAccuracyMeters(undefined);
        setLocationUserCorrected(false);
        setGpsStatusMsg('Loaded genuine GPS coordinates from photograph EXIF metadata.');
      } else if(preselectedPothole){setCoords({lat:preselectedPothole.lat,lng:preselectedPothole.lng});setCoordinateSource('manual_pin');setAccuracyMeters(undefined);setStreetName(preselectedPothole.streetName);setLocationUserCorrected(false);}
      else if(source==='camera'){handleUseCurrentGps();}
      else {setGpsStatusMsg('This photo has no GPS information. Place the pin where the pothole was photographed.');setAccuracyMeters(undefined);setCoordinateSource('manual_pin');}
      setUploading(false);
    } catch (err) {
      if(photoSeq===photoSeqRef.current){setUploadError(err instanceof Error ? err.message : 'Unable to process image.');setUploading(false);}
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
    if(submittedPayload.current || submissionLock.current)return;
    if (!('geolocation' in navigator)) {
      setGpsStatusMsg('Browser geolocation is unavailable here. Tap the map to place a manual pin.');
      return;
    }

    const gpsPhotoSeq = photoSeqRef.current, gpsSeq = ++gpsSeqRef.current;
    setGpsLoading(true);
    setGpsStatusMsg('Requesting one-time browser GPS fix...');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (gpsPhotoSeq !== photoSeqRef.current || gpsSeq !== gpsSeqRef.current || submissionLock.current || submittedPayload.current) return;
        const nextCoords = {
          lat: Number(position.coords.latitude.toFixed(6)),
          lng: Number(position.coords.longitude.toFixed(6)),
        };
        setLookupKey(''); setLookupRetry(n=>n+1);
        setConfirmedLocation('');setStreetName('');setCoords(nextCoords);
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
        if (gpsPhotoSeq !== photoSeqRef.current || gpsSeq !== gpsSeqRef.current) return;
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
    if(submittedPayload.current || submissionLock.current)return;
    gpsSeqRef.current++; setGpsLoading(false);
    setLookupKey('');
    setConfirmedLocation('');setCoords(nextCoords);
    setStreetName(''); setFormattedAddress('');
    setCoordinateSource('manual_pin');
    setAccuracyMeters(undefined);
    setLocationUserCorrected(false);
    setGpsStatusMsg('Pin updated. Check the street name and confirm the location.');
    setLookupRetry(n=>n+1);
  };

  const handleOptionalAiCheck = async () => {
    if (!user?.emailVerified || !mediaId || submissionLock.current || submittedPayload.current) return;
    const id=mediaId, seq=++analysisSeqRef.current;
    analysisAbortRef.current?.abort(); const controller=new AbortController(); analysisAbortRef.current=controller;
    setAnalyzingAi(true);setClassificationAppealed(false);
    setAiResult({available:false,status:'skipped',isRoadDefect:false,severityLabel:'unclassified',confidence:0,summary:''});
    try {
      const token=await user.getIdToken();
      const res=await fetch('/api/potholes/analyze',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({mediaId:id}),signal:controller.signal});
      const data=await res.json() as GeminiAnalysisState;
      if(seq!==analysisSeqRef.current||controller.signal.aborted)return;
      if(!res.ok || data.mediaId!==id || !data.verificationId) throw new Error(data.error||'Unable to verify this photo.');
      setAiResult({...data,isRoadDefect:data.classificationDecision==='verified'});
    }catch(err){
      if(seq!==analysisSeqRef.current||controller.signal.aborted)return;
      setAiResult({available:false,status:'unavailable',isRoadDefect:false,severityLabel:'unclassified',confidence:0,summary:err instanceof Error?err.message:'Unable to verify this photo.'});
    }finally{if(seq===analysisSeqRef.current)setAnalyzingAi(false);}
  };

  useEffect(() => {
    if (!user?.emailVerified || !mediaId || uploading || analysisStarted.current === mediaId) return;
    analysisStarted.current = mediaId;
    void handleOptionalAiCheck();
    // One automatic check per uploaded media ID; retries are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, mediaId, uploading]);

  const topCandidateConfidence = useMemo(() => {
    const match = candidates.find((c) => c.potholeId === selectedCandidateId) ?? candidates[0];
    return match ? match.confidence : 0;
  }, [candidates, selectedCandidateId]);

  const canSubmit = Boolean(
    user &&
      user.emailVerified &&
      mediaId &&
      !uploading && !cameraModalOpen &&
      coords &&
      locationReady &&
      !analyzingAi && aiResult.mediaId===mediaId && aiResult.verificationId &&
      (aiResult.classificationDecision==='verified' || classificationAppealed) &&
      (actionType !== 'add_evidence' || selectedCandidateId)
  );
  const submissionActionType = classificationAppealed ? 'provisional_review' : actionType;

  const handleSubmitPothole = async () => {
    if (!user || !mediaId || !coords || submissionLock.current || (!canSubmit && !submittedPayload.current)) return;
    submissionLock.current=true;
    const seq=photoSeqRef.current;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const token = await user.getIdToken();
      const candidateIds = preselectedPothole
        ? [preselectedPothole.potholeId]
        : candidates.map((c) => c.potholeId);

      const payload = submittedPayload.current ?? {
          submissionId,
          mediaId,
          lat: coords.lat,
          lng: coords.lng,
          coordinateSource,
          locationConfirmed:true,
          streetSource,
          accuracyMeters,
          actionType: submissionActionType,
          targetPotholeId: actionType === 'add_evidence' ? selectedCandidateId : undefined,
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
          verificationId: aiResult.verificationId,
        };
      submittedPayload.current=payload;
      const res = await fetch('/api/potholes/submit', {
        method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Submission failed.');
      }

      if (!data.ok || typeof data.potholeId !== 'string' || data.submissionId !== submissionId || !['distinct','evidence_added','pending_review'].includes(data.duplicateStatus)) throw new Error('Unexpected submission response. Retry saving to confirm.');
      if(seq!==photoSeqRef.current)return;
      setSubmittedResult({
        potholeId: data.potholeId,
        submissionId: data.submissionId,
        duplicateStatus: data.duplicateStatus,
        coords,
      });
    } catch (err) {
      if(seq===photoSeqRef.current)setSubmitError(err instanceof Error ? err.message : 'Unable to save submission.');
    } finally {
      submissionLock.current=false;
      if(seq===photoSeqRef.current)setSubmitting(false);
    }
  };

  useEffect(() => {
    if (canSubmit && !submitting && !submittedResult && !submitError && !submittedPayload.current) void handleSubmitPothole();
    // A failed save is retried explicitly with the same submission ID and payload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, submitting, submittedResult, submitError]);

  const handleResetCapture = () => {
    if(submissionLock.current)return;
    gpsSeqRef.current++;setGpsLoading(false);setLookupKey('');setLookupError(false);
    submittedPayload.current=null; analysisStarted.current=null;
    photoSeqRef.current++;analysisSeqRef.current++;uploadAbortRef.current?.abort();analysisAbortRef.current?.abort();
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current=null;setUploading(false);setAnalyzingAi(false);
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
      isRoadDefect: false,
      severityLabel: 'unclassified',
      confidence: 0,
      summary: '',
    });
    if (preselectedPothole) {
      onClearPreselected();
    }
    setCoords(null);setConfirmedLocation('');setPrivacyChecked(false);
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
      <div className="city-page city-capture capture-success max-w-2xl mx-auto bg-white rounded-2xl border border-[#E8DFC5] p-6 sm:p-8 space-y-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-8 h-8 text-[#4CB729] shrink-0" />
          <div>
            <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
              {submittedResult.duplicateStatus === 'distinct'
                ? 'Photo approved — pothole captured!'
                : submittedResult.duplicateStatus === 'evidence_added'
                  ? 'Photo approved — evidence captured!'
                  : 'Photo sent for manual review'}
            </h1>
            <p className="text-sm text-[#4B4646] mt-1">
              {submittedResult.duplicateStatus === 'distinct'
                ? 'Your photo has been added to your gallery and the community map. It counts as a pothole captured and a new distinct pothole.'
                : submittedResult.duplicateStatus === 'evidence_added'
                  ? 'Your photo has been added to your gallery and counts as a captured photo. It supports an existing pothole without increasing your distinct pothole count.'
                  : 'Your photo is awaiting review on Home. It will not appear in your approved gallery or count as a pothole captured until approved.'}
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
            onClick={() => submittedResult.duplicateStatus==='pending_review'?handleResetCapture():onSubmittedToMap(submittedResult.potholeId, submittedResult.coords)}
            className="min-h-[44px] px-5 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition flex items-center gap-2"
          >
            <MapPin className="w-4 h-4" />
            <span>{submittedResult.duplicateStatus==='pending_review'?'Capture another photo':'View on Atlanta Map'}</span>
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
    );
  }

  return (
    <div className={`city-page city-capture max-w-6xl mx-auto space-y-6 ${manualLocationOpen ? 'manual-location-open' : ''}`}>
      <div className="page-banner page-banner-capture">
        <div>
          <span className="page-banner-index">FIELD TOOL</span>
          <h1>SNAP THE<br /><em>EVIDENCE.</em></h1>
          <p>Take the picture, check for private details and confirm the pin. PatchUp handles verification and publishing.</p>
        </div>
        <Camera className="page-banner-icon" aria-hidden="true" />
      </div>
      {/* Header */}
      <div inert={submitting || Boolean(submittedPayload.current)} className="capture-toolbelt bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
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
            <ProtectedImage
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
      <section inert={submitting || Boolean(submittedPayload.current)} className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
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
          onChange={(e) => void handleFileChange(e, 'file')}
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
                    {uploadError && compressedPhoto && privacyChecked && (
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
                      gpsSeqRef.current++; setGpsLoading(false); setLookupKey(''); setLookupRetry(n=>n+1);
                      setConfirmedLocation('');setStreetName('');setCoords(exifCoordsFound);
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
        {compressedPhoto && !mediaId && !uploading && <div className="rounded-xl border p-4 space-y-3">
          <h3 className="font-bold">Review your photo before uploading</h3>
          <p className="text-sm">Check the preview for faces, license plates, house numbers or other personal details. Crop closer to the pothole or replace the photo if needed.</p>
          <button type="button" disabled={cropping} className="border rounded-lg px-3 py-2" onClick={async()=>{const seq=photoSeqRef.current;setCropping(true);setPrivacyChecked(false);try{const cropped=await cropPhoto(compressedPhoto,.1);if(seq!==photoSeqRef.current)return;if(previewRef.current)URL.revokeObjectURL(previewRef.current);const url=URL.createObjectURL(cropped.blob);previewRef.current=url;setPreviewUrl(url);setCompressedPhoto(cropped);}catch{setUploadError('Could not crop this photo. Retake or replace it.');}finally{setCropping(false);}}}>Crop 10% from each edge</button>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={privacyChecked} onChange={e=>setPrivacyChecked(e.target.checked)}/> I checked this photograph and removed visible personal details.</label>
          <button type="button" disabled={!privacyChecked||cropping} onClick={()=>void startUpload(compressedPhoto)} className="bg-[#2D2B35] text-white rounded-lg px-4 py-3 disabled:opacity-50">Upload and check photo</button>
        </div>}
      </section>

      {/* Step 2: Explicit Location & Pin Verification */}
      <section inert={submitting || Boolean(submittedPayload.current)} className="capture-location-details bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">
              Confirm the pothole location
            </h2>
            <p className="text-xs text-[#6E6978] mt-0.5">
              Check the suggested pin or place one yourself. PatchUp
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
              <span>Use Current GPS (only if at the pothole)</span>
            </button>
            {coords && (
              <button
                type="button"
                onClick={() => { setLookupKey(''); setLocationUserCorrected(false); setLookupRetry(n=>n+1); }}
                disabled={geocoding}
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${geocoding ? 'animate-spin' : ''}`} />
                <span>Refresh street suggestion</span>
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
              Street name from a street sign or your own knowledge {geocoding ? '(Looking up...)' : ''}
            </span>
            <input
              type="text"
              maxLength={128}
              value={streetName}
              disabled={geocoding}
              placeholder="e.g., Peachtree St NE"
              onChange={(e) => {
                setStreetName(e.target.value);setLookupKey('');setStreetSource('user_observed');setConfirmedLocation('');
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
              {geocodeSource === 'city_centerline' ? 'City street data' : 'Street name entered by reporter'}
            </span>
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-[#4B4646]">
            Private hazard notes (optional — no personal information)
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

      {compressedPhoto && !submittedPayload.current && <div className="rounded-xl border p-4 space-y-2">
        <p className="text-sm">{locationReady?'Location confirmed. Approved photos will publish automatically.':'Confirm the pin is at the pothole, not your current location unless you are there.'}</p>
        <button type="button" className="border rounded-lg px-4 py-2" onClick={()=>setManualLocationOpen(true)}>Show or adjust map pin</button>
        <button type="button" disabled={!lookupReady} className="bg-[#2D2B35] text-white rounded-lg px-4 py-2 disabled:opacity-50" onClick={()=>setConfirmedLocation(confirmationKey)}>Confirm pothole location</button>
        {lookupError&&<button type="button" className="underline" onClick={()=>setLookupRetry(n=>n+1)}>Retry nearby photo check</button>}
      </div>}
      {/* Step 3: 25m Duplicate Review & Optional AI Check */}
      <section inert={submitting || Boolean(submittedPayload.current)} className="capture-internal-checks bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-[#2D2B35]">
              3. 25m Duplicate Check & Optional Photo Analysis
            </h2>
            <p className="text-xs text-[#6E6978] mt-0.5">
              Candidates within 25m are reviewed by confidence so separate nearby potholes are never
              blindly merged.
            </p>
          </div>
          {coords && (
            <button
              type="button"
              onClick={() => { setLookupKey(''); setLookupRetry(n=>n+1); }}
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
                    <ProtectedImage
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
                Separate physical pothole from nearby records.
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


      </section>

      <section className="capture-verification bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4" aria-live="polite">
        <div>
          <span className="page-banner-index">PHOTO VERIFICATION</span>
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">Automatic photo check</h2>
          <p className="text-sm text-[#4B4646] mt-1">Gemini examines only the compressed photo, not your notes or location. Keep faces, plates and other personal details out of the frame. Approved photos will be visible to the community.</p>
        </div>
        {!mediaId ? (
          <div className="capture-check-state">{uploading ? 'Uploading your photo…' : 'Take or choose a photo to begin verification.'}</div>
        ) : !user.emailVerified ? (
          <div className="capture-check-state is-warning">Verify your account email before checking your photo.</div>
        ) : analyzingAi || aiResult.status === 'skipped' ? (
          <div className="capture-check-state is-processing"><Loader2 className="w-5 h-5 animate-spin" /><span>Checking your photo…</span></div>
        ) : aiResult.classificationDecision === 'verified' ? (
          <div className="capture-check-state is-approved"><CheckCircle2 className="w-5 h-5 shrink-0" /><div><strong>Photo approved — pothole detected.</strong><p>{aiResult.summary}</p><p>{submitting ? 'Saving your capture…' : actionType === 'provisional_review' ? 'Nearby match needs review before credit can be awarded.' : 'Your photo will be saved automatically once its location and nearby checks are ready.'}</p></div></div>
        ) : (
          <div className={`capture-check-state ${aiResult.status === 'unavailable' || aiResult.classificationDecision === 'needs_review' ? 'is-warning' : 'is-rejected'}`}><AlertTriangle className="w-5 h-5 shrink-0" /><div><strong>{aiResult.status === 'unavailable' ? 'Photo check unavailable' : aiResult.classificationDecision === 'needs_review' ? 'Photo not approved — review required.' : 'Photo not approved — pothole not detected.'}</strong><p>{aiResult.summary}</p>{classificationAppealed && <p>{submitting ? 'Sending for review…' : 'Manual review requested. Waiting for location and nearby checks.'}</p>}</div></div>
        )}
        {mediaId && aiResult.status !== 'skipped' && aiResult.classificationDecision !== 'verified' && !classificationAppealed && !submittedPayload.current && (
          <div className="flex flex-wrap gap-2">
            {aiResult.status === 'unavailable' && <button type="button" disabled={analyzingAi} onClick={()=>void handleOptionalAiCheck()} className="min-h-11 px-4 py-2 border rounded-xl">Retry photo check</button>}
            {aiResult.verificationId && <button type="button" disabled={analyzingAi} onClick={()=>setClassificationAppealed(true)} className="min-h-11 px-4 py-2 border rounded-xl font-semibold">Request Manual Review</button>}
          </div>
        )}
        {mediaId && (aiResult.classificationDecision === 'verified' || classificationAppealed) && !locationReady && !submittedPayload.current && (
          <div className="text-sm space-y-2">
            <p>{!coords ? 'A location is required to save this photo.' : !withinAtlanta ? 'Choose a location within the Atlanta metro area.' : lookupError ? 'Location or nearby checks could not be completed.' : !streetName.trim()?'Enter the street name from a street sign or your own knowledge.':lookupReady?'Confirm the pothole location above.':'Checking location and nearby potholes…'}</p>
            <button type="button" onClick={()=>setManualLocationOpen(true)} className="min-h-11 px-4 py-2 border rounded-xl">Set or correct location</button>
            {coords && lookupError && <button type="button" onClick={()=>{setLookupKey('');setLookupRetry(n=>n+1);}} className="min-h-11 px-4 py-2 border rounded-xl">Retry location checks</button>}
          </div>
        )}
        {submitError && <div role="alert" className="rounded-xl border border-red-300 p-3 text-sm text-red-700"><p>{submitError}</p><button type="button" disabled={submitting} onClick={()=>void handleSubmitPothole()} className="min-h-11 px-4 py-2 border rounded-xl mt-2">Retry saving photo</button><p className="text-xs mt-2">Retry uses the original submission ID to prevent duplicate credit. If you start another capture, check Home for the previous photo first.</p><button type="button" disabled={submitting} onClick={handleResetCapture} className="min-h-11 px-4 py-2 border rounded-xl mt-2">Capture another photo</button></div>}
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

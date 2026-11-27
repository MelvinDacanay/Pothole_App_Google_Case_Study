import { ProtectedImage } from '../components/ProtectedImage';
import React, { useEffect, useMemo, useState } from 'react';
import { Camera, Layers, MapPin, ShieldCheck, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useCommunityPotholes } from '../hooks/usePotholes';
import { useMySubmissions } from '../hooks/usePotholes';
import {
  COORDINATE_SOURCE_LABELS,
  JURISDICTION_LABELS,
  loadMapsClientConfig,
  MapsClientConfig,
  POTHOLE_STATUS_LABELS,
  PotholeRecord,
  PotholeSubmission,
} from '../lib/maps';
import { AtlantaMap } from '../components/AtlantaMap';

type MapFilter = 'all' | 'accepted' | 'repaired';

interface MapViewProps {
  selectedPothole: PotholeRecord | null;
  pendingFocusPotholeId?: string | null;
  onClearPendingFocus?: () => void;
  onSelectPothole: (pothole: PotholeRecord | null) => void;
  onAddEvidence: (pothole: PotholeRecord) => void;
  onStartCapture: () => void;
}

export const MapView: React.FC<MapViewProps> = ({
  selectedPothole,
  pendingFocusPotholeId,
  onClearPendingFocus,
  onSelectPothole,
  onAddEvidence,
  onStartCapture,
}) => {
  const { user } = useAuth();
  const { potholes, loading } = useCommunityPotholes();
  const {submissions}=useMySubmissions(user?.uid??null);

  const [mapsConfig, setMapsConfig] = useState<MapsClientConfig>({
    configured: false,
    apiKey: '',
    mapId: 'DEMO_MAP_ID',
  });
  const [statusFilter, setStatusFilter] = useState<MapFilter>('all');
  const [onlyMine, setOnlyMine] = useState(false);
  const [evidenceItems, setEvidenceItems] = useState<PotholeSubmission[]>([]);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

  useEffect(() => {
    if (!pendingFocusPotholeId || potholes.length === 0) return;
    const match = potholes.find((p) => p.potholeId === pendingFocusPotholeId);
    if (match) {
      onSelectPothole(match);
      onClearPendingFocus?.();
    }
  }, [pendingFocusPotholeId, potholes, onSelectPothole, onClearPendingFocus]);

  useEffect(() => {
    loadMapsClientConfig().then(setMapsConfig);
  }, []);

  useEffect(() => {
    if (!selectedPothole) {
      setEvidenceItems([]);
      return;
    }
    let cancelled = false;
    setLoadingEvidence(true);
    fetch(`/api/potholes/${encodeURIComponent(selectedPothole.potholeId)}/submissions`)
      .then((res) => res.json())
      .then((data: { items?: PotholeSubmission[] }) => {
        if (!cancelled) {
          setEvidenceItems(Array.isArray(data.items) ? data.items : []);
          setLoadingEvidence(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvidenceItems([]);
          setLoadingEvidence(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPothole]);

  const myIds=useMemo(()=>new Set(submissions.filter(s=>['distinct','evidence_added'].includes(s.duplicateStatus)).map(s=>s.potholeId)),[submissions]);

  const filteredPotholes = useMemo(() => {
    return potholes.filter((p) => {
      if (onlyMine && user && !myIds.has(p.potholeId)) return false;
      if (statusFilter === 'all') return true;
      if(statusFilter==='accepted')return ['accepted','reported','acknowledged'].includes(p.status);
      return p.status === statusFilter;
    });
  }, [potholes, statusFilter, onlyMine, myIds, user]);

  const focusCoords = selectedPothole
    ? { lat: selectedPothole.lat, lng: selectedPothole.lng }
    : null;

  return (
    <div className="city-page city-map space-y-5">
      <div className="page-banner page-banner-map">
        <div>
          <span className="page-banner-index">STREET VIEW</span>
          <h1>READ THE<br /><em>ROAD.</em></h1>
          <p>Every pin is a Patcher’s field report. Filter the city, inspect the evidence, find the pattern.</p>
        </div>
        <MapPin className="page-banner-icon" aria-hidden="true" />
      </div>
      {/* Map Header & Filters */}
      <div className="map-toolbelt min-w-0 bg-white rounded-2xl border border-[#E8DFC5] p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-[#2D2B35]">
            Live Atlanta Map
          </h1>
          <p className="text-xs sm:text-sm text-[#6E6978] mt-0.5 tabular-nums">
            {loading
              ? 'Loading live community markers...'
              : `${filteredPotholes.length} community pins · Clustered via Google Maps Platform`}
          </p>
        </div>

        <div className="min-w-0 flex flex-wrap items-center gap-2">
          <div className="scrollbar-none w-full sm:w-auto inline-flex items-center gap-1 p-1 bg-[#F7F7F8] border border-[#E8DFC5] rounded-xl overflow-x-auto">
            {(['all', 'accepted', 'repaired'] as const).map((filterKey) => (
              <button
                key={filterKey}
                type="button"
                onClick={() => setStatusFilter(filterKey)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                  statusFilter === filterKey
                    ? 'bg-white text-[#2D2B35] shadow-xs'
                    : 'text-[#6E6978] hover:text-[#2D2B35]'
                }`}
              >
                {filterKey === 'all'
                  ? 'All'
                  : filterKey === 'accepted'
                    ? 'Accepted'
                    : 'Repaired'}
              </button>
            ))}
          </div>

          {user && (
            <>
              <button
                type="button"
                onClick={() => {
                  setOnlyMine((v) => !v);
                }}
                className={`flex-1 sm:flex-none min-h-[44px] px-3.5 py-2 rounded-xl border text-xs font-semibold transition whitespace-nowrap ${
                  onlyMine
                    ? 'bg-[#2D2B35] border-[#2D2B35] text-white'
                    : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#2D2B35] hover:bg-[#E8DFC5]/40'
                }`}
              >
                My Spots Only
              </button>

            </>
          )}

          <button
            type="button"
            onClick={onStartCapture}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold transition whitespace-nowrap"
          >
            <Camera className="w-4 h-4" />
            <span>Capture Here</span>
          </button>
        </div>
      </div>

      {/* Main Split Map + Detail Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className={selectedPothole ? 'lg:col-span-8' : 'lg:col-span-12'}>
          <AtlantaMap
            mapsConfig={mapsConfig}
            potholes={filteredPotholes}
            selectedPotholeId={selectedPothole?.potholeId ?? null}
            onSelectPothole={onSelectPothole}
            focusCoords={focusCoords}
          />
        </div>

        {selectedPothole && (
          <aside className="lg:col-span-4 bg-white rounded-2xl border border-[#E8DFC5] p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-[#6E6978]">
                  {POTHOLE_STATUS_LABELS[selectedPothole.status] ?? selectedPothole.status} ·{' '}
                  {COORDINATE_SOURCE_LABELS[selectedPothole.coordinateSource]}
                </div>
                <h2 className="font-display text-lg font-bold text-[#2D2B35] mt-0.5 break-words">
                  {selectedPothole.streetName}
                </h2>
                <p className="text-xs text-[#4B4646] mt-0.5">{selectedPothole.formattedAddress}</p>
              </div>
              <button
                type="button"
                onClick={() => onSelectPothole(null)}
                aria-label="Close pothole details"
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl hover:bg-[#F7F7F8] text-[#6E6978]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="rounded-xl overflow-hidden border border-[#E8DFC5] bg-[#F7F7F8] aspect-video flex items-center justify-center">
              <ProtectedImage publicPhoto
                src={selectedPothole.primaryPhotoUrl}
                alt={`Pothole at ${selectedPothole.streetName}`}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 p-3">
                <div className="text-[#6E6978]">Evidence Reports</div>
                <div className="font-mono text-lg font-bold text-[#2D2B35] tabular-nums mt-0.5">
                  {selectedPothole.evidenceCount}
                </div>
              </div>
              <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/70 p-3">
                <div className="text-[#6E6978]">Severity</div>
                <div className="font-semibold text-[#2D2B35] capitalize mt-1">
                  {selectedPothole.severityLabel}
                </div>
              </div>
            </div>

            <div className="space-y-1.5 text-xs text-[#4B4646]">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-[#4CB729] shrink-0" />
                <span>{JURISDICTION_LABELS[selectedPothole.jurisdiction]}</span>
              </div>
              <div className="flex items-center gap-2 font-mono text-[11px] text-[#6E6978] tabular-nums">
                <MapPin className="w-4 h-4 shrink-0" />
                <span>
                  {selectedPothole.lat.toFixed(5)}, {selectedPothole.lng.toFixed(5)}
                </span>
              </div>
              <div className="text-[#6E6978]">
                Primary Patcher:{' '}
                <span className="font-mono text-[#2D2B35]">
                  @{selectedPothole.primaryContributorUsername}
                </span>
              </div>
            </div>

            {selectedPothole.aiReviewSummary && (
              <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3 text-xs text-[#4B4646]">
                <span className="font-semibold text-[#2D2B35]">Optional AI Check: </span>
                {selectedPothole.aiReviewSummary}
              </div>
            )}

            <button
              type="button"
              onClick={() => onAddEvidence(selectedPothole)}
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-sm font-semibold transition flex items-center justify-center gap-2"
            >
              <Layers className="w-4 h-4" />
              <span>Add Evidence Photo to This Spot</span>
            </button>

            <div className="pt-3 border-t border-[#E8DFC5] space-y-2">
              <div className="text-xs font-semibold text-[#2D2B35]">
                Verified Evidence History ({evidenceItems.length})
              </div>
              {loadingEvidence ? (
                <div className="text-xs text-[#6E6978]">Loading evidence...</div>
              ) : evidenceItems.length === 0 ? (
                <div className="text-xs text-[#6E6978]">Primary submission recorded.</div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {evidenceItems.map((sub) => (
                    <div
                      key={sub.submissionId}
                      className="flex items-center gap-2.5 p-2 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5]/60"
                    >
                      <ProtectedImage publicPhoto
                        src={sub.photoUrl}
                        alt={`Evidence by ${sub.username}`}
                        referrerPolicy="no-referrer"
                        className="w-10 h-10 rounded-lg object-cover shrink-0 border border-[#E8DFC5]"
                      />
                      <div className="min-w-0 text-xs">
                        <div className="font-semibold text-[#2D2B35] truncate">
                          @{sub.username} ·{' '}
                          {sub.duplicateStatus === 'distinct' ? 'Initial Spot' : 'Evidence'}
                        </div>
                        <div className="text-[11px] text-[#6E6978] truncate">
                          {COORDINATE_SOURCE_LABELS[sub.coordinateSource]}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Scrollable Street Directory Below Map (helps accessibility & no-JS/no-key inspection) */}
      {filteredPotholes.length > 0 && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 space-y-3">
          <h2 className="font-display text-base font-bold text-[#2D2B35]">
            Filtered Atlanta Records ({filteredPotholes.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredPotholes.slice(0, 12).map((p) => (
              <button
                key={p.potholeId}
                type="button"
                onClick={() => onSelectPothole(p)}
                className={`flex items-center gap-3 p-3 rounded-xl border text-left transition min-h-[64px] ${
                  selectedPothole?.potholeId === p.potholeId
                    ? 'border-[#4CB729] bg-[#4CB729]/5'
                    : 'border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/30'
                }`}
              >
                <ProtectedImage publicPhoto
                  src={p.primaryPhotoUrl}
                  alt={p.streetName}
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 rounded-lg object-cover border border-[#E8DFC5] shrink-0"
                />
                <div className="min-w-0">
                  <div className="text-xs font-bold text-[#2D2B35] truncate">{p.streetName}</div>
                  <div className="text-[11px] text-[#6E6978] truncate">
                    {POTHOLE_STATUS_LABELS[p.status] ?? p.status} · {p.evidenceCount} evidence
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};

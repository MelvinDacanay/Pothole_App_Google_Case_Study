import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  InfoWindow,
  Map as GoogleMap,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { MarkerClusterer, type Marker as ClusterMarker } from '@googlemaps/markerclusterer';
import { AlertTriangle, Crosshair, MapPin } from 'lucide-react';
import { createPotholePin } from '../lib/potholePin';
import {
  ATLANTA_CENTER,
  COORDINATE_SOURCE_LABELS,
  dispatchMapsQuotaWarning,
  MapsClientConfig,
  PotholeRecord,
} from '../lib/maps';

interface AtlantaMapProps {
  mapsConfig: MapsClientConfig;
  potholes: PotholeRecord[];
  selectedPotholeId: string | null;
  onSelectPothole: (pothole: PotholeRecord | null) => void;
  focusCoords?: { lat: number; lng: number } | null;
}

function createPinElement(pothole: PotholeRecord, isSelected: boolean): HTMLDivElement {
  return createPotholePin(
    `${pothole.streetName}, ${pothole.evidenceCount} evidence`,
    isSelected
  );
}

const ClusteredPotholeMarkers: React.FC<{
  potholes: PotholeRecord[];
  selectedPotholeId: string | null;
  onSelectPothole: (pothole: PotholeRecord | null) => void;
  focusCoords?: { lat: number; lng: number } | null;
}> = ({ potholes, selectedPotholeId, onSelectPothole, focusCoords }) => {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');
  const loadingStatus = useApiLoadingStatus();

  const [markerLookup, setMarkerLookup] = useState<
    Record<string, google.maps.marker.AdvancedMarkerElement>
  >({});
  const clustererRef = useRef<MarkerClusterer | null>(null);

  useEffect(() => {
    if (loadingStatus === APILoadingStatus.AUTH_FAILURE) {
      dispatchMapsQuotaWarning();
    }
  }, [loadingStatus]);

  useEffect(() => {
    if (!map || !focusCoords) return;
    map.panTo(focusCoords);
    if ((map.getZoom() ?? 12) < 15) {
      map.setZoom(15);
    }
  }, [map, focusCoords]);

  useEffect(() => {
    if (!map) return;
    const clusterer = new MarkerClusterer({ map });
    clustererRef.current = clusterer;
    return () => {
      clusterer.clearMarkers();
      clusterer.setMap(null);
      clustererRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (!map || !markerLib || !clustererRef.current) return;

    const clusterer = clustererRef.current;
    clusterer.clearMarkers();

    const nextLookup: Record<string, google.maps.marker.AdvancedMarkerElement> = {};
    const createdMarkers: ClusterMarker[] = [];

    for (const pothole of potholes) {
      const isSelected = pothole.potholeId === selectedPotholeId;
      const pinContent = createPinElement(pothole, isSelected);
      const marker = new markerLib.AdvancedMarkerElement({
        position: { lat: pothole.lat, lng: pothole.lng },
        title: pothole.formattedAddress || pothole.streetName,
        content: pinContent,
        // This artwork is a ground-level crater, not a bottom-pointed pin.
        anchorLeft: '-50%',
        anchorTop: '-50%',
        zIndex: isSelected ? 100 : 1,
      });

      marker.addListener('click', () => {
        onSelectPothole(pothole);
      });

      nextLookup[pothole.potholeId] = marker;
      createdMarkers.push(marker as unknown as ClusterMarker);
    }

    clusterer.addMarkers(createdMarkers);
    setMarkerLookup(nextLookup);

    return () => {
      clusterer.clearMarkers();
      for (const marker of Object.values(nextLookup)) {
        google.maps.event.clearInstanceListeners(marker);
        marker.map = null;
      }
    };
  }, [map, markerLib, potholes, selectedPotholeId, onSelectPothole]);

  const selectedPothole = useMemo(
    () => potholes.find((p) => p.potholeId === selectedPotholeId) ?? null,
    [potholes, selectedPotholeId]
  );

  const selectedAnchor = selectedPothole ? markerLookup[selectedPothole.potholeId] : undefined;

  if (!selectedPothole || !selectedAnchor) return null;

  return (
    <InfoWindow anchor={selectedAnchor} maxWidth={260} onCloseClick={() => onSelectPothole(null)}>
      <div className="p-1 space-y-1.5 text-[#2D2B35]">
        <div className="text-xs font-bold leading-snug">{selectedPothole.streetName}</div>
        <div className="text-[11px] text-[#6E6978]">
          {COORDINATE_SOURCE_LABELS[selectedPothole.coordinateSource]}
        </div>
        <div className="text-[11px] font-mono text-[#4B4646] tabular-nums">
          {selectedPothole.evidenceCount} evidence · @{selectedPothole.primaryContributorUsername}
        </div>
      </div>
    </InfoWindow>
  );
};

export const AtlantaMap: React.FC<AtlantaMapProps> = ({
  mapsConfig,
  potholes,
  selectedPotholeId,
  onSelectPothole,
  focusCoords,
}) => {
  const [userCenter, setUserCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState<string | null>(null);

  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationMessage('Geolocation is unavailable in this browser.');
      return;
    }
    setLocating(true);
    setLocationMessage(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocationMessage(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission declined; map remains centered on Atlanta.'
            : 'Unable to determine current GPS location.'
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
    );
  }, []);

  if (!mapsConfig.configured || !mapsConfig.apiKey) {
    return (
      <div className="h-[48dvh] min-h-[300px] sm:h-[52dvh] sm:min-h-[360px] rounded-2xl bg-[#F7F7F8] border border-[#E8DFC5] p-4 sm:p-6 flex flex-col items-center justify-center text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-[#D97706]" />
        <h3 className="font-display text-lg font-bold text-[#2D2B35]">
          Google Maps Platform Key Pending
        </h3>
        <p className="text-sm text-[#4B4646] max-w-md">
          The interactive Atlanta map requires a configured Google Maps JavaScript API key. You can
          still browse the live pothole list below.
        </p>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl overflow-hidden border border-[#E8DFC5] bg-[#F7F7F8]">
      <div className="h-[50dvh] min-h-[320px] sm:h-[56dvh] sm:min-h-[380px] lg:h-[600px] w-full">
        <APIProvider apiKey={mapsConfig.apiKey} language="en" region="US" libraries={['marker']}>
          <GoogleMap
            mapId={mapsConfig.mapId || 'DEMO_MAP_ID'}
            defaultCenter={ATLANTA_CENTER}
            defaultZoom={12}
            gestureHandling="greedy"
            streetViewControl={false}
            mapTypeControl={false}
            fullscreenControl={true}
            internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
            style={{ width: '100%', height: '100%' }}
            onClick={() => onSelectPothole(null)}
          >
            <ClusteredPotholeMarkers
              potholes={potholes}
              selectedPotholeId={selectedPotholeId}
              onSelectPothole={onSelectPothole}
              focusCoords={focusCoords ?? userCenter}
            />
          </GoogleMap>
        </APIProvider>
      </div>

      {/* On-demand Locate Me button */}
      <div className="absolute top-3 left-3 flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={handleLocateMe}
          disabled={locating}
          className="inline-flex items-center gap-2 min-h-[44px] px-3 sm:px-3.5 py-2 rounded-xl bg-white/95 hover:bg-white border border-[#E8DFC5] shadow-sm text-xs font-semibold text-[#2D2B35] whitespace-nowrap"
        >
          <Crosshair className="w-4 h-4 text-[#4CB729]" />
          <span>{locating ? 'Locating...' : 'Center Near Me'}</span>
        </button>
        {locationMessage && (
          <div className="rounded-xl bg-white/95 border border-[#E8DFC5] px-3 py-1.5 text-[11px] text-[#4B4646] shadow-xs max-w-xs">
            {locationMessage}
          </div>
        )}
      </div>

      {/* Empty overlay notice only when 0 potholes exist */}
      {potholes.length === 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 right-3 sm:right-auto sm:max-w-sm rounded-xl bg-white/95 backdrop-blur-sm border border-[#E8DFC5] px-4 py-3 shadow-sm flex items-center gap-3">
          <MapPin className="w-5 h-5 text-[#4CB729] shrink-0" />
          <div className="text-xs text-[#3A3535]">
            <span className="font-semibold">Live Atlanta Map Ready.</span> Submit the first
            community pothole to place an interactive marker.
          </div>
        </div>
      )}
    </div>
  );
};

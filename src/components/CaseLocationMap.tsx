import React, { useEffect, useRef } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  Map as GoogleMap,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { ExternalLink, MapPin } from 'lucide-react';
import { dispatchMapsQuotaWarning, MapsClientConfig } from '../lib/maps';

interface CaseLocationMapProps {
  mapsConfig: MapsClientConfig;
  coords: { lat: number; lng: number };
  label?: string;
}

const StaticMarker: React.FC<{ coords: { lat: number; lng: number }; label?: string }> = ({
  coords,
  label,
}) => {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');
  const loadingStatus = useApiLoadingStatus();
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);

  useEffect(() => {
    if (loadingStatus === APILoadingStatus.AUTH_FAILURE) dispatchMapsQuotaWarning();
  }, [loadingStatus]);

  useEffect(() => {
    if (!map || !markerLib) return;
    const badge = document.createElement('div');
    badge.style.width = '28px';
    badge.style.height = '28px';
    badge.style.borderRadius = '9999px';
    badge.style.backgroundColor = '#4CB729';
    badge.style.border = '2px solid #2D2B35';
    badge.style.boxShadow = '0 2px 6px rgba(0,0,0,0.28)';
    const marker = new markerLib.AdvancedMarkerElement({
      map,
      position: coords,
      title: label || 'Pothole location',
      content: badge,
    });
    markerRef.current = marker;
    return () => {
      marker.map = null;
      markerRef.current = null;
    };
  }, [map, markerLib, coords, label]);

  return null;
};

/** Read-only, non-draggable location map for a single case. */
export const CaseLocationMap: React.FC<CaseLocationMapProps> = ({ mapsConfig, coords, label }) => {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${coords.lat.toFixed(
    6
  )},${coords.lng.toFixed(6)}`;

  if (!mapsConfig.configured || !mapsConfig.apiKey) {
    return (
      <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-center space-y-2">
        <MapPin className="w-6 h-6 text-[#6E6978] mx-auto" />
        <div className="font-mono text-xs text-[#2D2B35] tabular-nums">
          {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
        </div>
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-[#4CB729] hover:underline"
        >
          Open in Google Maps <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden border border-[#E8DFC5] h-48">
      <APIProvider apiKey={mapsConfig.apiKey}>
        <GoogleMap
          mapId={mapsConfig.mapId}
          defaultCenter={coords}
          defaultZoom={16}
          gestureHandling="cooperative"
          disableDefaultUI
          className="w-full h-full"
        >
          <StaticMarker coords={coords} label={label} />
        </GoogleMap>
      </APIProvider>
    </div>
  );
};

import React, { useEffect, useRef } from 'react';
import {
  APILoadingStatus,
  APIProvider,
  Map as GoogleMap,
  MapMouseEvent,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import { MapPin } from 'lucide-react';
import { ATLANTA_CENTER, dispatchMapsQuotaWarning, MapsClientConfig } from '../lib/maps';
import { createPotholePin } from '../lib/potholePin';

interface PinPickerMapProps {
  mapsConfig: MapsClientConfig;
  coords: { lat: number; lng: number } | null;
  onChangeCoords: (next: { lat: number; lng: number }) => void;
}

const DraggablePinController: React.FC<{
  coords: { lat: number; lng: number };
  onChangeCoords: (next: { lat: number; lng: number }) => void;
}> = ({ coords, onChangeCoords }) => {
  const map = useMap();
  const markerLib = useMapsLibrary('marker');
  const loadingStatus = useApiLoadingStatus();
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);

  useEffect(() => {
    if (loadingStatus === APILoadingStatus.AUTH_FAILURE) {
      dispatchMapsQuotaWarning();
    }
  }, [loadingStatus]);

  useEffect(() => {
    if (!map || !markerLib) return;

    const pinBadge = createPotholePin('Drag to refine pothole location');

    const marker = new markerLib.AdvancedMarkerElement({
      map,
      position: coords,
      gmpDraggable: true,
      title: 'Drag or tap map to refine pothole location',
      content: pinBadge,
      anchorLeft: '-50%',
      anchorTop: '-50%',
    });

    marker.addListener('dragend', () => {
      const pos = marker.position;
      if (!pos) return;
      const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat;
      const lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
      if (typeof lat === 'number' && typeof lng === 'number') {
        onChangeCoords({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) });
      }
    });

    markerRef.current = marker;

    return () => {
      google.maps.event.clearInstanceListeners(marker);
      marker.map = null;
      markerRef.current = null;
    };
    // Initialize marker instance once when map & marker library load; position synced separately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, markerLib]);

  useEffect(() => {
    if (markerRef.current) {
      markerRef.current.position = coords;
    }
    if (map) {
      map.panTo(coords);
    }
  }, [map, coords]);

  return null;
};

export const PinPickerMap: React.FC<PinPickerMapProps> = ({
  mapsConfig,
  coords,
  onChangeCoords,
}) => {
  const activeCoords = coords ?? ATLANTA_CENTER;

  const handleMapClick = (ev: MapMouseEvent) => {
    const latLng = ev.detail.latLng;
    if (!latLng) return;
    onChangeCoords({
      lat: Number(latLng.lat.toFixed(6)),
      lng: Number(latLng.lng.toFixed(6)),
    });
  };

  if (!mapsConfig.configured || !mapsConfig.apiKey) {
    return (
      <div className="h-56 rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-4 flex flex-col items-center justify-center text-center space-y-2">
        <MapPin className="w-6 h-6 text-[#D97706]" />
        <p className="text-xs text-[#4B4646] max-w-sm">
          Interactive pin map unavailable without a Maps key. Enter or refine coordinates manually
          below.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl overflow-hidden border border-[#E8DFC5] bg-[#F7F7F8]">
      <div className="h-64 sm:h-72 w-full">
        <APIProvider apiKey={mapsConfig.apiKey} language="en" region="US" libraries={['marker']}>
          <GoogleMap
            mapId={mapsConfig.mapId || 'DEMO_MAP_ID'}
            defaultCenter={activeCoords}
            defaultZoom={coords ? 17 : 12}
            gestureHandling="greedy"
            streetViewControl={false}
            mapTypeControl={false}
            internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
            style={{ width: '100%', height: '100%' }}
            onClick={handleMapClick}
          >
            <DraggablePinController coords={activeCoords} onChangeCoords={onChangeCoords} />
          </GoogleMap>
        </APIProvider>
      </div>
      <div className="px-3.5 py-2 bg-[#F7F7F8] border-t border-[#E8DFC5] text-[11px] text-[#6E6978] flex items-center justify-between gap-2">
        <span>Tap anywhere on the map or drag the pothole pin to align the exact pothole.</span>
        <span className="font-mono tabular-nums shrink-0">
          {activeCoords.lat.toFixed(5)}, {activeCoords.lng.toFixed(5)}
        </span>
      </div>
    </div>
  );
};

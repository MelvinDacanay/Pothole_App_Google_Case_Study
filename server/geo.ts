import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';

export type JurisdictionType = 'atldot' | 'gdot' | 'unknown';
export type DuplicateRecommendation = 'likely_same' | 'uncertain' | 'distinct_nearby';

export interface ReverseGeocodeResult {
  formattedAddress: string;
  streetName: string;
  normalizedStreet: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  placeId: string;
  jurisdiction: JurisdictionType;
  source: 'google_geocoding_v4' | 'google_geocoding_v3' | 'coordinate_fallback';
  cached: boolean;
}

export interface DuplicateCandidateSummary {
  potholeId: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  confidence: number;
  recommendation: DuplicateRecommendation;
  formattedAddress: string;
  streetName: string;
  normalizedStreet: string;
  primaryPhotoUrl: string;
  primaryMediaId: string;
  status: string;
  severityLabel: string;
  evidenceCount: number;
}

export class MapsQuotaError extends Error {
  isQuotaExceeded: boolean;
  constructor(message: string) {
    super(message);
    this.isQuotaExceeded = true;
  }
}

const EARTH_RADIUS_METERS = 6371000;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function isValidCoordinatePair(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export function isWithinAtlantaMetro(lat: number, lng: number): boolean {
  return lat >= 33.35 && lat <= 34.2 && lng >= -84.85 && lng <= -84.0;
}

const STREET_TOKEN_MAP: Record<string, string> = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  northeast: 'ne',
  northwest: 'nw',
  southeast: 'se',
  southwest: 'sw',
  street: 'st',
  str: 'st',
  avenue: 'ave',
  boulevard: 'blvd',
  road: 'rd',
  drive: 'dr',
  parkway: 'pkwy',
  highway: 'hwy',
  lane: 'ln',
  court: 'ct',
  place: 'pl',
  circle: 'cir',
  terrace: 'ter',
  trail: 'trl',
  way: 'way',
  expressway: 'expy',
};

export function normalizeStreetName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/^\d+[a-z]?\s+/, '') // strip leading building number if present
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  return cleaned
    .split(' ')
    .map((tok) => STREET_TOKEN_MAP[tok] ?? tok)
    .join(' ')
    .slice(0, 128);
}

export function classifyJurisdiction(
  streetName: string,
  formattedAddress: string,
  city: string
): JurisdictionType {
  const combined = `${streetName} ${formattedAddress}`.trim();
  if (
    /\b(i-?\s?(20|75|85|285)|interstate\s+\d+|ga-?\s?\d+|sr-?\s?\d+|state\s+route\s+\d+|us-?\s?\d+)\b/i.test(
      combined
    )
  ) {
    return 'gdot';
  }
  if (city.trim().toLowerCase() === 'atlanta') {
    return 'atldot';
  }
  return 'unknown';
}

export function scoreDuplicateCandidate(params: {
  targetLat: number;
  targetLng: number;
  targetNormalizedStreet: string;
  candidate: {
    potholeId: string;
    lat: number;
    lng: number;
    formattedAddress: string;
    streetName: string;
    normalizedStreet: string;
    primaryPhotoUrl: string;
    primaryMediaId: string;
    status: string;
    severityLabel: string;
    evidenceCount: number;
    updatedAtMs?: number;
  };
}): DuplicateCandidateSummary {
  const distanceMeters = haversineMeters(
    params.targetLat,
    params.targetLng,
    params.candidate.lat,
    params.candidate.lng
  );

  let score = 0;
  if (distanceMeters <= 4) {
    score += 0.62;
  } else if (distanceMeters <= 10) {
    score += 0.48;
  } else if (distanceMeters <= 18) {
    score += 0.32;
  } else if (distanceMeters <= 25) {
    score += 0.18;
  } else {
    score += 0.05;
  }

  if (
    params.targetNormalizedStreet &&
    params.candidate.normalizedStreet &&
    params.targetNormalizedStreet === params.candidate.normalizedStreet
  ) {
    score += 0.22;
  }

  const nowMs = Date.now();
  const ageDays = params.candidate.updatedAtMs
    ? (nowMs - params.candidate.updatedAtMs) / (1000 * 60 * 60 * 24)
    : 30;
  if (params.candidate.status !== 'repaired' && ageDays <= 45) {
    score += 0.1;
  }

  const confidence = Math.min(0.99, Math.max(0.05, Number(score.toFixed(2))));

  let recommendation: DuplicateRecommendation = 'distinct_nearby';
  if (confidence >= 0.72) {
    recommendation = 'likely_same';
  } else if (confidence >= 0.4) {
    recommendation = 'uncertain';
  }

  return {
    potholeId: params.candidate.potholeId,
    lat: params.candidate.lat,
    lng: params.candidate.lng,
    distanceMeters: Number(distanceMeters.toFixed(1)),
    confidence,
    recommendation,
    formattedAddress: params.candidate.formattedAddress,
    streetName: params.candidate.streetName,
    normalizedStreet: params.candidate.normalizedStreet,
    primaryPhotoUrl: params.candidate.primaryPhotoUrl,
    primaryMediaId: params.candidate.primaryMediaId,
    status: params.candidate.status,
    severityLabel: params.candidate.severityLabel,
    evidenceCount: params.candidate.evidenceCount,
  };
}

interface GeocodeV4Component {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface GeocodeV4Response {
  results?: Array<{
    placeId?: string;
    formattedAddress?: string;
    addressComponents?: GeocodeV4Component[];
    types?: string[];
  }>;
  error?: {
    status?: string;
    message?: string;
  };
}

interface GeocodeV3Component {
  long_name?: string;
  short_name?: string;
  types?: string[];
}

interface GeocodeV3Response {
  status?: string;
  error_message?: string;
  results?: Array<{
    place_id?: string;
    formatted_address?: string;
    address_components?: GeocodeV3Component[];
  }>;
}

function extractAddressParts(
  components: Array<{ longText: string; shortText: string; types: string[] }>,
  formattedAddress: string,
  placeId: string,
  source: 'google_geocoding_v4' | 'google_geocoding_v3'
): ReverseGeocodeResult {
  const findComp = (targetType: string) =>
    components.find((c) => c.types.includes(targetType));

  const route = findComp('route')?.longText || '';
  const streetNumber = findComp('street_number')?.longText || '';
  const neighborhood =
    findComp('neighborhood')?.longText ||
    findComp('sublocality_level_1')?.longText ||
    '';
  const city =
    findComp('locality')?.longText ||
    findComp('sublocality')?.longText ||
    'Atlanta';
  const state = findComp('administrative_area_level_1')?.shortText || 'GA';
  const postalCode = findComp('postal_code')?.longText || '';

  const fallbackStreet =
    route ||
    formattedAddress.split(',')[0]?.trim() ||
    (streetNumber ? `${streetNumber} Atlanta Rd` : 'Unverified Street');

  const normalizedStreet = normalizeStreetName(fallbackStreet) || 'unverified street';
  const jurisdiction = classifyJurisdiction(fallbackStreet, formattedAddress, city);

  return {
    formattedAddress: formattedAddress.slice(0, 256),
    streetName: fallbackStreet.slice(0, 128),
    normalizedStreet,
    neighborhood: neighborhood.slice(0, 128),
    city: city.slice(0, 64),
    state: state.slice(0, 32),
    postalCode: postalCode.slice(0, 20),
    placeId: placeId.slice(0, 128),
    jurisdiction,
    source,
    cached: false,
  };
}

export async function reverseGeocodeCoords(params: {
  lat: number;
  lng: number;
  apiKey: string;
  firestoreDb: Firestore | null;
}): Promise<ReverseGeocodeResult> {
  const { lat, lng, apiKey, firestoreDb } = params;
  const coordKey = `${lat.toFixed(5)}_${lng.toFixed(5)}`;

  // 1. Check 29-day Firestore geocodeCache first to avoid redundant API calls
  if (firestoreDb) {
    try {
      const cacheSnap = await firestoreDb.collection('geocodeCache').doc(coordKey).get();
      if (cacheSnap.exists) {
        const data = cacheSnap.data();
        const expiresAt = data?.expiresAt as Timestamp | undefined;
        if (data && expiresAt && expiresAt.toMillis() > Date.now()) {
          return {
            formattedAddress: String(data.formattedAddress || ''),
            streetName: String(data.streetName || ''),
            normalizedStreet: String(data.normalizedStreet || ''),
            neighborhood: String(data.neighborhood || ''),
            city: String(data.city || 'Atlanta'),
            state: String(data.state || 'GA'),
            postalCode: String(data.postalCode || ''),
            placeId: String(data.placeId || ''),
            jurisdiction: (data.jurisdiction as JurisdictionType) || 'unknown',
            source: (data.source as ReverseGeocodeResult['source']) || 'google_geocoding_v4',
            cached: true,
          };
        }
      }
    } catch {
      // Cache lookup failures should not block geocoding
    }
  }

  if (!apiKey) {
    return buildFallbackGeocode(lat, lng);
  }

  let result: ReverseGeocodeResult | null = null;

  // 2. Primary: Geocoding API v4 REST endpoint
  try {
    const v4Url = new URL('https://geocode.googleapis.com/v4/geocode/location');
    v4Url.searchParams.append('location.latitude', String(lat));
    v4Url.searchParams.append('location.longitude', String(lng));
    v4Url.searchParams.append('languageCode', 'en');

    const v4Res = await fetch(v4Url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'results.placeId,results.formattedAddress,results.addressComponents,results.types',
        'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
      },
    });

    const v4Json = (await v4Res.json()) as GeocodeV4Response;
    if (v4Res.status === 429 || v4Json.error?.status === 'RESOURCE_EXHAUSTED') {
      throw new MapsQuotaError('Google Maps Geocoding API quota exceeded.');
    }

    if (v4Res.ok && Array.isArray(v4Json.results) && v4Json.results.length > 0) {
      const top = v4Json.results[0];
      const normalizedComps = (top.addressComponents || []).map((c) => ({
        longText: c.longText || '',
        shortText: c.shortText || '',
        types: c.types || [],
      }));
      result = extractAddressParts(
        normalizedComps,
        top.formattedAddress || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        top.placeId || '',
        'google_geocoding_v4'
      );
    }
  } catch (err) {
    if (err instanceof MapsQuotaError) throw err;
  }

  // 3. Fallback: Geocoding API v3 JSON REST endpoint
  if (!result) {
    try {
      const v3Url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      v3Url.searchParams.append('latlng', `${lat},${lng}`);
      v3Url.searchParams.append('key', apiKey);

      const v3Res = await fetch(v3Url.toString());
      const v3Json = (await v3Res.json()) as GeocodeV3Response;
      if (v3Res.status === 429 || v3Json.status === 'OVER_QUERY_LIMIT') {
        throw new MapsQuotaError('Google Maps Geocoding API quota exceeded.');
      }

      if (v3Res.ok && v3Json.status === 'OK' && Array.isArray(v3Json.results) && v3Json.results.length > 0) {
        const top = v3Json.results[0];
        const normalizedComps = (top.address_components || []).map((c) => ({
          longText: c.long_name || '',
          shortText: c.short_name || '',
          types: c.types || [],
        }));
        result = extractAddressParts(
          normalizedComps,
          top.formatted_address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
          top.place_id || '',
          'google_geocoding_v3'
        );
      }
    } catch (err) {
      if (err instanceof MapsQuotaError) throw err;
    }
  }

  if (!result) {
    return buildFallbackGeocode(lat, lng);
  }

  // Cache for 29 days (strictly < 30-day ToS cache limit)
  if (firestoreDb) {
    try {
      const expiresAt = Timestamp.fromMillis(Date.now() + 29 * 24 * 60 * 60 * 1000);
      await firestoreDb.collection('geocodeCache').doc(coordKey).set({
        coordKey,
        formattedAddress: result.formattedAddress,
        streetName: result.streetName,
        normalizedStreet: result.normalizedStreet,
        neighborhood: result.neighborhood,
        city: result.city,
        state: result.state,
        postalCode: result.postalCode,
        placeId: result.placeId,
        jurisdiction: result.jurisdiction,
        source: result.source,
        expiresAt,
      });
    } catch {
      // Non-fatal cache write error
    }
  }

  return result;
}

function buildFallbackGeocode(lat: number, lng: number): ReverseGeocodeResult {
  const label = `Near ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  return {
    formattedAddress: `${label}, Atlanta, GA`,
    streetName: label,
    normalizedStreet: 'coordinate pin',
    neighborhood: '',
    city: 'Atlanta',
    state: 'GA',
    postalCode: '',
    placeId: '',
    jurisdiction: 'unknown',
    source: 'coordinate_fallback',
    cached: false,
  };
}

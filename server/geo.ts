export type JurisdictionType = 'atldot' | 'gdot' | 'unknown';
export type DuplicateRecommendation = 'likely_same' | 'uncertain' | 'distinct_nearby';

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

import type { Firestore } from 'firebase-admin/firestore';
import { normalizeStreetName, isWithinAtlantaMetro } from './geo.ts';
import { createHash } from 'node:crypto';

// Google content is transient, user-specific preview only. Never persist the response.
export function googleGeocodingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PATCHUP_GOOGLE_GEOCODING_ENABLED === 'true' &&
    env.PATCHUP_GOOGLE_GEOCODING_PREVIEW_APPROVED === 'true' && Boolean(env.K_SERVICE) && !env.FIRESTORE_EMULATOR_HOST;
}
export type GoogleStreet = { streetName: string; formattedAddress: string; city: string; state: string; postalCode: string; placeId: string };
type Component = { types?: string[]; longText?: string; shortText?: string };
type Result = { types?: string[]; addressComponents?: Component[]; formattedAddress?: string; placeId?: string };
export function parseGoogleStreet(raw: unknown): GoogleStreet | null {
  const results = (raw as { results?: Result[] } | null)?.results;
  if (!Array.isArray(results)) return null;
  const valid = results.slice(0, 30).flatMap(r => {
    if (!Array.isArray(r?.addressComponents) || !Array.isArray(r.types) || !r.types.some(t => ['route','street_address','premise','subpremise'].includes(t))) return [];
    const component = (type: string, short = false) => {
      const c = r.addressComponents!.find(c => Array.isArray(c?.types) && c.types.includes(type));
      const value = short ? c?.shortText : c?.longText;
      return typeof value === 'string' ? value.trim() : '';
    };
    const streetName = component('route');
    if (!streetName || streetName.length > 128 || !/^[\p{L}0-9 .’'&/\-]+$/u.test(streetName) || component('country', true) !== 'US' || component('administrative_area_level_1', true) !== 'GA') return [];
    return [{ streetName, formattedAddress: typeof r.formattedAddress === 'string' ? r.formattedAddress.slice(0, 300) : '', city: component('locality'), state: 'GA', postalCode: component('postal_code'), placeId: typeof r.placeId === 'string' ? r.placeId.slice(0, 256) : '', route: r.types.includes('route') }];
  });
  // At intersections, competing road names are a reason to request correction.
  if (!valid.length || new Set(valid.map(r => normalizeStreetName(r.streetName))).size !== 1) return null;
  const best = valid.find(r => !r.route && r.formattedAddress) || valid[0];
  const {route: _route, ...result} = best;
  return result;
}
export function quotaWindows(uid: string, now: number) {
  const user = createHash('sha256').update(uid).digest('hex');
  const iso = new Date(now).toISOString();
  const minute = Math.floor(now / 60_000);
  // Fixed hard ceilings, shared across Cloud Run instances. UTC days/months.
  return [
    { id: `day_${iso.slice(0,10)}`, max: 100 },
    { id: `month_${iso.slice(0,7)}`, max: 3000 },
    { id: `minute_${minute}`, max: 20 },
    { id: `user_${user}_${minute}`, max: 5 },
    { id: `userday_${user}_${iso.slice(0,10)}`, max: 25 },
  ];
}
async function reserve(db: Firestore, uid: string): Promise<boolean> {
  const windows = quotaWindows(uid, Date.now());
  const refs = windows.map(w => db.collection('geocodingBudgets').doc(w.id));
  return db.runTransaction(async tx => {
    const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
    const counts = snapshots.map(s => s.exists ? s.data()?.count : 0);
    if (counts.some((n, i) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n >= windows[i].max)) return false;
    refs.forEach((ref,i) => tx.set(ref,{count: Number(counts[i])+1, expiresAt: new Date(Date.now()+ 35*86400_000)}));
    return true;
  });
}
export async function lookupGoogleStreet(db: Firestore, uid: string, lat: number, lng: number, projectId: string, fetcher: typeof fetch = fetch): Promise<{ match: GoogleStreet | null; status: 'disabled'|'unavailable'|'quota'|'no_match'|'ok' }> {
  if (!googleGeocodingEnabled() || !isWithinAtlantaMetro(lat,lng)) return {match:null,status:'disabled'};
  try {
    // Cloud Run's attached service account, verified by runtimeAuth at startup.
    // Metadata tokens use cloud-platform scope; no downloaded credentials or API keys.
    const tokenResponse = await fetcher('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {headers:{'Metadata-Flavor':'Google'},redirect:'error',signal:AbortSignal.timeout(4000)});
    if (!tokenResponse.ok) return {match:null,status:'unavailable'};
    const token = (await tokenResponse.json()).access_token;
    if (typeof token !== 'string' || !token) return {match:null,status:'unavailable'};
    if (!await reserve(db,uid)) return {match:null,status:'quota'};
    const response = await fetcher(`https://geocode.googleapis.com/v4/geocode/location/${lat},${lng}`, {headers:{Authorization:`Bearer ${token}`,'X-Goog-User-Project':projectId,'X-Goog-FieldMask':'results.types,results.addressComponents,results.formattedAddress,results.placeId'},redirect:'error',signal:AbortSignal.timeout(6000)});
    if (!response.ok) return {match:null,status:response.status===429?'quota':'unavailable'};
    const match = parseGoogleStreet(await response.json());
    return {match,status:match?'ok':'no_match'};
  } catch { return {match:null,status:'unavailable'}; }
}

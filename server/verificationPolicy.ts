import { createHash } from 'node:crypto';

export const PROMPT_VERSION = 'atldot-pothole-v3-pixel-redacted-v1';
export const SCHEMA_VERSION = '3';
export const CATEGORIES = ['pothole', 'depression', 'cave_in', 'alligator_cracking', 'utility_defect', 'crack', 'road_patch', 'other_road_damage', 'not_road', 'unclear'] as const;
export const QUALITIES = ['usable', 'limited'] as const;
export type Category = typeof CATEGORIES[number];
export type Observation = { category: Category; quality: typeof QUALITIES[number]; visibleCavity: boolean };
export type Decision = 'verified' | 'not_pothole' | 'needs_review';
export type Failure = 'disabled' | 'unconfigured' | 'timeout' | 'quota' | 'provider' | 'invalid_response' | 'busy';
export const MAX_IMAGE_BYTES = 400_000;
export const MAX_DIMENSION = 1280;
export const VALID_MS = 24 * 60 * 60 * 1000;
export function hashBytes(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function modelId(): string { return process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite'; }
export function releaseId(model = modelId()): string { return `${model}|${PROMPT_VERSION}|${SCHEMA_VERSION}`; }
export function autoAcceptEnabled(model = modelId()): boolean {
  return process.env.PATCHUP_IMAGE_AI_ENABLED === 'true' && process.env.PATCHUP_AUTO_ACCEPT === 'true' && process.env.PATCHUP_BENCHMARK_APPROVED_VERSION === releaseId(model) && model === modelId();
}
export function validateObservation(value: unknown): Observation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid observation');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 3 || !CATEGORIES.includes(v.category as Category) || !QUALITIES.includes(v.quality as Observation['quality']) || typeof v.visibleCavity !== 'boolean') throw new Error('Invalid observation');
  return { category: v.category as Category, quality: v.quality as Observation['quality'], visibleCavity: v.visibleCavity };
}
export function classifyObservation(o: Observation): Decision {
  if (o.quality !== 'usable' || o.category === 'unclear') return 'needs_review';
  if (o.category === 'pothole') return o.visibleCavity ? 'verified' : 'needs_review';
  // Clearly identified alternative ATLDOT defect types are not potholes, even if open.
  if (o.category === 'cave_in' || o.category === 'utility_defect') return 'not_pothole';
  return o.visibleCavity ? 'needs_review' : 'not_pothole';
}
export function publicSummary(o: Observation | null): string {
  if (!o) return 'Photo verification is unavailable. Retry or request manual review.';
  if (classifyObservation(o) === 'needs_review') return 'The photograph does not provide sufficiently clear evidence of a pothole.';
  return ({pothole: 'A visible cavity or missing road surface is present.', depression: 'The photograph shows an indentation with the road surface still intact, rather than a pothole.', cave_in: 'The photograph appears to show a roadway cave-in, which is a different defect from a pothole.', alligator_cracking: 'The photograph shows interconnected pavement cracking without a distinct pothole.', utility_defect: 'The photograph shows a utility cover or access defect rather than a pothole.', crack: 'The photograph shows cracking rather than a discrete pothole.', road_patch: 'The photograph shows a road patch rather than a pothole.', other_road_damage: 'The photograph shows another road condition, not a clear pothole.', not_road: 'The photograph does not show a road pothole.', unclear: 'The photograph requires review.'})[o.category];
}
export function boundedInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const n = Number(value); return Number.isSafeInteger(n) && n >= 0 && n <= max ? n : fallback;
}
export interface VerificationRecord {
  verificationId: string; mediaId: string; ownerId: string; imageHash: string; contentHash: string;
  model: string; promptVersion: string; schemaVersion: string; provider: 'gemini';
  verificationState: 'pending' | 'completed' | 'unavailable'; classificationDecision: Decision | null;
  observation: Observation | null; failureCategory: Failure | null;
  createdAtMs: number; expiresAtMs: number; consumedSubmissionId: string | null;
}
export function authorizeVerification(v: VerificationRecord, p: {uid: string; mediaId: string; imageHash: string; contentHash: string; now: number; model: string; manual: boolean; autoEnabled: boolean}): void {
  if (!v || v.ownerId !== p.uid || v.mediaId !== p.mediaId || v.imageHash !== p.imageHash || v.contentHash !== p.contentHash || v.provider !== 'gemini') throw new Error('Verification does not match your photo.');
  if (v.consumedSubmissionId !== null) throw new Error('Photo verification has already been used.');
  if (v.model !== p.model || v.promptVersion !== PROMPT_VERSION || v.schemaVersion !== SCHEMA_VERSION || !Number.isFinite(v.expiresAtMs) || v.expiresAtMs <= p.now || v.createdAtMs > p.now) throw new Error('Verification has expired. Check the photo again.');
  if (v.verificationState === 'pending') throw new Error('Photo verification is still processing.');
  if (v.verificationState === 'completed') {
    if (classifyObservation(validateObservation(v.observation)) !== v.classificationDecision) throw new Error('Invalid stored verification.');
  } else if (v.verificationState !== 'unavailable' || v.classificationDecision !== null || v.observation !== null) throw new Error('Invalid stored verification.');
  if (!p.manual && (!p.autoEnabled || v.verificationState !== 'completed' || v.classificationDecision !== 'verified')) throw new Error('Photo must be submitted for manual review.');
}

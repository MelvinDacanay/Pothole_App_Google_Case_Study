import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export const CONSENT_VERSION = '2026-11-27-v2';
export function consentAccepted(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.ageConfirmed === true && v.aiConsent === true && v.version === CONSENT_VERSION;
}
export function validConsentRequest(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.ageConfirmed === true && v.aiConsent === true && v.version === CONSENT_VERSION;
}
function consentRef(db: Firestore, uid: string) {
  return db.collection('users').doc(uid).collection('private').doc('consent');
}
export async function hasAccountConsent(db: Firestore, uid: string): Promise<boolean> {
  return consentAccepted((await consentRef(db, uid).get()).data());
}
export async function saveAccountConsent(db: Firestore, uid: string): Promise<void> {
  const ref = consentRef(db, uid);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!consentAccepted(snap.data())) tx.set(ref, {
      ageConfirmed: true, aiConsent: true, version: CONSENT_VERSION,
      acceptedAt: FieldValue.serverTimestamp(),
    });
  });
}

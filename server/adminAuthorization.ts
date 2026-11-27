import type { Auth, DecodedIdToken, UserRecord } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';

export function getAllowedAdminEmails(): Set<string> {
  return new Set((process.env.PATCHUP_ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean));
}
export function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}
export function isAllowedAdminAccount(account: Pick<UserRecord, 'email' | 'emailVerified' | 'disabled'>, allowed = getAllowedAdminEmails()): boolean {
  const email = normalizeEmail(account.email);
  return !account.disabled && account.emailVerified === true && !!email && allowed.has(email);
}
export function isAllowedAdminToken(token: Pick<DecodedIdToken, 'email' | 'email_verified'>, allowed = getAllowedAdminEmails()): boolean {
  const email = normalizeEmail(token.email);
  return token.email_verified === true && !!email && allowed.has(email);
}
// Claims and Firestore admin records are never authority. Check the live Auth account
// as well as the token, so a changed email or disabled account cannot inherit access.
export async function authorizeAdmin(auth: Pick<Auth, 'getUser'>, token: DecodedIdToken): Promise<boolean> {
  if (!isAllowedAdminToken(token)) return false;
  const account = await auth.getUser(token.uid);
  return isAllowedAdminAccount(account) && normalizeEmail(account.email) === normalizeEmail(token.email);
}
// Remove legacy claims without overwriting unrelated custom claims. A revoked session
// is defense in depth; authorization does not depend on the token expiring.
export async function revokeLegacyAdmin(auth: Pick<Auth, 'getUser' | 'setCustomUserClaims' | 'revokeRefreshTokens'>, db: Firestore, uid: string): Promise<void> {
  // Missing configuration denies access but must not revoke other deployments'
  // records merely because a developer forgot to set the allowlist.
  if (process.env.PATCHUP_ADMIN_EMAILS === undefined) return;
  const ref = db.collection('admins').doc(uid);
  let account: UserRecord;
  try { account = await auth.getUser(uid); }
  catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err;
    await ref.delete();
    return;
  }
  // Recheck current authority before changing a record; stale tokens alone must not
  // revoke an eligible account.
  if (isAllowedAdminAccount(account)) return;
  const previous = await ref.get();
  const claims = { ...account.customClaims };
  const hadAdminClaim = Object.prototype.hasOwnProperty.call(claims, 'admin');
  if (hadAdminClaim || previous.exists) await auth.revokeRefreshTokens(uid);
  if (hadAdminClaim) {
    delete claims.admin;
    await auth.setCustomUserClaims(uid, claims);
  }
  if (previous.exists) await ref.delete();
}
// Reconcile the small, server-managed enrollment directory at startup. Legacy
// claim-only accounts are also reconciled when they next request bootstrap.
export async function reconcileAdminDirectory(auth: Auth, db: Firestore): Promise<void> {
  if (process.env.PATCHUP_ADMIN_EMAILS === undefined) return;
  const enrolled = await db.collection('admins').get();
  let failures = 0;
  for (const doc of enrolled.docs) {
    try { await revokeLegacyAdmin(auth, db, doc.id); } catch { failures++; }
  }
  if (failures) throw new Error('Administrator directory reconciliation incomplete.');
}

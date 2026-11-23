import type { CoordinateSource } from './maps';

/**
 * Pre-auth capture handoff.
 *
 * The landing page lets an unauthenticated visitor take or choose a pothole
 * photo and confirm its location client-side. None of that can be persisted
 * until they sign in (every capture endpoint requires a verified Bearer token
 * and Firestore rules block anonymous mediaObjects writes). So we hold the raw
 * File plus the confirmed location here, in module scope, and hand it to
 * CaptureView once auth completes.
 *
 * This survives the sign-in because signInWithPopup does NOT reload the page —
 * React re-renders, but this module keeps its value. The draft is consumed
 * exactly once and never written to disk, so no capture is ever lost or
 * silently duplicated.
 */
export interface PendingCaptureDraft {
  file: File;
  coords: { lat: number; lng: number } | null;
  coordinateSource: CoordinateSource;
  locationUserCorrected: boolean;
}

let draft: PendingCaptureDraft | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

export function setPendingCapture(next: PendingCaptureDraft | null): void {
  draft = next;
  notify();
}

export function getPendingCapture(): PendingCaptureDraft | null {
  return draft;
}

export function hasPendingCapture(): boolean {
  return draft !== null;
}

/** Returns the draft and clears it so CaptureView only ingests it once. */
export function consumePendingCapture(): PendingCaptureDraft | null {
  const current = draft;
  draft = null;
  notify();
  return current;
}

export function subscribePendingCapture(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

import type { Timestamp } from 'firebase/firestore';

export const ATLANTA_CENTER = { lat: 33.749, lng: -84.388 } as const;

export type CoordinateSource = 'gps_verified' | 'exif_extracted' | 'manual_pin';
export type PotholeStatus =
  | 'accepted'
  | 'provisional'
  | 'reported'
  | 'acknowledged'
  | 'repaired'
  | 'rejected';

export type SeverityLabel = 'low' | 'moderate' | 'severe' | 'unclassified';

export interface PotholeRecord {
  potholeId: string;
  lat: number;
  lng: number;
  coordinateSource: CoordinateSource;
  accuracyMeters?: number;
  formattedAddress: string;
  streetName: string;
  normalizedStreet: string;
  neighborhood?: string;
  city: string;
  state: string;
  postalCode?: string;
  placeId?: string;
  jurisdiction: 'atldot' | 'gdot' | 'unknown';
  segmentId?: string;
  segmentConfidence?: 'verified' | 'provisional' | 'needs_review';
  locationUserCorrected: boolean;
  status: PotholeStatus;
  verificationStatus: 'accepted' | 'provisional' | 'needs_review' | 'rejected';
  severityLabel: SeverityLabel;
  primaryContributorUid: string;
  primaryContributorUsername: string;
  primaryContributorDisplayName: string;
  primaryPhotoUrl: string;
  primaryMediaId: string;
  evidenceCount: number;
  submissionCount: number;
  aiReviewSummary?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export type SegmentConfidence = 'verified' | 'provisional' | 'needs_review';
export type ReportStatus =
  | 'awaiting_admin_review'
  | 'ready_for_submission'
  | 'submitted'
  | 'acknowledged'
  | 'resolved'
  | 'unable_to_submit'
  | 'closed';

export interface StreetSegmentRecord {
  segmentId: string;
  streetName: string;
  normalizedStreet: string;
  corridorLabel: string;
  city: string;
  state: string;
  neighborhood?: string;
  jurisdiction: 'atldot' | 'gdot' | 'unknown';
  confidence: SegmentConfidence;
  anchorLat: number;
  anchorLng: number;
  distinctAcceptedCount: number;
  currentCycleNumber: number;
  currentCycleDistinctCount: number;
  activeReportId?: string;
  status: 'active' | 'merged';
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface CommunityReportRecord {
  reportId: string;
  segmentId: string;
  cycleNumber: number;
  streetName: string;
  corridorLabel: string;
  jurisdiction: 'atldot' | 'gdot' | 'unknown';
  status: ReportStatus;
  distinctPotholeCount: number;
  supplementCount: number;
  snapshotPotholeIds: string[];
  centerLat: number;
  centerLng: number;
  addressRange?: string;
  externalReference?: string;
  submissionChannel?: string;
  submittedByUid?: string;
  adminReviewNotes?: string;
  googleSheetUrl?: string;
  evidenceMateriallyChanged?: boolean;
  createdAt?: Timestamp;
  cutoffAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface AdminAuditEvent {
  eventId: string;
  actorUid: string;
  actorEmail?: string;
  action: string;
  targetType: 'pothole' | 'segment' | 'report' | 'admin';
  targetId: string;
  reason: string;
  beforeSummary?: string;
  afterSummary?: string;
  createdAt?: Timestamp;
}

export interface PotholeSubmission {
  submissionId: string;
  userId: string;
  username: string;
  displayName: string;
  potholeId: string;
  candidatePotholeIds?: string[];
  actionType: 'new_pothole' | 'add_evidence' | 'provisional_review';
  duplicateStatus: 'distinct' | 'evidence_added' | 'pending_review' | 'merged' | 'rejected';
  duplicateConfidence: number;
  mediaId: string;
  photoUrl: string;
  lat: number;
  lng: number;
  coordinateSource: CoordinateSource;
  accuracyMeters?: number;
  formattedAddress: string;
  streetName: string;
  normalizedStreet: string;
  locationUserCorrected: boolean;
  notes?: string;
  aiClassificationStatus: 'completed' | 'unavailable' | 'skipped';
  aiIsRoadDefect?: boolean;
  aiSeverityLabel: SeverityLabel;
  aiSummary?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DuplicateCandidateSummary {
  potholeId: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  confidence: number;
  recommendation: 'likely_same' | 'uncertain' | 'distinct_nearby';
  formattedAddress: string;
  streetName: string;
  normalizedStreet: string;
  primaryPhotoUrl: string;
  primaryMediaId: string;
  status: string;
  severityLabel: string;
  evidenceCount: number;
}

export interface MapsClientConfig {
  configured: boolean;
  apiKey: string;
  mapId: string;
}

export const COORDINATE_SOURCE_LABELS: Record<CoordinateSource, string> = {
  gps_verified: 'GPS Verified',
  exif_extracted: 'EXIF Photo GPS',
  manual_pin: 'Manual Pin',
};

export const POTHOLE_STATUS_LABELS: Record<PotholeStatus, string> = {
  accepted: 'Accepted',
  provisional: 'Needs Review',
  reported: 'Reported',
  acknowledged: 'Acknowledged',
  repaired: 'Confirmed Repaired',
  rejected: 'Rejected',
};

export const JURISDICTION_LABELS: Record<'atldot' | 'gdot' | 'unknown', string> = {
  atldot: 'City of Atlanta (ATLDOT)',
  gdot: 'Georgia DOT (GDOT)',
  unknown: 'Unclassified Jurisdiction',
};

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  awaiting_admin_review: 'Awaiting Admin Review',
  ready_for_submission: 'Ready for Submission',
  submitted: 'Submitted (Agency Ref Recorded)',
  acknowledged: 'Acknowledged by Agency',
  resolved: 'Resolved & Cycle Closed',
  unable_to_submit: 'Unable to Submit',
  closed: 'Closed',
};

export const SEGMENT_CONFIDENCE_LABELS: Record<SegmentConfidence, string> = {
  verified: 'Verified Corridor',
  provisional: 'Provisional (Needs Verification)',
  needs_review: 'Needs Street Review',
};

let cachedConfigPromise: Promise<MapsClientConfig> | null = null;

export async function loadMapsClientConfig(): Promise<MapsClientConfig> {
  const viteKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (viteKey && viteKey.trim().length > 0) {
    return {
      configured: true,
      apiKey: viteKey.trim(),
      mapId: 'DEMO_MAP_ID',
    };
  }

  if (!cachedConfigPromise) {
    cachedConfigPromise = fetch('/api/maps/config')
      .then((res) => res.json() as Promise<MapsClientConfig>)
      .catch(() => ({
        configured: false,
        apiKey: '',
        mapId: 'DEMO_MAP_ID',
      }));
  }

  return cachedConfigPromise;
}

export function dispatchMapsQuotaWarning() {
  window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
}

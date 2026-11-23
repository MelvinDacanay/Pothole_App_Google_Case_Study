import { COORDINATE_SOURCE_LABELS, CoordinateSource, JURISDICTION_LABELS, SeverityLabel } from './maps';

export interface ReportDraftInput {
  potholeId: string;
  streetName: string;
  formattedAddress: string;
  lat: number;
  lng: number;
  jurisdiction: 'atldot' | 'gdot' | 'unknown';
  agencyName: string;
  severityLabel: SeverityLabel;
  coordinateSource: CoordinateSource;
  notes?: string;
  /** ISO date the pothole was captured/reported in PatchUp. */
  reportedAtISO: string;
  /** Absolute or app-relative URL to the evidence photo. */
  photoUrl?: string;
}

const SEVERITY_TEXT: Record<SeverityLabel, string> = {
  low: 'Low — minor surface damage',
  moderate: 'Moderate — clear hazard to tires/vehicles',
  severe: 'Severe — significant hazard, risk of damage or injury',
  unclassified: 'Not classified',
};

function formatReportedDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * A clean, copy-paste-ready description for an official portal form. States
 * only verified facts; never claims the report has been submitted, and labels
 * the PatchUp ID as an internal reference so it is not confused with an
 * official agency case number.
 */
export function buildOfficialReportText(input: ReportDraftInput): string {
  const lines = [
    'POTHOLE / ROAD HAZARD REPORT',
    '',
    `Responsible agency: ${input.agencyName}`,
    `Jurisdiction: ${JURISDICTION_LABELS[input.jurisdiction]}`,
    '',
    `Location: ${input.formattedAddress || input.streetName}`,
    `Street: ${input.streetName}`,
    `Coordinates: ${input.lat.toFixed(6)}, ${input.lng.toFixed(6)}`,
    `Location source: ${COORDINATE_SOURCE_LABELS[input.coordinateSource]}`,
    `Google Maps: https://www.google.com/maps/search/?api=1&query=${input.lat.toFixed(6)},${input.lng.toFixed(6)}`,
    '',
    `Severity: ${SEVERITY_TEXT[input.severityLabel]}`,
    `First documented: ${formatReportedDate(input.reportedAtISO)}`,
  ];
  if (input.notes && input.notes.trim()) {
    lines.push('', `Additional detail: ${input.notes.trim()}`);
  }
  lines.push(
    '',
    'A time-stamped photo is attached/available on request.',
    `PatchUp internal reference (not an official case number): ${input.potholeId}`,
    '',
    'Submitted by an Atlanta resident via PatchUp, a community road-reporting project.'
  );
  return lines.join('\n');
}

export function buildEmailSubject(input: ReportDraftInput): string {
  return `Pothole report — ${input.streetName || 'Atlanta road hazard'}`;
}

/**
 * Email body for the user to send to a recipient THEY confirm (a council
 * office, a representative, or their own records). Mirrors the official report
 * and is explicit that a photo must be attached manually.
 */
export function buildEmailBody(input: ReportDraftInput): string {
  return [
    'Hello,',
    '',
    `I'm reporting a pothole that needs repair. Details below.`,
    '',
    buildOfficialReportText(input),
    '',
    'Please attach the evidence photo from PatchUp before sending (it is not',
    'automatically included in this draft). I can provide additional photos or',
    'details on request.',
    '',
    'Thank you,',
  ].join('\n');
}

export function buildMailtoUrl(recipient: string, subject: string, body: string): string {
  const to = recipient.trim();
  const params = new URLSearchParams({ subject, body });
  return `mailto:${encodeURIComponent(to)}?${params.toString()}`;
}

export function buildGmailComposeUrl(recipient: string, subject: string, body: string): string {
  const params = new URLSearchParams({
    view: 'cm',
    fs: '1',
    to: recipient.trim(),
    su: subject,
    body,
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

export function buildMapsSearchUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Suggested filename for the downloaded evidence photo. */
export function photoDownloadFilename(input: ReportDraftInput): string {
  const streetSlug = (input.streetName || 'pothole')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const datePart = input.reportedAtISO.slice(0, 10);
  return `patchup-${streetSlug || 'pothole'}-${datePart}.jpg`;
}

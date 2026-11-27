/** Plain-language labels for administrators. Stored status values remain unchanged. */
export const ADMIN_SECTIONS = [
  { id: 'reviews', label: 'Photo Reviews', description: 'Help us decide whether submitted photos show real potholes.', empty: 'There are no photos waiting for review.' },
  { id: 'drafts', label: 'Email Drafts', description: 'When five different potholes are approved near each other on a street, a report is prepared here. Check the email and photos before reporting it.', empty: 'There are no email drafts yet.' },
  { id: 'sent', label: 'Sent Reports', description: 'Keep track of reports submitted to ATL311 or another road maintenance agency. A response from the city does not necessarily mean the potholes have been repaired.', empty: 'There are no submitted reports to show.' },
  { id: 'repairs', label: 'Confirm Repairs', description: 'Update the community when you have reliable evidence that a specific pothole has actually been repaired.', empty: 'There are no open potholes to review for repairs.' },
  { id: 'history', label: 'Activity History', description: 'See the most recent 30 administrative actions.', empty: 'No recent administrative activity.' },
] as const;
export type AdminSection = typeof ADMIN_SECTIONS[number]['id'];

export function adminReportStatus(status?: string): string {
  switch (status) {
    case 'awaiting_admin_review': return 'Needs your review';
    case 'ready_for_submission': return 'Ready to send';
    case 'submitted': return 'Submitted — awaiting response';
    case 'acknowledged': return 'Received by the agency';
    case 'resolved': return 'Agency case resolved';
    case 'unable_to_submit': return 'Not submitted — needs attention';
    case 'closed': return 'Closed';
    default: return 'Status unavailable';
  }
}

export function adminRoadOwner(jurisdiction?: string): string {
  return jurisdiction === 'atldot' ? 'Likely maintained by the City of Atlanta'
    : jurisdiction === 'gdot' ? 'Likely maintained by the Georgia Department of Transportation (GDOT)'
    : 'Road maintenance responsibility could not be confirmed';
}

export function adminDraftWarning(warning: string): string {
  if (warning === 'Street name missing.') return 'The street name could not be confirmed.';
  if (warning.startsWith('Fewer than five')) return 'This report does not yet have five different approved potholes.';
  if (warning.startsWith('This snapshot contains more than five')) return 'More than five potholes are recorded here. This email includes the first five; ask the PatchUp team to check the additional photos.';
  if (warning.startsWith('City maintenance jurisdiction')) return 'This road may not be maintained by the City of Atlanta. Ask the PatchUp team to check who is responsible.';
  if (warning.includes('PATCHUP_REPORT_FROM_EMAIL')) return 'The shared reporting email has not been set up. Ask the PatchUp team to configure it.';
  const match = /^Pothole (\d+)(?::)? (.*)$/.exec(warning);
  if (match) {
    const [, number, detail] = match;
    if (detail.includes('missing valid accepted evidence')) return `Pothole ${number}: an approved photo or location is missing or invalid.`;
    if (detail.includes('repeats a photo')) return `Pothole ${number}: the same photo is attached more than once.`;
    if (detail.includes('jurisdiction confirmation')) return `Pothole ${number}: we couldn't confirm which agency maintains this road.`;
    if (detail.includes('corridor confirmation')) return `Pothole ${number}: we couldn't confirm that this location belongs with the other potholes on this street.`;
    if (detail.includes('image unavailable')) return `Pothole ${number}: the photo is unavailable.`;
  }
  return 'Some report details need attention. Ask the PatchUp team to check this report before submitting it.';
}

export function adminActivityLabel(action?: string, after?: string): string {
  switch (action) {
    case 'submission_review':
      return after === 'confirm_distinct' ? 'Photo approved' : after === 'reject' ? 'Photo rejected' : after === 'merge_evidence' ? 'Additional photo accepted' : 'Photo reviewed';
    case 'pothole_review': return /^status=repaired(?:,|$)/.test(after||'') ? 'Repair confirmed' : 'Pothole details updated';
    case 'report_status_transition': {
      const status = /^status=([a-z_]+)/.exec(after || '')?.[1];
      return status === 'submitted' ? 'Report submission recorded' : status === 'acknowledged' ? 'Agency response recorded' : status === 'resolved' ? 'Agency case resolved' : status === 'ready_for_submission' ? 'Report marked ready' : status === 'unable_to_submit' ? 'Report could not be submitted' : status === 'closed' ? 'Report closed' : 'Report updated';
    }
    case 'segment_reassign': case 'segment_merge': case 'segment_split': return 'Street locations updated';
    case 'sheet_export': return 'Report exported';
    default: return 'Administrative update';
  }
}

export function adminDate(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value)>8.64e15) return 'Date unavailable';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

import type { ReportChannel } from './maps';

/**
 * Verified public agency-contact directory for Atlanta-area pothole reporting.
 * Neither ATL311 nor GDOT publishes a direct pothole-report email address, so
 * the email draft never guesses a government address.
 */
export interface AgencyContact {
  key: ReportChannel;
  name: string;
  shortName: string;
  handles: string;
  portalUrl: string;
  portalLabel: string;
  phonePrimary: string;
  phoneNote?: string;
  issuesCaseNumber: boolean;
  caseNumberNote?: string;
}

export const ATL311_CONTACT: AgencyContact = {
  key: 'atl311',
  name: 'City of Atlanta — ATL311',
  shortName: 'ATL311',
  handles: 'Potholes and road/sidewalk hazards on City of Atlanta–maintained streets.',
  portalUrl: 'https://www.atl311.com',
  portalLabel: 'atl311.com',
  phonePrimary: '311',
  phoneNote: 'Dial 311 inside Atlanta, or (404) 546-0311 from outside the city.',
  issuesCaseNumber: true,
  caseNumberNote:
    'ATL311 emails you an automated case number after you submit. Log that number here to track it.',
};

export const GDOT_CONTACT: AgencyContact = {
  key: 'gdot',
  name: 'Georgia Department of Transportation (GDOT)',
  shortName: 'GDOT',
  handles: 'Potholes on state routes, interstates, and GDOT-maintained corridors.',
  portalUrl: 'https://gadot.service-now.com/gsp',
  portalLabel: 'GDOT Self-Service Portal',
  phonePrimary: '511',
  phoneNote: 'Dial 511 in Georgia, or (877) 694-2511. Use GDOT’s portal “Report a Pothole”.',
  issuesCaseNumber: true,
  caseNumberNote: 'GDOT’s portal issues a reference/ticket number. Log it here once you have it.',
};

export function resolveAgency(jurisdiction: 'atldot' | 'gdot' | 'unknown'): {
  agency: AgencyContact;
  confirmed: boolean;
} {
  if (jurisdiction === 'gdot') return { agency: GDOT_CONTACT, confirmed: true };
  if (jurisdiction === 'atldot') return { agency: ATL311_CONTACT, confirmed: true };
  return { agency: ATL311_CONTACT, confirmed: false };
}

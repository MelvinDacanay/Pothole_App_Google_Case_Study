import type { ReportChannel } from './maps';

/**
 * Verified public agency-contact directory for Atlanta-area pothole reporting.
 *
 * Every value here is a published, official public-service channel — not a
 * scraped individual's address. Both ATL311 and GDOT take pothole reports
 * through an online portal or phone line; neither publishes a direct
 * pothole-report email address, so `email` is intentionally absent. The email
 * draft flow never guesses a government address: the recipient is a field the
 * user confirms themselves.
 *
 * Sources (verified Nov 2026):
 * - City of Atlanta / ATL311: https://www.atl311.com ·
 *   https://www.atlantaga.gov/i-want-to/report-a-potential-hazard-in-the-street-or-sidewalk
 *   Phone: 311 in-city, (404) 546-0311 outside. A case number is emailed on submission.
 * - Georgia DOT: https://gadot.service-now.com/gsp (Report a Pothole) · Phone: 511 / 877-694-2511.
 */
export interface AgencyContact {
  key: ReportChannel;
  name: string;
  shortName: string;
  handles: string;
  /** Official online intake where the case number is generated. */
  portalUrl: string;
  portalLabel: string;
  phonePrimary: string;
  phoneNote?: string;
  /** True when submitting through the portal produces a trackable case number. */
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
  caseNumberNote:
    'GDOT’s portal issues a reference/ticket number. Log it here once you have it.',
};

/**
 * Resolve the primary responsible agency for a pothole from its jurisdiction.
 * `unknown` jurisdiction has no confirmed owner — we return ATL311 as the most
 * likely City channel but flag it so the UI tells the user to confirm.
 */
export function resolveAgency(jurisdiction: 'atldot' | 'gdot' | 'unknown'): {
  agency: AgencyContact;
  confirmed: boolean;
} {
  if (jurisdiction === 'gdot') return { agency: GDOT_CONTACT, confirmed: true };
  if (jurisdiction === 'atldot') return { agency: ATL311_CONTACT, confirmed: true };
  return { agency: ATL311_CONTACT, confirmed: false };
}

export const ALL_AGENCIES: AgencyContact[] = [ATL311_CONTACT, GDOT_CONTACT];

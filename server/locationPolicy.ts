export const LOCATION_POLICY_VERSION = 'independent-v1';
export type IndependentStreetSource = 'city_centerline'|'tiger_line'|'user_observed';
export function isIndependentSource(source: unknown): source is IndependentStreetSource {
  return source === 'city_centerline' || source === 'tiger_line' || source === 'user_observed';
}
export function isIndependentRecord(record: Record<string,unknown> | undefined): boolean {
  return record?.locationPolicyVersion === LOCATION_POLICY_VERSION && isIndependentSource(record.streetSource);
}
export function requireIndependentSource(source: unknown): asserts source is IndependentStreetSource {
  if (!isIndependentSource(source)) throw new Error('An independently sourced road is required for community records.');
}
export function reportsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PATCHUP_LOCATION_HISTORY_AUDITED === 'true';
}
export function exportRows(ids: string[], records: Record<string,unknown>[]): (string|number)[][] {
  if (ids.length < 5 || new Set(ids).size !== ids.length || records.length !== ids.length) throw new Error('Incomplete report snapshot.');
  const rows: (string|number)[][] = [['Pothole ID','Independently sourced street','Latitude','Longitude','Street source']];
  ids.forEach((id,i)=>{const p=records[i];if(!isIndependentRecord(p)||!['accepted','reported','acknowledged','repaired'].includes(String(p.status))||typeof p.streetName!=='string'||!p.streetName.trim()||typeof p.lat!=='number'||typeof p.lng!=='number'||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)||Math.abs(p.lat)>90||Math.abs(p.lng)>180)throw new Error('Report contains an unverified location record.');rows.push([id,p.streetName,p.lat,p.lng,String(p.streetSource)]);});
  return rows;
}

export const NEW_REPORT_GROUP_VERSION = 'private-report-v2';
export function isNewReportGroup(record: Record<string,unknown> | undefined): boolean { return record?.reportGroupVersion === NEW_REPORT_GROUP_VERSION; }

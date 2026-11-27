export const DRAFT_RECIPIENT = 'atl311@atlantaga.gov';
const safeId = /^[A-Za-z0-9_-]{1,128}$/;
export function buildReportDraft(report: Record<string, unknown>, potholes: Record<string, unknown>[], sender: string) {
  const street = String(report.streetName || '').replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0,128);
  const ids = Array.isArray(report.snapshotPotholeIds) ? [...new Set(report.snapshotPotholeIds.filter((id): id is string => typeof id === 'string' && safeId.test(id)))] : [];
  const warnings: string[] = [];
  if (!street) warnings.push('Street name missing.');
  if (ids.length < 5) warnings.push('Fewer than five distinct snapshot potholes.');
  if (ids.length > 5) warnings.push('This snapshot contains more than five potholes; review remaining evidence in Community Reports.');
  if (report.jurisdiction !== 'atldot') warnings.push('City maintenance jurisdiction has not been established.');
  if (!sender || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(sender)) warnings.push('Configure PATCHUP_REPORT_FROM_EMAIL before delivery.');
  const usedMedia = new Set<string>();
  const attachments = ids.slice(0,5).flatMap((id,index) => {
    const p = potholes.find(p => p.potholeId === id);
    if (!p || !['accepted','reported','acknowledged'].includes(String(p.status)) || p.verificationStatus !== 'accepted' || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat)>90 || Math.abs(p.lng)>180 || typeof p.primaryMediaId !== 'string' || !safeId.test(p.primaryMediaId)) {
      warnings.push(`Pothole ${index+1} is missing valid accepted evidence.`); return [];
    }
    if (usedMedia.has(p.primaryMediaId)) {warnings.push(`Pothole ${index+1} repeats a photo already attached.`);return [];}
    usedMedia.add(p.primaryMediaId);
    if (!['city_centerline','tiger_line','user_observed'].includes(String(p.streetSource))) warnings.push(`Pothole ${index+1}: confirm the street name independently before sending.`);
    if (p.jurisdiction !== 'atldot') warnings.push(`Pothole ${index+1} needs jurisdiction confirmation.`);
    if (p.segmentId !== report.segmentId) warnings.push(`Pothole ${index+1} needs corridor confirmation.`);
    return [{number:index+1,potholeId:id,mediaId:p.primaryMediaId,lat:p.lat,lng:p.lng}];
  });
  const body = `Hello ATL311 & Pothole Posse,\n\nWe would like to report that we have documented potholes on ${street || '[Street Name]'}. We have included photos, as well as exact coordinates that can help to assist in locating the potholes we've found.\n\nCoordinates:\n${attachments.map(a=>`- Pothole ${a.number}: ${a.lat.toFixed(6)}, ${a.lng.toFixed(6)}`).join('\n')}\n\nAbout Us: We are PatchUp, an independent community initiative and reporting tool with the goal of encouraging locals to document and report potholes.\n\nThank you for your time and consideration.\n\nBest,\nPatchUp`;
  return {from:sender,to:DRAFT_RECIPIENT,subject:`Pothole Report - ${street || '[Street Name]'} - PatchUp (Local Initiative)`,body,attachments,warnings};
}

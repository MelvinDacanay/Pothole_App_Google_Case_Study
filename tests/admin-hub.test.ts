import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_SECTIONS, adminReportStatus, adminRoadOwner, adminDraftWarning, adminActivityLabel, adminDate } from '../src/lib/adminLabels.ts';
import { buildReportDraft } from '../server/adminDraft.ts';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
test('Admin Hub exposes only everyday community management sections', () => {
  assert.deepEqual(ADMIN_SECTIONS.map(tab => tab.label), ['Photo Reviews', 'Email Drafts', 'Sent Reports', 'Confirm Repairs', 'Activity History']);
  for (const tab of ADMIN_SECTIONS) {
    assert.doesNotMatch(`${tab.label} ${tab.description} ${tab.empty}`, /corridor|segment|packet|threshold|merge|split|jurisdiction/i);
  }
});
test('report status text never implies case closure is repair or draft is sent', () => {
  assert.equal(adminReportStatus('awaiting_admin_review'), 'Needs your review');
  assert.equal(adminReportStatus('ready_for_submission'), 'Ready to send');
  assert.match(adminReportStatus('submitted'), /awaiting response/);
  assert.equal(adminReportStatus('acknowledged'), 'Received by the agency');
  assert.doesNotMatch(adminReportStatus('resolved'), /repair/i);
  assert.match(adminReportStatus('unable_to_submit'), /Not submitted/);
  assert.equal(adminReportStatus('unknown'), 'Status unavailable');
});
test('road maintenance labels indicate uncertainty rather than claiming confirmed ownership', () => {
  assert.match(adminRoadOwner('atldot'), /Likely.*City of Atlanta/);
  assert.match(adminRoadOwner('gdot'), /Likely.*Georgia Department of Transportation/);
  assert.match(adminRoadOwner('unknown'), /could not be confirmed/);
});
test('draft warnings are understandable and preserve the reason to stop', () => {
  const d = buildReportDraft({streetName:'',snapshotPotholeIds:['p1'],jurisdiction:'unknown'}, [], '');
  const mapped = d.warnings.map(adminDraftWarning);
  assert.ok(mapped.some(w => /street name/.test(w)));
  assert.ok(mapped.some(w => /five different/.test(w)));
  assert.ok(mapped.some(w => /maintained/.test(w)));
  assert.ok(mapped.some(w => /shared reporting email/.test(w)));
  assert.ok(mapped.some(w => /photo or location/.test(w)));
  assert.doesNotMatch(mapped.join(' '), /PATCHUP_REPORT_FROM_EMAIL|jurisdiction|corridor|snapshot/);
  assert.match(adminDraftWarning('Pothole 3 needs corridor confirmation.'), /Pothole 3.*location belongs/);
  assert.match(adminDraftWarning('Pothole 4: image unavailable.'), /Pothole 4.*photo is unavailable/);
  assert.match(adminDraftWarning('Unknown internal error'), /Ask the PatchUp team/);
});
test('audit descriptions distinguish approvals, rejection, reporting, and repair', () => {
  assert.equal(adminActivityLabel('submission_review','confirm_distinct'),'Photo approved');
  assert.equal(adminActivityLabel('submission_review','reject'),'Photo rejected');
  assert.equal(adminActivityLabel('pothole_review','status=repaired, street=X'),'Repair confirmed');
  assert.equal(adminActivityLabel('report_status_transition','status=resolved, cycle_closed=true'),'Agency case resolved');
  assert.equal(adminActivityLabel('segment_merge'),'Street locations updated');
  assert.equal(adminDate(null),'Date unavailable');
  assert.notEqual(adminDate(1795798800000),'Date unavailable');
});
test('old corridor screen has no app entry points; admin-only hub remains', () => {
  const app = read('src/App.tsx');
  assert.doesNotMatch(app,/CommunityReportsView|setSubView|onOpenCommunity/);
  assert.match(app,/activeTab === 'admin' && isAdmin && <AdminHubView/);
  assert.doesNotMatch(read('src/views/MapView.tsx'), /onOpenCommunity|View Report Cycle|<span>Corridors<\/span>/);
  const hub = read('src/views/AdminHubView.tsx');
  assert.doesNotMatch(hub, /onOpenCommunity|Merge Evidence|Merge Segments|Split Potholes|Connect Google Sheets|window\.(alert|confirm|prompt)/);
  assert.match(hub,/if \(!user \|\| !isAdmin\) return null/);
  assert.match(hub,/resolve\('confirm_distinct'\)/);
  assert.match(hub,/resolve\('reject'\)/);
  assert.doesNotMatch(hub,/resolve\('merge_evidence'\)/);
  assert.match(hub,/!reviewPhotoLoaded/);
});
test('all hub sections use existing admin guard; sending is not added', () => {
  const server = read('server.ts');
  const route = server.slice(server.indexOf("app.get('/api/admin/hub/:section'"), server.indexOf("app.get('/api/admin/email-drafts/:reportId'"));
  assert.match(route,/if \(!await requireAdmin\(req,res\)\) return/);
  assert.match(route,/Cache-Control','private, no-store'/);
  for (const section of ADMIN_SECTIONS) assert.ok(route.includes(`section === '${section.id}'`));
  const hub = read('src/views/AdminHubView.tsx');
  assert.match(hub,/Email sending is not connected yet/);
  assert.match(hub,/This report has already been submitted outside PatchUp/);
  assert.match(hub,/caseReference\.trim\(\)/);
  assert.match(hub,/I have reliable evidence that this specific pothole has been repaired/);
});

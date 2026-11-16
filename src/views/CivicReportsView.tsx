import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  FileSpreadsheet,
  GitMerge,
  Scissors,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  clearSheetsAccessToken,
  connectGoogleSheetsForExport,
  getSheetsAccessToken,
} from '../lib/firebase';
import {
  AdminAuditEvent,
  CivicReportRecord,
  JURISDICTION_LABELS,
  POTHOLE_STATUS_LABELS,
  PotholeRecord,
  REPORT_STATUS_LABELS,
  ReportStatus,
  SEGMENT_CONFIDENCE_LABELS,
  SegmentConfidence,
  StreetSegmentRecord,
} from '../lib/maps';

interface CivicReportsViewProps {
  onBack: () => void;
  onInspectPothole: (pothole: PotholeRecord) => void;
}

interface PendingSheetConfirm {
  report: CivicReportRecord;
  spreadsheetTitle: string;
  potholes: PotholeRecord[];
  totalRows: number;
}

export const CivicReportsView: React.FC<CivicReportsViewProps> = ({
  onBack,
  onInspectPothole,
}) => {
  const { user, isAdmin } = useAuth();

  const [segments, setSegments] = useState<StreetSegmentRecord[]>([]);
  const [reports, setReports] = useState<CivicReportRecord[]>([]);
  const [adminPotholes, setAdminPotholes] = useState<PotholeRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AdminAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Admin panel tabs
  const [adminSection, setAdminSection] = useState<'reports' | 'potholes' | 'corridors' | 'audit'>(
    'reports'
  );
  const [potholeFilter, setPotholeFilter] = useState<'attention' | 'all'>('attention');

  // Report submission form state keyed by reportId
  const [extRefMap, setExtRefMap] = useState<Record<string, string>>({});
  const [channelMap, setChannelMap] = useState<Record<string, string>>({});
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});

  // Segment Merge / Split state
  const [mergeSourceId, setMergeSourceId] = useState('');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeReason, setMergeReason] = useState('Consolidating adjacent corridor blocks');
  const [splitSourceId, setSplitSourceId] = useState('');
  const [splitSelectedIds, setSplitSelectedIds] = useState<string[]>([]);
  const [splitNewLabel, setSplitNewLabel] = useState('');
  const [splitReason, setSplitReason] = useState('Separating distinct road blocks');

  // Reassign state per pothole
  const [reassignTargetMap, setReassignTargetMap] = useState<Record<string, string>>({});

  // In-memory Google Sheets OAuth token indicator
  const [sheetsConnected, setSheetsConnected] = useState<boolean>(() =>
    Boolean(getSheetsAccessToken())
  );
  const [pendingSheetConfirm, setPendingSheetConfirm] = useState<PendingSheetConfirm | null>(null);
  const [exportingSheet, setExportingSheet] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      if (isAdmin && user) {
        const token = await user.getIdToken();
        const res = await fetch('/api/admin/overview', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = (await res.json()) as {
            segments?: StreetSegmentRecord[];
            reports?: CivicReportRecord[];
            potholes?: PotholeRecord[];
            auditEvents?: AdminAuditEvent[];
          };
          setSegments(data.segments ?? []);
          setReports(data.reports ?? []);
          setAdminPotholes(data.potholes ?? []);
          setAuditEvents(data.auditEvents ?? []);
          setLoading(false);
          return;
        }
      }

      const [segRes, repRes] = await Promise.all([fetch('/api/segments'), fetch('/api/reports')]);
      const segJson = (await segRes.json()) as { segments?: StreetSegmentRecord[] };
      const repJson = (await repRes.json()) as { reports?: CivicReportRecord[] };
      setSegments(segJson.segments ?? []);
      setReports(repJson.reports ?? []);
    } catch {
      setFeedback({ ok: false, text: 'Unable to load Atlanta street corridors and reports.' });
    } finally {
      setLoading(false);
    }
  }, [isAdmin, user]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const potholeById = useMemo(() => {
    const map = new Map<string, PotholeRecord>();
    for (const p of adminPotholes) {
      map.set(p.potholeId, p);
    }
    return map;
  }, [adminPotholes]);

  const filteredAdminPotholes = useMemo(() => {
    if (potholeFilter === 'all') return adminPotholes;
    return adminPotholes.filter(
      (p) =>
        p.status === 'provisional' ||
        p.segmentConfidence === 'needs_review' ||
        p.segmentConfidence === 'provisional' ||
        p.jurisdiction === 'unknown'
    );
  }, [adminPotholes, potholeFilter]);

  const splitCandidatePotholes = useMemo(() => {
    if (!splitSourceId) return [];
    return adminPotholes.filter(
      (p) => p.segmentId === splitSourceId && p.status !== 'rejected'
    );
  }, [adminPotholes, splitSourceId]);

  const handleTransitionReport = async (reportId: string, nextStatus: ReportStatus) => {
    if (!user) return;
    setBusyKey(`rep_${reportId}`);
    setFeedback(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/reports/${encodeURIComponent(reportId)}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          status: nextStatus,
          externalReference: extRefMap[reportId] || '',
          submissionChannel: channelMap[reportId] || '',
          adminReviewNotes: notesMap[reportId] || '',
          reason: `Admin transitioned report to ${nextStatus}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to update report status.');
      setFeedback({
        ok: true,
        text: data.cycleClosed
          ? `Report ${reportId} updated to ${REPORT_STATUS_LABELS[nextStatus]} and corridor cycle closed.`
          : `Report ${reportId} updated to ${REPORT_STATUS_LABELS[nextStatus]}.`,
      });
      await loadData();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Report transition failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleReviewPothole = async (
    potholeId: string,
    payload: {
      status?: string;
      jurisdiction?: 'atldot' | 'gdot' | 'unknown';
      segmentConfidence?: SegmentConfidence;
      reason: string;
    }
  ) => {
    if (!user) return;
    setBusyKey(`pot_${potholeId}`);
    setFeedback(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch(`/api/admin/potholes/${encodeURIComponent(potholeId)}/review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to update pothole.');
      setFeedback({
        ok: true,
        text:
          payload.status === 'repaired'
            ? `Marked ${potholeId} Confirmed Repaired (Community Champion badge evaluated).`
            : `Updated pothole ${potholeId} and recalculated street corridor.`,
      });
      await loadData();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Pothole review failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleReassignPothole = async (potholeId: string) => {
    if (!user) return;
    const selectedTarget = reassignTargetMap[potholeId];
    if (!selectedTarget) return;
    setBusyKey(`reassign_${potholeId}`);
    setFeedback(null);
    try {
      const token = await user.getIdToken();
      const isNew = selectedTarget === '__NEW__';
      const res = await fetch('/api/admin/segments/reassign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          potholeId,
          createNewCorridor: isNew,
          ...(isNew ? {} : { targetSegmentId: selectedTarget }),
          confidence: 'verified',
          reason: isNew
            ? 'Admin split pothole into dedicated verified corridor'
            : `Admin reassigned pothole to segment ${selectedTarget}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reassignment failed.');
      setFeedback({
        ok: true,
        text: `Pothole reassigned cleanly to ${data.newSegmentId}.`,
      });
      await loadData();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Segment reassignment failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleMergeSegments = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !mergeSourceId || !mergeTargetId) return;
    setBusyKey('merge');
    setFeedback(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/segments/merge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sourceSegmentId: mergeSourceId,
          targetSegmentId: mergeTargetId,
          reason: mergeReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Merge failed.');
      setFeedback({
        ok: true,
        text: `Merged ${data.mergedCount} potholes into ${data.targetSegmentId}.`,
      });
      setMergeSourceId('');
      await loadData();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Segment merge failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleSplitSegment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !splitSourceId || splitSelectedIds.length === 0) return;
    setBusyKey('split');
    setFeedback(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/segments/split', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          sourceSegmentId: splitSourceId,
          splitPotholeIds: splitSelectedIds,
          newCorridorLabel: splitNewLabel,
          reason: splitReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Split failed.');
      setFeedback({
        ok: true,
        text: `Created corridor ${data.newSegmentId} with ${data.movedCount} moved potholes.`,
      });
      setSplitSelectedIds([]);
      setSplitNewLabel('');
      await loadData();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Segment split failed.',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const handleConnectSheets = async () => {
    setFeedback(null);
    try {
      await connectGoogleSheetsForExport();
      setSheetsConnected(true);
      setFeedback({
        ok: true,
        text: 'Google Sheets OAuth authorized in memory for this session.',
      });
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Google Sheets authorization failed.',
      });
    }
  };

  const handleRequestSheetExport = (report: CivicReportRecord) => {
    const memberPotholes = report.snapshotPotholeIds
      .map((id) => potholeById.get(id))
      .filter((p): p is PotholeRecord => Boolean(p));

    setPendingSheetConfirm({
      report,
      spreadsheetTitle: `PatchUp Report — ${report.corridorLabel} (${report.reportId})`,
      potholes: memberPotholes,
      totalRows: 2 + memberPotholes.length,
    });
  };

  const handleConfirmSheetExport = async () => {
    if (!pendingSheetConfirm || !user) return;
    let accessToken = getSheetsAccessToken();
    if (!accessToken) {
      try {
        accessToken = await connectGoogleSheetsForExport();
        setSheetsConnected(true);
      } catch (err) {
        setFeedback({
          ok: false,
          text: err instanceof Error ? err.message : 'Google Sheets sign-in cancelled.',
        });
        setPendingSheetConfirm(null);
        return;
      }
    }

    setExportingSheet(true);
    setFeedback(null);
    try {
      const { report, spreadsheetTitle, potholes } = pendingSheetConfirm;
      const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: { title: spreadsheetTitle.slice(0, 120) },
          sheets: [{ properties: { title: 'Consolidated Packet' } }],
        }),
      });

      if (createRes.status === 401) {
        clearSheetsAccessToken();
        setSheetsConnected(false);
        throw new Error('Google Sheets OAuth token expired. Please reconnect Google Sheets.');
      }
      if (!createRes.ok) {
        const errBody = await createRes.text();
        throw new Error(`Sheets API create error (${createRes.status}): ${errBody.slice(0, 160)}`);
      }

      const created = (await createRes.json()) as {
        spreadsheetId: string;
        spreadsheetUrl: string;
      };

      const rows: (string | number)[][] = [
        [
          'Report ID',
          'Corridor',
          'Jurisdiction',
          'Cycle #',
          'Report Status',
          'Distinct Count',
          'Pothole ID',
          'Address / Street',
          'Coordinates',
          'Severity',
          'Evidence Count',
          'Contributor',
        ],
        [
          report.reportId,
          report.corridorLabel,
          JURISDICTION_LABELS[report.jurisdiction],
          report.cycleNumber,
          REPORT_STATUS_LABELS[report.status],
          report.distinctPotholeCount,
          'PACKET SUMMARY',
          report.addressRange || report.corridorLabel,
          `${report.centerLat.toFixed(5)}, ${report.centerLng.toFixed(5)}`,
          '-',
          report.supplementCount,
          report.externalReference || 'Pending Agency Ref',
        ],
        ...potholes.map((p) => [
          report.reportId,
          report.corridorLabel,
          JURISDICTION_LABELS[p.jurisdiction],
          report.cycleNumber,
          POTHOLE_STATUS_LABELS[p.status],
          1,
          p.potholeId,
          p.formattedAddress,
          `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`,
          p.severityLabel,
          p.evidenceCount,
          `@${p.primaryContributorUsername}`,
        ]),
      ];

      const range = `Consolidated Packet!A1:L${rows.length}`;
      const updateRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          created.spreadsheetId
        )}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ values: rows }),
        }
      );

      if (!updateRes.ok) {
        const errBody = await updateRes.text();
        throw new Error(`Sheets API write error (${updateRes.status}): ${errBody.slice(0, 160)}`);
      }

      const idToken = await user.getIdToken();
      await fetch(`/api/admin/reports/${encodeURIComponent(report.reportId)}/sheet-export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ spreadsheetUrl: created.spreadsheetUrl }),
      });

      setPendingSheetConfirm(null);
      setFeedback({
        ok: true,
        text: 'Exported consolidated report packet to Google Sheets and logged to Admin Audit.',
      });
      await loadData();
    } catch (err) {
      setFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Google Sheets export failed.',
      });
      setPendingSheetConfirm(null);
    } finally {
      setExportingSheet(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Honest Agency Notice */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/40 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back</span>
          </button>

          <div className="text-xs font-mono text-[#6E6978]">
            {isAdmin ? 'Admin Oversight Active' : 'Public Corridor & Report Status'}
          </div>
        </div>

        <div>
          <h1 className="font-display text-2xl sm:text-3xl font-bold text-[#2D2B35]">
            Atlanta Street Corridors & 5-Pothole Reports
          </h1>
          <p className="text-xs sm:text-sm text-[#4B4646] mt-1 max-w-3xl leading-relaxed">
            Accepted distinct potholes are grouped along physical Atlanta street corridors (up to
            600m radius). Verified corridors trigger a consolidated report packet for admin review
            once 5 distinct potholes accumulate in the active cycle.
          </p>
        </div>

        <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3.5 flex items-start gap-2.5 text-xs text-[#4B4646]">
          <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" />
          <span>
            <strong>Independent Civic Platform:</strong> PatchUp does not automatically transmit
            submissions to ATL311 or GDOT. Reports remain in{' '}
            <span className="font-mono">Awaiting Admin Review</span> or{' '}
            <span className="font-mono">Ready for Submission</span> until an admin logs a verified
            external agency case reference and submission channel.
          </span>
        </div>

        {feedback && (
          <div
            className={`rounded-xl border px-4 py-3 text-xs flex items-center justify-between gap-3 ${
              feedback.ok
                ? 'bg-[#4CB729]/10 border-[#4CB729]/30 text-[#2D2B35]'
                : 'bg-[#DC2626]/10 border-[#DC2626]/30 text-[#DC2626]'
            }`}
          >
            <span>{feedback.text}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              aria-label="Dismiss message"
              className="p-1"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </section>

      {/* Public Consolidated 5-Pothole Reports */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">
            Consolidated 5-Pothole Report Cycles ({reports.length})
          </h2>
          <span className="text-xs text-[#6E6978]">Honest workflow status</span>
        </div>

        {loading ? (
          <div className="py-8 text-xs text-[#6E6978]">Loading report packets...</div>
        ) : reports.length === 0 ? (
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
            No verified Atlanta street corridor has reached 5 distinct potholes in its current cycle
            yet. Progress counters for active corridors are shown below.
          </div>
        ) : (
          <div className="divide-y divide-[#E8DFC5]">
            {reports.map((rep) => (
              <div key={rep.reportId} className="py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="text-sm font-bold text-[#2D2B35]">{rep.corridorLabel}</div>
                  <div className="text-xs text-[#4B4646] flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[#2D2B35]">
                      {REPORT_STATUS_LABELS[rep.status]}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{JURISDICTION_LABELS[rep.jurisdiction]}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      Cycle #{rep.cycleNumber} · {rep.distinctPotholeCount} distinct
                      {rep.supplementCount > 0 ? ` (+${rep.supplementCount} supplements)` : ''}
                    </span>
                  </div>
                  {rep.externalReference && (
                    <div className="text-xs font-mono text-[#4CB729]">
                      Agency Case Ref: {rep.externalReference}
                      {rep.submissionChannel ? ` via ${rep.submissionChannel}` : ''}
                    </div>
                  )}
                </div>

                {rep.googleSheetUrl && (
                  <a
                    href={rep.googleSheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[40px] px-3 py-1.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/40 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5 shrink-0"
                  >
                    <FileSpreadsheet className="w-4 h-4 text-[#4CB729]" />
                    <span>View Exported Sheet</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Public Road-Aligned Street Corridors */}
      <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-lg font-bold text-[#2D2B35]">
            Active Street Corridors ({segments.length})
          </h2>
          <span className="text-xs text-[#6E6978]">5 distinct potholes = 1 report cycle</span>
        </div>

        {loading ? (
          <div className="py-8 text-xs text-[#6E6978]">Loading Atlanta street corridors...</div>
        ) : segments.length === 0 ? (
          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
            No active street segments recorded yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {segments.map((seg) => {
              const progressPct = Math.min(
                100,
                Math.round((seg.currentCycleDistinctCount / 5) * 100)
              );
              return (
                <div
                  key={seg.segmentId}
                  className="rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-4 space-y-2.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-[#2D2B35] truncate">
                        {seg.corridorLabel}
                      </div>
                      <div className="text-xs text-[#6E6978] mt-0.5">
                        {JURISDICTION_LABELS[seg.jurisdiction]} ·{' '}
                        {SEGMENT_CONFIDENCE_LABELS[seg.confidence]}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm font-bold text-[#2D2B35] tabular-nums">
                        {seg.currentCycleDistinctCount}/5
                      </div>
                      <div className="text-[11px] text-[#6E6978]">Cycle #{seg.currentCycleNumber}</div>
                    </div>
                  </div>

                  <div className="h-2 rounded-full bg-white border border-[#E8DFC5] overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        seg.confidence === 'verified' ? 'bg-[#4CB729]' : 'bg-[#D97706]'
                      }`}
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-[#6E6978]">
                    <span>{seg.distinctAcceptedCount} total historical potholes</span>
                    {seg.activeReportId && (
                      <span className="font-mono text-[#4CB729] font-semibold">
                        Report open: {seg.activeReportId.slice(0, 20)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Admin Oversight Workspace */}
      {isAdmin && (
        <section className="bg-white rounded-2xl border border-[#E8DFC5] p-5 sm:p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <ShieldCheck className="w-5 h-5 text-[#4CB729]" />
              <div>
                <h2 className="font-display text-lg font-bold text-[#2D2B35]">
                  Admin Civic Oversight & Verification Queue
                </h2>
                <p className="text-xs text-[#6E6978]">
                  Verify corridor confidence, review 5-pothole packets, confirm repairs, and export
                  to Google Sheets.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleConnectSheets()}
              className={`min-h-[44px] px-4 py-2 rounded-xl border text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap ${
                sheetsConnected
                  ? 'border-[#4CB729] bg-[#4CB729]/10 text-[#2D2B35]'
                  : 'border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-[#2D2B35]'
              }`}
            >
              <FileSpreadsheet className="w-4 h-4 text-[#4CB729]" />
              <span>{sheetsConnected ? 'Google Sheets Authorized (Session)' : 'Connect Google Sheets'}</span>
            </button>
          </div>

          {/* Admin Sub-tabs */}
          <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#F7F7F8] border border-[#E8DFC5] rounded-xl">
            {(
              [
                ['reports', `Report Packets (${reports.length})`],
                ['potholes', `Pothole Review (${adminPotholes.length})`],
                ['corridors', `Merge & Split (${segments.length})`],
                ['audit', `Admin Audit (${auditEvents.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setAdminSection(key)}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                  adminSection === key
                    ? 'bg-white text-[#2D2B35] shadow-xs'
                    : 'text-[#6E6978] hover:text-[#2D2B35]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {adminSection === 'reports' && (
            <div className="space-y-4">
              {reports.length === 0 ? (
                <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
                  No 5-pothole reports awaiting review yet.
                </div>
              ) : (
                reports.map((rep) => {
                  const memberPotholes = rep.snapshotPotholeIds
                    .map((id) => potholeById.get(id))
                    .filter((p): p is PotholeRecord => Boolean(p));

                  return (
                    <div
                      key={rep.reportId}
                      className="rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-4 space-y-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-bold text-[#2D2B35]">
                            {rep.corridorLabel} · Cycle #{rep.cycleNumber}
                          </div>
                          <div className="text-xs text-[#4B4646] mt-0.5">
                            Status: <strong>{REPORT_STATUS_LABELS[rep.status]}</strong> ·{' '}
                            {JURISDICTION_LABELS[rep.jurisdiction]}
                          </div>
                          {rep.evidenceMateriallyChanged && (
                            <div className="text-xs font-semibold text-[#D97706] mt-1">
                              Snapshot updated after pothole status/segment revision.
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          onClick={() => handleRequestSheetExport(rep)}
                          className="min-h-[40px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#E8DFC5]/30 text-xs font-semibold text-[#2D2B35] inline-flex items-center gap-1.5"
                        >
                          <FileSpreadsheet className="w-4 h-4 text-[#4CB729]" />
                          <span>Export to Google Sheets</span>
                        </button>
                      </div>

                      {memberPotholes.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {memberPotholes.map((p) => (
                            <button
                              key={p.potholeId}
                              type="button"
                              onClick={() => onInspectPothole(p)}
                              className="flex items-center gap-2.5 p-2 rounded-lg bg-white border border-[#E8DFC5] text-left hover:border-[#4CB729]"
                            >
                              <img
                                src={p.primaryPhotoUrl}
                                alt={p.streetName}
                                referrerPolicy="no-referrer"
                                className="w-9 h-9 rounded-md object-cover shrink-0"
                              />
                              <div className="min-w-0 text-[11px]">
                                <div className="font-semibold text-[#2D2B35] truncate">
                                  {p.formattedAddress}
                                </div>
                                <div className="text-[#6E6978] truncate">
                                  {POTHOLE_STATUS_LABELS[p.status]} · {p.severityLabel}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Status transition actions */}
                      {rep.status === 'awaiting_admin_review' && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#E8DFC5]">
                          <button
                            type="button"
                            disabled={busyKey === `rep_${rep.reportId}`}
                            onClick={() =>
                              void handleTransitionReport(rep.reportId, 'ready_for_submission')
                            }
                            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold"
                          >
                            Approve Ready for Submission
                          </button>
                          <button
                            type="button"
                            disabled={busyKey === `rep_${rep.reportId}`}
                            onClick={() =>
                              void handleTransitionReport(rep.reportId, 'unable_to_submit')
                            }
                            className="min-h-[40px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white text-xs font-semibold text-[#2D2B35]"
                          >
                            Mark Unable to Submit
                          </button>
                          <button
                            type="button"
                            disabled={busyKey === `rep_${rep.reportId}`}
                            onClick={() => void handleTransitionReport(rep.reportId, 'closed')}
                            className="min-h-[40px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white text-xs font-semibold text-[#6E6978]"
                          >
                            Close Cycle
                          </button>
                        </div>
                      )}

                      {rep.status === 'ready_for_submission' && (
                        <div className="space-y-3 pt-2 border-t border-[#E8DFC5]">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                            <input
                              type="text"
                              placeholder="External Case Ref (e.g. ATL311-2026-104)"
                              value={extRefMap[rep.reportId] ?? ''}
                              onChange={(e) =>
                                setExtRefMap((prev) => ({
                                  ...prev,
                                  [rep.reportId]: e.target.value,
                                }))
                              }
                              className="min-h-[40px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs text-[#2D2B35]"
                            />
                            <input
                              type="text"
                              placeholder="Channel (e.g. ATL311 Portal / GDOT)"
                              value={channelMap[rep.reportId] ?? ''}
                              onChange={(e) =>
                                setChannelMap((prev) => ({
                                  ...prev,
                                  [rep.reportId]: e.target.value,
                                }))
                              }
                              className="min-h-[40px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs text-[#2D2B35]"
                            />
                            <input
                              type="text"
                              placeholder="Optional admin notes"
                              value={notesMap[rep.reportId] ?? ''}
                              onChange={(e) =>
                                setNotesMap((prev) => ({
                                  ...prev,
                                  [rep.reportId]: e.target.value,
                                }))
                              }
                              className="min-h-[40px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs text-[#2D2B35]"
                            />
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={busyKey === `rep_${rep.reportId}`}
                              onClick={() => void handleTransitionReport(rep.reportId, 'submitted')}
                              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold"
                            >
                              Record External Case & Mark Submitted
                            </button>
                            <button
                              type="button"
                              disabled={busyKey === `rep_${rep.reportId}`}
                              onClick={() =>
                                void handleTransitionReport(rep.reportId, 'unable_to_submit')
                              }
                              className="min-h-[40px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white text-xs font-semibold text-[#2D2B35]"
                            >
                              Unable to Submit
                            </button>
                          </div>
                        </div>
                      )}

                      {(rep.status === 'submitted' || rep.status === 'acknowledged') && (
                        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#E8DFC5]">
                          {rep.status === 'submitted' && (
                            <button
                              type="button"
                              disabled={busyKey === `rep_${rep.reportId}`}
                              onClick={() =>
                                void handleTransitionReport(rep.reportId, 'acknowledged')
                              }
                              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#2D2B35] text-white text-xs font-semibold"
                            >
                              Mark Agency Acknowledged
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busyKey === `rep_${rep.reportId}`}
                            onClick={() => void handleTransitionReport(rep.reportId, 'resolved')}
                            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold"
                          >
                            Resolve & Open Next Cycle
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}

          {adminSection === 'potholes' && (
            <div className="space-y-4">
              <div className="inline-flex items-center gap-1 p-1 bg-[#F7F7F8] border border-[#E8DFC5] rounded-xl">
                <button
                  type="button"
                  onClick={() => setPotholeFilter('attention')}
                  className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-semibold ${
                    potholeFilter === 'attention' ? 'bg-white text-[#2D2B35]' : 'text-[#6E6978]'
                  }`}
                >
                  Needs Verification
                </button>
                <button
                  type="button"
                  onClick={() => setPotholeFilter('all')}
                  className={`min-h-[36px] px-3 py-1 rounded-lg text-xs font-semibold ${
                    potholeFilter === 'all' ? 'bg-white text-[#2D2B35]' : 'text-[#6E6978]'
                  }`}
                >
                  All Potholes ({adminPotholes.length})
                </button>
              </div>

              {filteredAdminPotholes.length === 0 ? (
                <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-5 text-xs text-[#6E6978]">
                  No potholes currently flagged for street or duplicate review.
                </div>
              ) : (
                <div className="divide-y divide-[#E8DFC5]">
                  {filteredAdminPotholes.slice(0, 30).map((p) => (
                    <div key={p.potholeId} className="py-4 space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={p.primaryPhotoUrl}
                            alt={p.streetName}
                            referrerPolicy="no-referrer"
                            className="w-12 h-12 rounded-xl object-cover border border-[#E8DFC5] shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-[#2D2B35] truncate">
                              {p.formattedAddress}
                            </div>
                            <div className="text-xs text-[#6E6978]">
                              {POTHOLE_STATUS_LABELS[p.status]} ·{' '}
                              {JURISDICTION_LABELS[p.jurisdiction]} ·{' '}
                              {p.segmentConfidence
                                ? SEGMENT_CONFIDENCE_LABELS[p.segmentConfidence]
                                : 'Unassigned'}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {p.status !== 'repaired' && (
                            <button
                              type="button"
                              disabled={busyKey === `pot_${p.potholeId}`}
                              onClick={() =>
                                void handleReviewPothole(p.potholeId, {
                                  status: 'repaired',
                                  reason: 'Admin confirmed physical repair completed',
                                })
                              }
                              className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-1"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Confirm Repaired</span>
                            </button>
                          )}

                          {p.segmentConfidence !== 'verified' && (
                            <button
                              type="button"
                              disabled={busyKey === `pot_${p.potholeId}`}
                              onClick={() =>
                                void handleReviewPothole(p.potholeId, {
                                  status: p.status === 'provisional' ? 'accepted' : p.status,
                                  jurisdiction:
                                    p.jurisdiction === 'unknown' ? 'atldot' : p.jurisdiction,
                                  segmentConfidence: 'verified',
                                  reason: 'Admin verified road corridor & jurisdiction',
                                })
                              }
                              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] hover:bg-[#E8DFC5]/50 text-xs font-semibold text-[#2D2B35]"
                            >
                              Verify Corridor
                            </button>
                          )}

                          {p.status !== 'rejected' && (
                            <button
                              type="button"
                              disabled={busyKey === `pot_${p.potholeId}`}
                              onClick={() =>
                                void handleReviewPothole(p.potholeId, {
                                  status: 'rejected',
                                  reason: 'Rejected during admin review',
                                })
                              }
                              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-[#E8DFC5] bg-white hover:bg-[#DC2626]/10 text-xs font-semibold text-[#DC2626]"
                            >
                              Reject
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Segment reassignment dropdown */}
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <select
                          value={reassignTargetMap[p.potholeId] ?? p.segmentId ?? ''}
                          onChange={(e) =>
                            setReassignTargetMap((prev) => ({
                              ...prev,
                              [p.potholeId]: e.target.value,
                            }))
                          }
                          className="min-h-[38px] px-3 rounded-lg border border-[#E8DFC5] bg-[#F7F7F8] text-xs text-[#2D2B35]"
                        >
                          <option value="">Select target segment...</option>
                          <option value="__NEW__">+ Create New Dedicated Corridor</option>
                          {segments.map((seg) => (
                            <option key={seg.segmentId} value={seg.segmentId}>
                              {seg.corridorLabel} ({seg.currentCycleDistinctCount}/5)
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={
                            busyKey === `reassign_${p.potholeId}` ||
                            !reassignTargetMap[p.potholeId] ||
                            reassignTargetMap[p.potholeId] === p.segmentId
                          }
                          onClick={() => void handleReassignPothole(p.potholeId)}
                          className="min-h-[38px] px-3 py-1.5 rounded-lg bg-[#2D2B35] text-white text-xs font-semibold disabled:opacity-40"
                        >
                          Reassign Segment
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {adminSection === 'corridors' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <form
                onSubmit={(e) => void handleMergeSegments(e)}
                className="rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-4 space-y-3"
              >
                <div className="flex items-center gap-2 text-sm font-bold text-[#2D2B35]">
                  <GitMerge className="w-4 h-4 text-[#4CB729]" />
                  <span>Merge Two Street Corridors</span>
                </div>
                <select
                  value={mergeSourceId}
                  onChange={(e) => setMergeSourceId(e.target.value)}
                  className="w-full min-h-[42px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs"
                >
                  <option value="">Source segment to fold...</option>
                  {segments.map((s) => (
                    <option key={s.segmentId} value={s.segmentId}>
                      {s.corridorLabel} ({s.distinctAcceptedCount} total)
                    </option>
                  ))}
                </select>
                <select
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  className="w-full min-h-[42px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs"
                >
                  <option value="">Target primary segment...</option>
                  {segments
                    .filter((s) => s.segmentId !== mergeSourceId)
                    .map((s) => (
                      <option key={s.segmentId} value={s.segmentId}>
                        {s.corridorLabel} ({s.currentCycleDistinctCount}/5)
                      </option>
                    ))}
                </select>
                <input
                  type="text"
                  value={mergeReason}
                  onChange={(e) => setMergeReason(e.target.value)}
                  placeholder="Audit reason for merge"
                  className="w-full min-h-[42px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs"
                />
                <button
                  type="submit"
                  disabled={!mergeSourceId || !mergeTargetId || busyKey === 'merge'}
                  className="min-h-[42px] px-4 rounded-xl bg-[#2D2B35] text-white text-xs font-semibold disabled:opacity-40"
                >
                  {busyKey === 'merge' ? 'Merging...' : 'Merge Segments'}
                </button>
              </form>

              <form
                onSubmit={(e) => void handleSplitSegment(e)}
                className="rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-4 space-y-3"
              >
                <div className="flex items-center gap-2 text-sm font-bold text-[#2D2B35]">
                  <Scissors className="w-4 h-4 text-[#4CB729]" />
                  <span>Split Potholes Into Separate Corridor</span>
                </div>
                <select
                  value={splitSourceId}
                  onChange={(e) => {
                    setSplitSourceId(e.target.value);
                    setSplitSelectedIds([]);
                  }}
                  className="w-full min-h-[42px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs"
                >
                  <option value="">Select corridor to split...</option>
                  {segments.map((s) => (
                    <option key={s.segmentId} value={s.segmentId}>
                      {s.corridorLabel} ({s.distinctAcceptedCount} total)
                    </option>
                  ))}
                </select>

                {splitCandidatePotholes.length > 0 && (
                  <div className="max-h-36 overflow-y-auto space-y-1.5 bg-white border border-[#E8DFC5] rounded-xl p-2.5">
                    {splitCandidatePotholes.map((p) => {
                      const checked = splitSelectedIds.includes(p.potholeId);
                      return (
                        <label
                          key={p.potholeId}
                          className="flex items-center gap-2 text-xs cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSplitSelectedIds((prev) =>
                                e.target.checked
                                  ? [...prev, p.potholeId]
                                  : prev.filter((id) => id !== p.potholeId)
                              );
                            }}
                            className="accent-[#4CB729]"
                          />
                          <span className="truncate">{p.formattedAddress}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                <input
                  type="text"
                  value={splitNewLabel}
                  onChange={(e) => setSplitNewLabel(e.target.value)}
                  placeholder="New corridor label (optional)"
                  className="w-full min-h-[42px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs"
                />
                <input
                  type="text"
                  value={splitReason}
                  onChange={(e) => setSplitReason(e.target.value)}
                  placeholder="Audit reason for split"
                  className="w-full min-h-[42px] px-3 rounded-xl border border-[#E8DFC5] bg-white text-xs"
                />
                <button
                  type="submit"
                  disabled={!splitSourceId || splitSelectedIds.length === 0 || busyKey === 'split'}
                  className="min-h-[42px] px-4 rounded-xl bg-[#2D2B35] text-white text-xs font-semibold disabled:opacity-40"
                >
                  {busyKey === 'split'
                    ? 'Splitting...'
                    : `Split ${splitSelectedIds.length} Selected`}
                </button>
              </form>
            </div>
          )}

          {adminSection === 'audit' && (
            <div className="divide-y divide-[#E8DFC5] rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] px-4">
              {auditEvents.length === 0 ? (
                <div className="py-5 text-xs text-[#6E6978]">No admin audit entries recorded yet.</div>
              ) : (
                auditEvents.map((ev) => (
                  <div key={ev.eventId} className="py-3 text-xs space-y-0.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-bold text-[#2D2B35]">
                        {ev.action} · {ev.targetType}/{ev.targetId}
                      </span>
                      <span className="font-mono text-[11px] text-[#6E6978]">{ev.actorEmail}</span>
                    </div>
                    <div className="text-[#4B4646]">{ev.reason}</div>
                    {(ev.beforeSummary || ev.afterSummary) && (
                      <div className="font-mono text-[11px] text-[#6E6978]">
                        {ev.beforeSummary ? `${ev.beforeSummary} → ` : ''}
                        {ev.afterSummary ?? ''}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </section>
      )}

      {/* Explicit Confirmation Modal Before Creating/Mutating Google Sheets */}
      {pendingSheetConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
        >
          <div className="max-w-md w-full bg-white rounded-2xl border border-[#E8DFC5] p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <FileSpreadsheet className="w-5 h-5 text-[#4CB729]" />
                <h3 className="font-display text-lg font-bold text-[#2D2B35]">
                  Confirm Google Sheets Export
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPendingSheetConfirm(null)}
                aria-label="Cancel export"
                className="p-1 text-[#6E6978]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-[#4B4646] leading-relaxed">
              This will create a new Google Spreadsheet in your authorized Google Workspace account
              and write the consolidated 5-pothole packet below:
            </p>

            <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] p-3.5 space-y-1.5 text-xs">
              <div>
                <span className="text-[#6E6978]">Spreadsheet Title: </span>
                <strong className="text-[#2D2B35]">{pendingSheetConfirm.spreadsheetTitle}</strong>
              </div>
              <div>
                <span className="text-[#6E6978]">Report ID: </span>
                <span className="font-mono text-[#2D2B35]">
                  {pendingSheetConfirm.report.reportId}
                </span>
              </div>
              <div>
                <span className="text-[#6E6978]">Rows to Write: </span>
                <span className="font-mono font-semibold text-[#2D2B35]">
                  {pendingSheetConfirm.totalRows} rows (header, summary, and{' '}
                  {pendingSheetConfirm.potholes.length} distinct pothole rows)
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={exportingSheet}
                onClick={() => setPendingSheetConfirm(null)}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-xs font-semibold text-[#2D2B35]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={exportingSheet}
                onClick={() => void handleConfirmSheetExport()}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold disabled:opacity-50"
              >
                {exportingSheet ? 'Creating Google Sheet...' : 'Confirm & Create Google Sheet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

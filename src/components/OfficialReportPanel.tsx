import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  Phone,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { resolveAgency } from '../lib/agencyDirectory';
import {
  buildEmailBody,
  buildEmailSubject,
  buildGmailComposeUrl,
  buildMailtoUrl,
  buildOfficialReportText,
  photoDownloadFilename,
  ReportDraftInput,
} from '../lib/reportDraft';

interface OfficialReportPanelProps {
  input: ReportDraftInput;
  /** Fired after a case record is successfully written server-side. */
  onCaseLogged?: () => void;
}

type OptionTab = 'report' | 'email';

export const OfficialReportPanel: React.FC<OfficialReportPanelProps> = ({ input, onCaseLogged }) => {
  const { user } = useAuth();
  const { agency, confirmed } = resolveAgency(input.jurisdiction);

  const [tab, setTab] = useState<OptionTab>('report');
  const [copiedReport, setCopiedReport] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const [portalOpened, setPortalOpened] = useState(false);
  const [submittedMarked, setSubmittedMarked] = useState(false);
  const [caseRef, setCaseRef] = useState('');
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logConfirmation, setLogConfirmation] = useState<string | null>(null);

  const reportText = useMemo(() => buildOfficialReportText(input), [input]);

  // Email draft — recipient is intentionally empty; PatchUp never guesses a
  // government address. The user confirms who this goes to.
  const [recipient, setRecipient] = useState('');
  const [subject, setSubject] = useState(() => buildEmailSubject(input));
  const [body, setBody] = useState(() => buildEmailBody(input));

  const copy = async (text: string, which: 'report' | 'email') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'report') {
        setCopiedReport(true);
        window.setTimeout(() => setCopiedReport(false), 2000);
      } else {
        setCopiedEmail(true);
        window.setTimeout(() => setCopiedEmail(false), 2000);
      }
    } catch {
      setDownloadError('Copy failed. Select the text and copy manually.');
    }
  };

  const downloadPhoto = async () => {
    if (!input.photoUrl) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch(input.photoUrl);
      if (!res.ok) throw new Error('Could not load the photo.');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = photoDownloadFilename(input);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Photo download failed.');
    } finally {
      setDownloading(false);
    }
  };

  const logCase = async (payload: {
    channel: 'atl311' | 'gdot' | 'email' | 'other';
    reportMethod: 'official_portal' | 'phone' | 'email';
    status: 'submitted_unconfirmed' | 'case_logged';
    externalCaseRef?: string;
  }) => {
    if (!user) return;
    setLogging(true);
    setLogError(null);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/cases/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ potholeId: input.potholeId, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save this case.');
      setLogConfirmation(
        payload.externalCaseRef
          ? `Case ${payload.externalCaseRef} saved to your record.`
          : 'Saved. Track this in My Cases.'
      );
      if (payload.status === 'submitted_unconfirmed') setSubmittedMarked(true);
      onCaseLogged?.();
    } catch (err) {
      setLogError(err instanceof Error ? err.message : 'Unable to save this case.');
    } finally {
      setLogging(false);
    }
  };

  const channelKey: 'atl311' | 'gdot' = agency.key === 'gdot' ? 'gdot' : 'atl311';

  return (
    <section className="rounded-2xl border border-[#E8DFC5] bg-white overflow-hidden">
      <header className="px-5 sm:px-6 py-4 border-b border-[#E8DFC5] bg-[#F7F7F8]">
        <div className="font-mono text-[11px] font-bold tracking-[0.12em] text-[#4CB729]">
          REPORT TO THE CITY · 04
        </div>
        <h2 className="font-display text-xl font-bold text-[#2D2B35] leading-tight mt-0.5">
          Send this to the people who can fix it
        </h2>
        <p className="text-xs text-[#6E6978] mt-1">
          Responsible agency: <span className="font-semibold text-[#2D2B35]">{agency.name}</span>.{' '}
          {agency.handles}
        </p>
        {!confirmed && (
          <div className="mt-2.5 rounded-xl bg-[#D97706]/10 border border-[#D97706]/30 px-3 py-2 text-xs text-[#2D2B35] flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" />
            <span>
              We couldn’t confirm which agency owns this road. ATL311 is the most likely City
              channel — double-check before submitting, as state routes go to GDOT.
            </span>
          </div>
        )}
      </header>

      {/* Option tabs */}
      <div className="flex gap-2 px-5 sm:px-6 pt-4">
        <button
          type="button"
          onClick={() => setTab('report')}
          className={`flex-1 min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 border transition ${
            tab === 'report'
              ? 'bg-[#4CB729] border-[#4CB729] text-white'
              : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#2D2B35] hover:bg-[#E8DFC5]/40'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>Official report</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('email')}
          className={`flex-1 min-h-[44px] px-4 py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 border transition ${
            tab === 'email'
              ? 'bg-[#4CB729] border-[#4CB729] text-white'
              : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#2D2B35] hover:bg-[#E8DFC5]/40'
          }`}
        >
          <Mail className="w-4 h-4" />
          <span>Email draft</span>
        </button>
      </div>

      {/* OPTION A — official structured report */}
      {tab === 'report' && (
        <div className="px-5 sm:px-6 py-4 space-y-4">
          <div className="rounded-xl bg-[#4CB729]/5 border border-[#4CB729]/25 px-4 py-3 text-xs text-[#4B4646] leading-relaxed">
            {agency.shortName}’s official intake is its online portal (that’s where your case number
            is created). Copy the report below, open the portal, paste it in, and attach the photo.
            PatchUp can’t submit it for you and won’t claim it did.
          </div>

          <div className="rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-3.5">
            <pre className="text-[11px] leading-relaxed text-[#2D2B35] whitespace-pre-wrap font-mono max-h-64 overflow-y-auto">
              {reportText}
            </pre>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void copy(reportText, 'report')}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#2D2B35] hover:bg-[#3A3535] text-white text-xs font-semibold inline-flex items-center gap-2"
            >
              {copiedReport ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedReport ? 'Copied' : 'Copy report'}</span>
            </button>
            {input.photoUrl && (
              <button
                type="button"
                onClick={() => void downloadPhoto()}
                disabled={downloading}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#F7F7F8] text-[#2D2B35] text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60"
              >
                {downloading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 text-[#4CB729]" />
                )}
                <span>Download photo</span>
              </button>
            )}
            <a
              href={agency.portalUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setPortalOpened(true)}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open {agency.portalLabel}</span>
            </a>
          </div>

          <div className="text-[11px] text-[#6E6978] inline-flex items-center gap-1.5">
            <Phone className="w-3.5 h-3.5" />
            <span>Prefer phone? {agency.phoneNote}</span>
          </div>

          {downloadError && (
            <div className="rounded-xl bg-[#DC2626]/10 border border-[#DC2626]/30 px-3 py-2 text-xs text-[#DC2626]">
              {downloadError}
            </div>
          )}

          {/* Confirm-and-log — only after they've opened the portal */}
          {portalOpened && (
            <div className="rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] p-4 space-y-3">
              <div className="text-xs font-semibold text-[#2D2B35]">
                Did you submit it on {agency.shortName}?
              </div>
              {!submittedMarked ? (
                <button
                  type="button"
                  onClick={() =>
                    void logCase({
                      channel: channelKey,
                      reportMethod: 'official_portal',
                      status: 'submitted_unconfirmed',
                    })
                  }
                  disabled={logging}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-[#2D2B35] hover:bg-[#3A3535] text-white text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-60"
                >
                  {logging ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  <span>Yes — I submitted this</span>
                </button>
              ) : (
                <div className="text-xs text-[#4B4646]">
                  Marked as submitted. {agency.caseNumberNote} Add it below when it arrives.
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#4B4646] block">
                  {agency.shortName} case / reference number (optional)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={caseRef}
                    maxLength={64}
                    onChange={(e) => setCaseRef(e.target.value)}
                    placeholder="e.g., 1012345678"
                    className="flex-1 min-w-[180px] min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-white text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
                  />
                  <button
                    type="button"
                    disabled={!caseRef.trim() || logging}
                    onClick={() =>
                      void logCase({
                        channel: channelKey,
                        reportMethod: 'official_portal',
                        status: 'case_logged',
                        externalCaseRef: caseRef.trim(),
                      })
                    }
                    className="min-h-[44px] px-4 py-2 rounded-xl bg-[#4CB729] hover:bg-[#3FA31F] text-white text-xs font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    {logging ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    <span>Log case number</span>
                  </button>
                </div>
                <p className="text-[11px] text-[#6E6978]">
                  This is the official agency number — kept separate from your PatchUp report ID.
                </p>
              </div>

              {logError && <div className="text-xs text-[#DC2626]">{logError}</div>}
              {logConfirmation && (
                <div className="text-xs text-[#4CB729] font-semibold inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  {logConfirmation}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* OPTION B — editable email draft */}
      {tab === 'email' && (
        <div className="px-5 sm:px-6 py-4 space-y-4">
          <div className="rounded-xl bg-[#D97706]/10 border border-[#D97706]/30 px-4 py-3 text-xs text-[#2D2B35] leading-relaxed flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" />
            <span>
              Neither ATL311 nor GDOT takes pothole reports by email — their official intake is the
              portal or phone (Official report tab). Use this draft for your own records or to
              forward to a representative you choose. <strong>PatchUp never fills in a government
              email for you</strong>; enter the recipient yourself.
            </span>
          </div>

          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-[#4B4646]">To (you confirm the recipient)</span>
              <input
                type="email"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="name@example.gov"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-[#4B4646]">Subject</span>
              <input
                type="text"
                value={subject}
                maxLength={160}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full min-h-[44px] px-3.5 py-2 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-sm text-[#2D2B35] focus:outline-2 focus:outline-[#4CB729]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-semibold text-[#4B4646]">Message</span>
              <textarea
                rows={10}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#E8DFC5] bg-[#F7F7F8] text-xs text-[#2D2B35] font-mono leading-relaxed focus:outline-2 focus:outline-[#4CB729]"
              />
            </label>
          </div>

          <div className="rounded-xl bg-[#F7F7F8] border border-[#E8DFC5] px-3.5 py-2.5 text-[11px] text-[#6E6978]">
            Heads up: the compose link can’t attach your photo automatically. Download it from the
            Official report tab and attach it before sending.
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={
                recipient.trim()
                  ? buildGmailComposeUrl(recipient, subject, body)
                  : undefined
              }
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!recipient.trim()}
              onClick={(e) => {
                if (!recipient.trim()) e.preventDefault();
              }}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 ${
                recipient.trim()
                  ? 'bg-[#4CB729] hover:bg-[#3FA31F] text-white'
                  : 'bg-[#E8DFC5]/60 text-[#9A948A] cursor-not-allowed'
              }`}
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open in Gmail</span>
            </a>
            <a
              href={recipient.trim() ? buildMailtoUrl(recipient, subject, body) : undefined}
              aria-disabled={!recipient.trim()}
              onClick={(e) => {
                if (!recipient.trim()) e.preventDefault();
              }}
              className={`min-h-[44px] px-4 py-2 rounded-xl text-xs font-semibold inline-flex items-center gap-2 border ${
                recipient.trim()
                  ? 'bg-white border-[#E8DFC5] text-[#2D2B35] hover:bg-[#F7F7F8]'
                  : 'bg-[#F7F7F8] border-[#E8DFC5] text-[#9A948A] cursor-not-allowed'
              }`}
            >
              <Mail className="w-4 h-4 text-[#4CB729]" />
              <span>Open mail app</span>
            </a>
            <button
              type="button"
              onClick={() => void copy(`To: ${recipient}\nSubject: ${subject}\n\n${body}`, 'email')}
              className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E8DFC5] bg-white hover:bg-[#F7F7F8] text-[#2D2B35] text-xs font-semibold inline-flex items-center gap-2"
            >
              {copiedEmail ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedEmail ? 'Copied' : 'Copy email'}</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

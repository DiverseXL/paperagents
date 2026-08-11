"use client";

import type { AnalysisReport, VerifiedClaim } from "@/lib/agents/types";
import { formatCost } from "@/lib/pipeline-reducer";

interface ReportViewProps {
  report: AnalysisReport;
  exporting: boolean;
  exportError: string | null;
  onExport: () => void;
}

const STATUS_STAMP: Record<VerifiedClaim["status"], string> = {
  supported: "stamp--green",
  unsupported: "stamp--red",
  fabricated: "stamp--red",
  unclear: "stamp--gray",
};

const STATUS_META: Record<VerifiedClaim["status"], { tone: string; note: string }> = {
  supported: { tone: "text-accent-green", note: "Source text backs this up" },
  unsupported: { tone: "text-accent-red", note: "No source text backs this up" },
  fabricated: { tone: "text-accent-red", note: "Attributed to a source that does not contain it" },
  unclear: { tone: "text-muted-ink", note: "Evidence could not be resolved" },
};

function filedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

export default function ReportView({
  report,
  exporting,
  exportError,
  onExport,
}: ReportViewProps) {
  const { costSummary } = report;

  return (
    <section aria-labelledby="verdict-heading">
      {/* ── Section header + export ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="hidden h-px w-10 bg-hairline sm:block" />
          <h2
            id="verdict-heading"
            className="font-mono text-[0.6875rem] uppercase tracking-[0.3em] text-muted-ink"
          >
            The Verdict · Filed {filedAt(report.generatedAt)}
          </h2>
          <span className="hidden h-px w-10 bg-hairline sm:block" />
        </div>
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 border-2 border-ink bg-paper px-5 py-2.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-ink transition-colors duration-200 hover:bg-ink hover:text-paper disabled:cursor-wait disabled:opacity-50 disabled:hover:bg-paper disabled:hover:text-ink motion-reduce:transition-none sm:w-auto"
        >
          {exporting ? "Setting type…" : "↓ Download Report (PDF)"}
        </button>
      </div>

      {exportError ? (
        <p className="mt-2 text-right font-mono text-[0.625rem] uppercase tracking-[0.18em] text-accent-red">
          {exportError}
        </p>
      ) : null}

      {/* ── Data-quality disclosure — a caution, not an error ───────── */}
      {/* Optional-chained so a stale report lacking the field still renders. */}
      {report.dataQualityNotes?.length ? (
        <aside
          aria-label="Data quality notice"
          className="mt-5 border-2 border-ink bg-paper p-5 sm:p-6"
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink font-mono text-xs font-bold leading-none text-ink"
            >
              !
            </span>
            <h3 className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.25em] text-ink">
              A note on this run&rsquo;s data quality
            </h3>
          </div>
          <ul className="mt-3 space-y-1.5">
            {report.dataQualityNotes.map((note, i) => (
              <li key={i} className="flex gap-3 text-[0.9375rem] leading-6 text-ink/85">
                <span aria-hidden="true" className="font-mono text-muted-ink">
                  —
                </span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      {/* ── The Historian — what changed since the last run ─────────── */}
      {/* Present only when a prior saved analysis of the same paper/claim
          exists. Sits between the data-quality note and the consensus. */}
      {report.historianBriefing ? (
        <HistorianBriefingView briefing={report.historianBriefing} />
      ) : null}

      {/* ── The Cross-Examiner — where the evidence disagrees ──────── */}
      {/* Present only when the run had enough cross-source evidence to examine.
          Conflicts are rendered as a full section; an honest "no conflicts"
          (or a processing-error fallback) renders as a one-line note using the
          agent's own summary text. */}
      {report.crossExamination ? (
        report.crossExamination.conflicts.length > 0 ? (
          <section
            aria-labelledby="cross-examination-heading"
            className="mt-5 border-y-2 border-ink bg-paper py-6 sm:py-8"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-ink bg-paper font-display text-sm font-black text-ink">
                  ≠
                </span>
                <div>
                  <h3
                    id="cross-examination-heading"
                    className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.25em] text-ink"
                  >
                    Where the Evidence Disagrees
                  </h3>
                  <p className="mt-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
                    {report.crossExamination.conflicts.length} conflict
                    {report.crossExamination.conflicts.length === 1 ? "" : "s"} between sources
                  </p>
                </div>
              </div>
              <span aria-hidden="true" className="stamp stamp--gray">
                Cross-Examiner
              </span>
            </div>

            <div className="mt-5 divide-y divide-hairline border-y border-hairline">
              {report.crossExamination.conflicts.map((conflict, i) => (
                <EvidenceConflictRow key={i} conflict={conflict} index={i + 1} />
              ))}
            </div>
          </section>
        ) : (
          <p className="mt-5 border border-hairline bg-paper px-4 py-3 text-[0.8125rem] leading-5 text-ink/70">
            Cross-Examiner: {report.crossExamination.summary}
          </p>
        )
      ) : null}

      {/* ── Consensus — the chat-completion style block ──────────────── */}
      <div className="mt-5 rounded-lg border-2 border-ink bg-surface p-6 shadow-[5px_5px_0_var(--shadow-ink)] sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-ink bg-ink font-display text-sm font-black text-paper">
              S
            </span>
            <div>
              <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.25em] text-ink">
                The Synthesizer
              </p>
              <p className="mt-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
                Final dispatch · {report.claims.length} claim
                {report.claims.length === 1 ? "" : "s"} on the record
              </p>
            </div>
          </div>
          <span aria-hidden="true" className="stamp stamp--gray hidden sm:inline-block">
            Chat completion
          </span>
        </div>

        <p className="mt-5 whitespace-pre-wrap font-display text-lg italic leading-8 text-ink sm:text-xl sm:leading-9">
          {report.consensus}
        </p>

        <div className="mt-6 border-t border-hairline pt-4">
          <p className="font-mono text-[0.5625rem] uppercase tracking-[0.25em] text-muted-ink">
            Where the evidence runs out
          </p>
          {report.gaps.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {report.gaps.map((gap, i) => (
                <li key={i} className="flex gap-3 text-[0.9375rem] leading-6 text-ink/85">
                  <span aria-hidden="true" className="font-mono text-muted-ink">
                    —
                  </span>
                  <span>{gap}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 font-mono text-xs uppercase tracking-[0.18em] text-accent-green">
              No unresolved gaps
            </p>
          )}
        </div>
      </div>

      {/* ── Claim-by-claim breakdown ─────────────────────────────────── */}
      <div className="mt-8 border-y-2 border-ink">
        {report.claims.length === 0 ? (
          <p className="px-1 py-8 text-center font-mono text-xs uppercase tracking-[0.25em] text-muted-ink">
            No attributed claims were found in the text
          </p>
        ) : (
          report.claims.map((claim, i) => (
            <ClaimRow key={claim.id} claim={claim} index={i + 1} />
          ))
        )}
      </div>

      {/* ── Cost summary ─────────────────────────────────────────────── */}
      <div className="mt-8">
        <div className="flex items-center gap-4">
          <span className="h-px flex-1 bg-hairline" />
          <h3 className="font-mono text-[0.6875rem] uppercase tracking-[0.3em] text-muted-ink">
            The Bill
          </h3>
          <span className="h-px flex-1 bg-hairline" />
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[32rem] border-collapse font-mono text-xs">
            <thead>
              <tr className="text-left text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
                <th className="border-b border-ink py-2 pr-4 font-medium">Agent</th>
                <th className="border-b border-ink py-2 pr-4 font-medium">Cache tier</th>
                <th className="border-b border-ink py-2 pr-4 text-right font-medium">Benchmark</th>
                <th className="border-b border-ink py-2 text-right font-medium">You pay</th>
              </tr>
            </thead>
            <tbody>
              {costSummary.perAgent.map((entry) => (
                <tr key={entry.agent} className="text-ink/85">
                  <td className="border-b border-hairline py-2.5 pr-4 capitalize">{entry.agent}</td>
                  <td className="border-b border-hairline py-2.5 pr-4 text-muted-ink">
                    {entry.cacheTier ?? "—"}
                  </td>
                  <td className="border-b border-hairline py-2.5 pr-4 text-right tabular-nums">
                    {formatCost(entry.benchmarkCost)}
                  </td>
                  <td className="border-b border-hairline py-2.5 text-right tabular-nums">
                    {formatCost(entry.customerCharge)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold text-ink">
                <td className="py-2.5 pr-4 uppercase tracking-[0.15em]">Total</td>
                <td className="py-2.5 pr-4" />
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {formatCost(costSummary.totalBenchmarkCost)}
                </td>
                <td className="py-2.5 text-right tabular-nums">
                  {formatCost(costSummary.totalCustomerCharge)}
                </td>
              </tr>
              <tr className="text-accent-green">
                <td className="py-2.5 pr-4 uppercase tracking-[0.15em]">Saved</td>
                <td className="py-2.5 pr-4" />
                <td className="py-2.5 pr-4" />
                <td className="py-2.5 text-right tabular-nums">
                  {formatCost(costSummary.totalSaved)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function EvidenceConflictRow({
  conflict,
  index,
}: {
  conflict: NonNullable<AnalysisReport["crossExamination"]>["conflicts"][number];
  index: number;
}) {
  const direct = conflict.severity === "direct_contradiction";

  return (
    <article className="py-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <p className="min-w-0 text-[0.95rem] font-medium leading-6 text-ink">
          <span className="mr-2 font-mono text-xs text-muted-ink">
            {String(index).padStart(2, "0")}
          </span>
          {conflict.claimText}
        </p>
        <span
          className={`shrink-0 stamp ${direct ? "stamp--red" : "stamp--gray"}`}
        >
          {conflict.severity === "direct_contradiction"
            ? "Direct contradiction"
            : "Partial disagreement"}
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {conflict.conflictingSources.map((source, i) => (
          <figure key={i} className="border border-hairline bg-paper p-4">
            <figcaption className="font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-muted-ink">
              <span className="mr-1.5 text-ink">S{i + 1}</span>
              <span className="max-w-[80%] truncate align-middle" title={source.sourceTitle}>
                {source.sourceTitle}
              </span>
              {source.position ? (
                <span className="ml-2">· {source.position}</span>
              ) : null}
            </figcaption>
            <blockquote className="mt-2.5 border-l-2 border-ink pl-3 font-display text-[0.85rem] italic leading-6 text-ink/85">
              “{source.excerpt}”
            </blockquote>
          </figure>
        ))}
      </div>
    </article>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function HistorianBriefingView({ briefing }: { briefing: NonNullable<AnalysisReport["historianBriefing"]> }) {
  // Absent matchQuality means the briefing predates the field — render normally.
  const inconclusive = briefing.matchQuality === "no_overlap_found";
  const changed = briefing.claimChanges.filter((c) => c.changeType !== "no_change");
  const unchanged = briefing.claimChanges.length - changed.length;

  return (
    <section
      aria-labelledby="historian-heading"
      className="mt-5 border-y-2 border-ink bg-paper py-6 sm:py-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-ink bg-paper font-display text-sm font-black text-ink">
            H
          </span>
          <div>
            <h3
              id="historian-heading"
              className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.25em] text-ink"
            >
              Since Last Time
            </h3>
            <p className="mt-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
              The desk&rsquo;s records · filed {filedAt(briefing.priorAnalyzedAt)}
            </p>
          </div>
        </div>
        {inconclusive ? (
          <span className="stamp stamp--gray">Comparison inconclusive</span>
        ) : (
          <span aria-hidden="true" className="stamp stamp--gray">
            Historian
          </span>
        )}
      </div>

      {inconclusive ? (
        <p className="mt-4 flex items-start gap-2 border border-hairline bg-paper px-4 py-3 font-mono text-[0.625rem] uppercase leading-5 tracking-[0.18em] text-muted-ink">
          <span aria-hidden="true" className="mt-px">⚠</span>
          <span>
            The two runs&rsquo; claims did not overlap closely enough to compare
            directly — this is not a confirmed “unchanged”.
          </span>
        </p>
      ) : null}

      <p className="mt-5 whitespace-pre-wrap font-display text-lg italic leading-8 text-ink sm:text-xl sm:leading-9">
        {briefing.summary}
      </p>

      {briefing.claimChanges.length > 0 ? (
        <div className="mt-6">
          <p className="font-mono text-[0.5625rem] uppercase tracking-[0.25em] text-muted-ink">
            Claim by claim · {changed.length} changed, {unchanged} unchanged
          </p>
          <ul className="mt-2 divide-y divide-hairline border-y border-hairline">
            {briefing.claimChanges.map((change, i) => (
              <li
                key={i}
                className="flex flex-col gap-2.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
              >
                <p className="min-w-0 text-sm leading-6 text-ink/85 [text-wrap:pretty]">
                  <span className="mr-2 font-mono text-xs text-muted-ink">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {truncate(change.claimText, 160)}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    className={`stamp ${
                      STATUS_STAMP[change.previousStatus as VerifiedClaim["status"]] ?? "stamp--gray"
                    }`}
                  >
                    {change.previousStatus}
                  </span>
                  <span aria-hidden="true" className="font-mono text-xs text-muted-ink">
                    →
                  </span>
                  <span
                    className={`stamp ${
                      STATUS_STAMP[change.currentStatus as VerifiedClaim["status"]] ?? "stamp--gray"
                    }`}
                  >
                    {change.currentStatus}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {briefing.newSourcesFound + briefing.sourcesNoLongerFound > 0 ? (
        <p className="mt-4 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
          Sources on file: +{briefing.newSourcesFound} new · −
          {briefing.sourcesNoLongerFound} no longer found
        </p>
      ) : null}
    </section>
  );
}

function ClaimRow({ claim, index }: { claim: VerifiedClaim; index: number }) {
  const meta = STATUS_META[claim.status];

  return (
    <article className="border-b border-hairline px-1 py-6 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-[0.95rem] font-medium leading-6 text-ink sm:max-w-[70%]">
          <span className="mr-2 font-mono text-xs text-muted-ink">
            {String(index).padStart(2, "0")}
          </span>
          {claim.text}
        </p>
        <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
          <span className={`stamp ${STATUS_STAMP[claim.status]}`}>{claim.status}</span>
          <span className={`font-mono text-[0.5625rem] uppercase tracking-[0.15em] ${meta.tone}`}>
            {meta.note}
          </span>
        </div>
      </div>

      {claim.evidenceQuote ? (
        <blockquote className="mt-4 border-l-2 border-ink pl-4 font-display text-[0.925rem] italic leading-7 text-ink/85">
          “{claim.evidenceQuote}”
        </blockquote>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1.5 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-muted-ink">
        {claim.matchedSource ? (
          <span className="max-w-[26rem] truncate" title={claim.matchedSource}>
            Source: {claim.matchedSource}
          </span>
        ) : null}
        <span>Confidence: {Math.round(claim.confidence * 100)}%</span>
        {claim.citedAs ? <span>Cited as: {claim.citedAs}</span> : null}
      </div>

      {claim.reasoning ? (
        <p className="mt-3 max-w-3xl text-sm leading-6 text-ink/70">{claim.reasoning}</p>
      ) : null}
    </article>
  );
}

"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import AgentPane from "@/components/AgentPane";
import CostMeter from "@/components/CostMeter";
import InputForm from "@/components/InputForm";
import ReportView from "@/components/ReportView";
import ThemeToggle from "@/components/ThemeToggle";
import type {
  AnalysisReport,
  ClaimGraphEntry,
  ClaimStatus,
} from "@/lib/agents/types";
import {
  INITIAL_STATE,
  pipelineReducer,
  type LogEntry,
} from "@/lib/pipeline-reducer";

function timeOf(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
}

const LOG_TONE: Record<string, string> = {
  started: "font-semibold text-ink",
  streaming: "text-muted-ink",
  done: "text-accent-green",
  error: "text-accent-red",
};

/**
 * Live Claim Graph badge — renders one claim's lifecycle status as it moves
 * through the constrained multi-agent system. Statuses come from the server's
 * claim-graph SSE snapshots, not from the local report.
 */
const GRAPH_STATUS_STAMP: Record<ClaimStatus, string> = {
  pending: "stamp--gray",
  under_challenge: "stamp--red",
  survived: "stamp--green",
  falsified: "stamp--red",
  unverifiable: "stamp--gray",
};

function ClaimBadge({ entry }: { entry: ClaimGraphEntry }) {
  const label =
    entry.graphStatus === "under_challenge"
      ? "UNDER CHALLENGE"
      : entry.graphStatus.toUpperCase();
  return (
    <span
      title={entry.text}
      className="flex max-w-full items-center gap-2 border border-hairline bg-paper px-2.5 py-1.5"
    >
      <span className="shrink-0 font-mono text-[0.5625rem] uppercase tracking-[0.12em] text-muted-ink">
        {entry.id}
      </span>
      <span
        className={`stamp ${GRAPH_STATUS_STAMP[entry.graphStatus]}`}
        aria-label={`${entry.id}: ${label}`}
      >
        {label}
      </span>
      <span className="min-w-0 truncate font-mono text-[0.625rem] leading-4 text-ink/70">
        {entry.text}
      </span>
    </span>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const costBits: string[] = [];
  if (entry.benchmarkCost != null)
    costBits.push(`bench=$${entry.benchmarkCost.toFixed(6)}`);
  if (entry.customerCharge != null)
    costBits.push(`charge=$${entry.customerCharge.toFixed(6)}`);
  if (entry.cacheTier != null) costBits.push(`tier=${entry.cacheTier}`);

  const tone = LOG_TONE[entry.status] ?? "text-muted-ink";

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-[3px] leading-6">
      <span className="shrink-0 font-mono text-[0.625rem] text-muted-ink/80">
        {timeOf(entry.timestamp)}
      </span>
      <span className={`shrink-0 font-mono text-[0.6875rem] uppercase tracking-[0.12em] ${tone}`}>
        [{entry.agent}] {entry.status}
      </span>
      <span className="min-w-0 flex-1 font-mono text-[0.8125rem] leading-6 text-ink/90 sm:text-xs">
        {entry.message}
      </span>
      {costBits.length > 0 ? (
        <span className="font-mono text-[0.625rem] text-muted-ink">
          ↳ {costBits.join("  ")}
        </span>
      ) : null}
    </div>
  );
}

export default function AnalyzePage() {
  const [state, dispatch] = useReducer(pipelineReducer, INITIAL_STATE);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const running = state.phase === "running";

  // Auto-scroll the live feed to the newest event.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.log.length]);

  // Abort any in-flight stream when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Reopen-restore: on mount, ask the desk for the last saved analysis and
  // populate the final-report state as if it had just finished. A 404 (no
  // saved record) or a fetch failure simply leaves the empty input state.
  // didRestoreRef guards against React StrictMode double-invoking effects.
  const didRestoreRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/analyze/api/session");
        if (!res.ok) return;
        const report = (await res.json()) as AnalysisReport | null;
        if (cancelled || !report || didRestoreRef.current) return;
        didRestoreRef.current = true;
        dispatch({
          type: "event",
          event: {
            agent: "orchestrator",
            status: "done",
            message: "Restored the last saved analysis from the desk's records",
            report,
            timestamp: report.generatedAt,
          },
        });
      } catch {
        // session endpoint unavailable — start from the empty input state
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAnalyze = useCallback(async (input: string, file: File | null) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    dispatch({ type: "start" });
    setExportError(null);

    const formData = new FormData();
    formData.append("input", input);
    if (file) formData.append("file", file);

    try {
      const res = await fetch("/analyze/api/run", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let message = `The desk rejected the request (HTTP ${res.status}).`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // non-JSON error body — keep the generic message
        }
        dispatch({ type: "fail", message });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let verdictFiled = false; // set once the stream files done/error

      // Manual SSE parsing — EventSource can't POST or upload files.
      function handleFrame(rawEvent: string) {
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data: ")) continue; // skips heartbeats
          try {
            const event = JSON.parse(line.slice("data: ".length));
            if (
              event.agent === "orchestrator" &&
              (event.status === "done" || event.status === "error")
            ) {
              verdictFiled = true;
            }
            dispatch({ type: "event", event });
          } catch {
            // malformed frame — ignore rather than crash the page
          }
        }
      }

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let separator: number;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          handleFrame(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
        }
      }

      // Flush any trailing bytes, then fail if the stream went silent
      // without a verdict (proxy death, mid-stream truncation).
      buffer += decoder.decode();
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        handleFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
      }

      if (!controller.signal.aborted && !verdictFiled) {
        dispatch({
          type: "fail",
          message: "The stream ended before a verdict was filed.",
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return; // superseded by a new run/unmount
      dispatch({
        type: "fail",
        message:
          err instanceof Error
            ? err.message
            : "The analysis stream broke before a verdict.",
      });
    }
  }, []);

  const handleExport = useCallback(async () => {
    if (!state.report) return;
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/analyze/api/export-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.report),
      });
      if (!res.ok) {
        let message = `The press failed (HTTP ${res.status}).`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // keep generic message
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `paperagents-report-${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : "Could not set the report to print."
      );
    } finally {
      setExporting(false);
    }
  }, [state.report]);

  return (
    <div className="flex min-h-full flex-col bg-paper font-sans text-ink">
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 sm:px-10">
        {/* ── Masthead ─────────────────────────────────────────────────── */}
        <header>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-y border-hairline py-1.5 font-mono text-[0.625rem] uppercase tracking-[0.25em] text-muted-ink sm:text-[0.6875rem]">
            <Link
              href="/"
              className="hit-area py-2 transition-colors hover:text-ink"
            >
              ← Front page
            </Link>
            <span className="hidden sm:inline">The Citation Verification Desk</span>
            <span className="flex items-center gap-3">
              <span>Desk No. 002</span>
              <ThemeToggle />
            </span>
          </div>

          <h1 className="mt-6 text-center font-display text-[clamp(2rem,6vw,3.75rem)] font-black leading-none tracking-[-0.02em] sm:mt-8">
            File a Claim
          </h1>

          <div className="mt-5 h-px w-full bg-ink" />
          <p className="mt-3 text-center font-mono text-[0.625rem] uppercase tracking-[0.3em] text-muted-ink sm:text-xs">
            Retriever → Extractor → Falsifier → Synthesizer · Live Dispatch
          </p>
          <div className="mt-4 h-px w-full bg-hairline" />
        </header>

        {/* ── Input section ────────────────────────────────────────────── */}
        <section aria-labelledby="input-heading" className="pt-10 sm:pt-12">
          <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
            <div>
              <p className="font-mono text-[0.5625rem] uppercase tracking-[0.25em] text-muted-ink">
                Exhibit A
              </p>
              <h2
                id="input-heading"
                className="mt-2 max-w-2xl font-display text-3xl font-bold leading-tight tracking-[-0.015em] sm:text-4xl"
              >
                Hand the desk a claim.{" "}
                <em className="italic">It will check the sources.</em>
              </h2>
            </div>

            {state.report ? (
              <button
                type="button"
                onClick={() => dispatch({ type: "reset" })}
                className="inline-flex min-h-11 items-center gap-2 border-2 border-ink bg-paper px-5 py-2.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.22em] text-ink transition-colors duration-200 hover:bg-ink hover:text-paper motion-reduce:transition-none"
              >
                <span aria-hidden="true">⟲</span> New Analysis
              </button>
            ) : null}
          </div>

          <div className="mt-7">
            <InputForm running={running} onAnalyze={handleAnalyze} />
          </div>
        </section>

        {/* ── Pipeline + cost meter ────────────────────────────────────── */}
        <section
          aria-labelledby="pipeline-heading"
          aria-busy={running}
          className="mt-12 border-y-2 border-ink py-6 sm:mt-14"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2
              id="pipeline-heading"
              className="font-mono text-[0.6875rem] uppercase tracking-[0.3em] text-muted-ink"
            >
              The Pipeline
            </h2>
            <CostMeter
              benchmarkCost={state.benchmarkCost}
              customerCharge={state.customerCharge}
            />
          </div>

          <div className="mt-7">
            <AgentPane nodes={state.nodes} />
          </div>
        </section>

        {/* ── Live Claim Graph badges ─────────────────────────────────── */}
        {/* The shared state agents communicate through, shown as it moves:
            PENDING → UNDER CHALLENGE → SURVIVED / FALSIFIED / UNVERIFIABLE. */}
        {state.phase !== "idle" && state.claimGraph && state.claimGraph.length > 0 ? (
          <section aria-labelledby="claim-graph-heading" className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2
                id="claim-graph-heading"
                className="font-mono text-[0.6875rem] uppercase tracking-[0.3em] text-muted-ink"
              >
                The Claim Graph
              </h2>
              <span className="font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-muted-ink">
                PENDING → UNDER CHALLENGE → SURVIVED / FALSIFIED / UNVERIFIABLE
              </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 border-2 border-ink bg-paper px-4 py-3">
              {state.claimGraph.map((entry) => (
                <ClaimBadge key={entry.id} entry={entry} />
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Live agent log ───────────────────────────────────────────── */}
        {state.phase !== "idle" ? (
          <section aria-labelledby="feed-heading" className="mt-8">
            <div className="flex items-center justify-between">
              <h2
                id="feed-heading"
                className="font-mono text-[0.6875rem] uppercase tracking-[0.3em] text-muted-ink"
              >
                Live Despatch
              </h2>
              <span className="font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
                {state.log.length} event{state.log.length === 1 ? "" : "s"} on the wire
              </span>
            </div>
            <div
              ref={logRef}
              aria-live="polite"
              className="feed-scroll mt-3 h-64 overflow-y-auto border-2 border-ink bg-paper px-4 py-3"
            >
              {state.log.map((entry) => (
                <LogLine key={entry.id} entry={entry} />
              ))}
              {running ? (
                <span aria-hidden="true" className="log-cursor text-ink">
                  ▮
                </span>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* ── Error state ──────────────────────────────────────────────── */}
        {state.phase === "error" ? (
          <section
            role="alert"
            aria-labelledby="error-heading"
            className="mt-10 border-2 border-accent-red bg-paper p-6 sm:p-8"
          >
            <p
              id="error-heading"
              className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.3em] text-accent-red"
            >
              ✕ The desk has no verdict
            </p>
            <p className="mt-3 max-w-3xl text-[0.9375rem] leading-6 text-ink/85 sm:text-base sm:leading-7">
              {state.error}
            </p>
            <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-[0.2em] text-muted-ink">
              Fix the input and file again — or check the sources below the line
            </p>
          </section>
        ) : null}

        {/* ── Final report ─────────────────────────────────────────────── */}
        {state.report ? (
          <div className="mt-14 sm:mt-16">
            <ReportView
              report={state.report}
              exporting={exporting}
              exportError={exportError}
              onExport={handleExport}
            />
          </div>
        ) : null}
      </main>

      {/* ── Wire-service credit ────────────────────────────────────────── */}
      <footer className="mt-16 border-t border-hairline">
        <div className="mx-auto w-full max-w-6xl px-5 py-8 text-center sm:px-10">
          <p className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-ink sm:text-[0.6875rem] sm:tracking-[0.25em]">
            PaperAgents · Cross-verified via arXiv, Semantic Scholar &amp; OpenAlex
          </p>
          <p className="mt-3 font-mono text-[0.5625rem] uppercase tracking-[0.16em] text-muted-ink sm:tracking-[0.25em]">
            Every verdict stamped by evidence, not reputation
          </p>
        </div>
      </footer>
    </div>
  );
}

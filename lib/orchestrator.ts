import { runRetriever } from "./agents/retriever";
import { runExtractor } from "./agents/extractor";
import { runVerifier } from "./agents/verifier";
import { runSynthesizer } from "./agents/synthesizer";
import { runCrossExaminer } from "./agents/cross-examiner";
import { findPriorAnalysis } from "./db";
import { generateHistorianBriefing } from "./historian";
import {
  AgentEvent,
  AgentRole,
  AnalysisReport,
  CrossExaminationResult,
  ExtractedClaim,
  FULL_DOCUMENT_SOURCE_LABEL,
  RetrievedSource,
  VerifiedClaim,
} from "./agents/types";

interface CostEntry {
  agent: AgentRole;
  benchmarkCost: number;
  customerCharge: number;
  cacheTier: string | null;
}

/**
 * ── Data-quality disclosure layer ────────────────────────────────────────
 * Pure observation: tracks degraded conditions by reading the existing event
 * stream (no agent logic, prompts, grounding checks, or retry behavior is
 * changed). The retriever's query-generation failure is silent by existing
 * design (console.warn only) and so is not observable here.
 */
type SourceKey = "arxiv" | "semanticScholar" | "openalex";

interface QualityTracker {
  /** Result counts per source, one entry per query event. */
  queryCounts: Record<SourceKey, number[]>;
  /** Sources that errored for at least one query ("X unavailable for …"). */
  sourceUnavailable: Set<SourceKey>;
  /** Sources found by the targeted arXiv title search (null = not run). */
  titleSearchFound: number | null;
  extractorRetried: boolean;
  /** Agent role names that emitted a timed-out error event. */
  timedOutAgents: Set<string>;
}

function createQualityTracker(): QualityTracker {
  return {
    queryCounts: { arxiv: [], semanticScholar: [], openalex: [] },
    sourceUnavailable: new Set(),
    titleSearchFound: null,
    extractorRetried: false,
    timedOutAgents: new Set(),
  };
}

const SOURCE_KEY_BY_NAME: Record<string, SourceKey> = {
  arXiv: "arxiv",
  "Semantic Scholar": "semanticScholar",
  OpenAlex: "openalex",
};

const SOURCE_NAME_BY_KEY: Record<SourceKey, string> = {
  arxiv: "arXiv",
  semanticScholar: "Semantic Scholar",
  openalex: "OpenAlex",
};

const AGENT_DISPLAY_NAME: Record<AgentRole, string> = {
  retriever: "Retriever",
  extractor: "Extractor",
  verifier: "Verifier",
  synthesizer: "Synthesizer",
};

/** Collects one event's worth of observable degradation facts. */
function trackDataQualityEvent(tracker: QualityTracker, event: AgentEvent): void {
  const msg = event.message ?? "";

  // Per-query source result counts, e.g.
  //   Query "attention" -> arxiv: 3, semanticScholar: 3, openalex: 3
  const countMatch = msg.match(
    /^Query ".*" -> arxiv: (\d+), semanticScholar: (\d+), openalex: (\d+)$/
  );
  if (countMatch) {
    tracker.queryCounts.arxiv.push(Number(countMatch[1]));
    tracker.queryCounts.semanticScholar.push(Number(countMatch[2]));
    tracker.queryCounts.openalex.push(Number(countMatch[3]));
    return;
  }

  // A source errored for a query, e.g. "arXiv unavailable for \"q\" — …".
  const unavailableMatch = msg.match(/^(arXiv|Semantic Scholar|OpenAlex) unavailable/);
  if (unavailableMatch) {
    const key = SOURCE_KEY_BY_NAME[unavailableMatch[1]];
    if (key) tracker.sourceUnavailable.add(key);
    return;
  }

  // Targeted title search outcome (PDF runs only).
  const titleFound = msg.match(/^Title search for ".*" found (\d+) sources?$/);
  if (titleFound) {
    tracker.titleSearchFound = Number(titleFound[1]);
    return;
  }
  if (/^Title search for ".*" failed/.test(msg)) {
    tracker.titleSearchFound = 0;
    return;
  }

  // Extractor retry after malformed JSON on the first attempt.
  if (msg.includes("Retrying claim extraction after malformed JSON response")) {
    tracker.extractorRetried = true;
    return;
  }

  // Any agent call that hit its timeout surfaces as an error event containing
  // "timed out" (withTimeout's message), e.g. "Extractor failed: extractor
  // timed out after 60000ms".
  if (event.status === "error" && /timed out/i.test(msg)) {
    const agent = event.agent as AgentRole;
    if (agent in AGENT_DISPLAY_NAME) {
      tracker.timedOutAgents.add(AGENT_DISPLAY_NAME[agent]);
    }
  }
}

/**
 * Turns collected facts into the report's disclosure notes.
 *
 * The 0-claims note is derived from the final claim count rather than the
 * extractor's done event: the verifier maps claims 1:1, so zero verified
 * claims always means extraction returned nothing — whether it reported a
 * clean "0 claims" done event or failed without one (timeout, parse
 * failure after both attempts).
 */
function buildDataQualityNotes(
  tracker: QualityTracker,
  hasZeroClaims: boolean
): string[] {
  const notes: string[] = [];

  for (const key of Object.keys(SOURCE_NAME_BY_KEY) as SourceKey[]) {
    const zeroForAQuery = tracker.queryCounts[key].some((count) => count === 0);
    if (tracker.sourceUnavailable.has(key) || zeroForAQuery) {
      notes.push(
        `Source coverage was reduced during this run: ${SOURCE_NAME_BY_KEY[key]} returned no results for one or more queries.`
      );
    }
  }

  if (tracker.titleSearchFound === 0) {
    notes.push(
      "Source coverage was reduced during this run: the arXiv title search returned no results for the analyzed paper's title."
    );
  }

  if (tracker.extractorRetried) {
    notes.push("Claim extraction required a retry due to a malformed initial response.");
  }

  if (hasZeroClaims) {
    notes.push(
      "No attributed claims could be extracted from the input — this may mean the document has no citations, or that extraction failed. Treat a report with 0 claims as inconclusive, not as evidence of citation quality."
    );
  }

  for (const agent of tracker.timedOutAgents) {
    notes.push(`${agent} exceeded its response time limit and fell back to default behavior.`);
  }

  return notes;
}

export async function runOrchestration(
  input: string,
  inputText: string,
  send: (event: object) => void,
  documentTitle?: string
): Promise<AnalysisReport> {
  const costLedger: CostEntry[] = [];
  const qualityTracker = createQualityTracker();

  /**
   * Wraps an agent's onEvent callback so that "streaming" events from model
   * calls are intercepted to record costs in the ledger, then forwarded via send().
   */
  function makeOnEvent(agent: AgentRole): (e: AgentEvent) => void {
    return (event: AgentEvent) => {
      send(event);
      trackDataQualityEvent(qualityTracker, event);

      if (
        event.status === "streaming" &&
        (event.benchmarkCost != null ||
          event.customerCharge != null ||
          event.cacheTier != null)
      ) {
        costLedger.push({
          agent,
          benchmarkCost: event.benchmarkCost ?? 0,
          customerCharge: event.customerCharge ?? 0,
          cacheTier: event.cacheTier ?? null,
        });
      }
    };
  }

  // Per-agent wall-clock timing (console.time/timeEnd) to see where end-to-end
  // latency actually goes before optimizing anything. The four agent calls are
  // inherently sequential (each stage depends on the previous), so the sum of
  // the four timers should be ~total.
  console.time("pipeline-total");
  try {
    // ── Step 1: Retrieval ──────────────────────────────────────────────────
    console.time("retriever");
    const sources: RetrievedSource[] = await runRetriever(
      input,
      makeOnEvent("retriever"),
      documentTitle
    );
    console.timeEnd("retriever");

    // ── Step 2: Fallback text from abstracts ───────────────────────────────
    let effectiveInputText = inputText;

    if (!effectiveInputText || !effectiveInputText.trim()) {
      send({
        agent: "extractor",
        status: "started",
        message:
          "No document text provided — extracting claims from retrieved abstracts instead",
        timestamp: Date.now(),
      });

      effectiveInputText = sources
        .slice(0, 8)
        .map((s) => `${s.title}\n${s.summary}`)
        .join("\n\n");
    }

    // ── Step 3: Extraction ─────────────────────────────────────────────────
    console.time("extractor");
    const claims: ExtractedClaim[] = await runExtractor(
      effectiveInputText,
      makeOnEvent("extractor")
    );
    console.timeEnd("extractor");

    // ── Step 4: Verification ───────────────────────────────────────────────
    console.time("verifier");
    const verifiedClaims: VerifiedClaim[] = await runVerifier(
      claims,
      sources,
      makeOnEvent("verifier"),
      // The full extracted document text (the original inputText, BEFORE the
      // extractor's 12000-char truncation) becomes an additional, always-
      // available evidence source: claims the paper makes about itself can be
      // confirmed by cross-referencing OTHER parts of the document, with no
      // external retrieval needed. Text-only runs pass an empty inputText (the
      // run route leaves it "" so extraction falls back to abstracts), so
      // fullDocumentText is undefined there and their behavior is unchanged.
      inputText && inputText.trim() ? inputText : undefined
    );
    console.timeEnd("verifier");

    // ── Step 4.5: The Cross-Examiner ───────────────────────────────────────
    // Purely additive: only runs when there is enough cross-source evidence to
    // examine (>= 2 verified claims matched to >= 2 distinct sources). The
    // retriever's merge keeps only one summary per paper, so conflicts can only
    // be found ACROSS different claims that cite different sources. A failure
    // here never fails the run — the result stays undefined.
    let crossExamination: CrossExaminationResult | undefined;
    try {
      // Cross-examination compares EXTERNAL sources' abstracts against each
      // other. Claims matched to the analyzed document's own full text carry
      // the FULL_DOCUMENT_SOURCE_LABEL, which has no abstract for the
      // cross-examiner to resolve — excluding them here keeps the stage's
      // input contract (every matchedSource resolves to external source text)
      // intact without touching cross-examiner logic itself.
      const evidenceClaims = verifiedClaims.filter(
        (c) => c.matchedSource && c.matchedSource !== FULL_DOCUMENT_SOURCE_LABEL
      );
      const distinctMatchedSources = new Set(evidenceClaims.map((c) => c.matchedSource!));
      if (evidenceClaims.length >= 2 && distinctMatchedSources.size >= 2) {
        crossExamination = await runCrossExaminer(
          verifiedClaims,
          sources,
          (event) => send(event)
        );
      }
    } catch (err) {
      console.warn(
        "[orchestrator] cross-examiner skipped:",
        err instanceof Error ? err.message : err
      );
    }

    // ── Step 5: Synthesis ──────────────────────────────────────────────────
    console.time("synthesizer");
    const { consensus, gaps } = await runSynthesizer(
      input,
      verifiedClaims,
      makeOnEvent("synthesizer"),
      crossExamination
    );
    console.timeEnd("synthesizer");

    // ── Step 6: Cost rollup ────────────────────────────────────────────────
    const totalBenchmarkCost = costLedger.reduce(
      (sum, e) => sum + e.benchmarkCost,
      0
    );
    const totalCustomerCharge = costLedger.reduce(
      (sum, e) => sum + e.customerCharge,
      0
    );
    const totalSaved = totalBenchmarkCost - totalCustomerCharge;

    // ── Step 7: Build report ───────────────────────────────────────────────
    const report: AnalysisReport = {
      input,
      claims: verifiedClaims,
      consensus,
      gaps,
      generatedAt: Date.now(),
      costSummary: {
        totalBenchmarkCost,
        totalCustomerCharge,
        totalSaved,
        perAgent: costLedger,
      },
      dataQualityNotes: buildDataQualityNotes(qualityTracker, verifiedClaims.length === 0),
      crossExamination,
    };

    // ── Step 7.5: The Historian ────────────────────────────────────────────
    // Purely additive: when a prior saved analysis of this paper/claim exists,
    // diff the two and attach a briefing to the report (so it rides the done
    // event and is persisted with the report). On a first-time analysis there
    // is no prior, so this adds no events and no field. A failure here must
    // never fail the run — the briefing is optional by design.
    try {
      const prior = findPriorAnalysis(input, documentTitle ?? null);
      if (prior) {
        report.historianBriefing = await generateHistorianBriefing(
          report,
          prior,
          (event) => send(event)
        );
      }
    } catch (err) {
      console.warn(
        "[orchestrator] historian skipped:",
        err instanceof Error ? err.message : err
      );
    }

    // ── Step 8: Final done event ───────────────────────────────────────────
    send({
      agent: "orchestrator",
      status: "done",
      message: "Analysis complete",
      report,
      timestamp: Date.now(),
    });

    return report;
  } catch (err) {
    send({
      agent: "orchestrator",
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    });
    throw err;
  } finally {
    console.timeEnd("pipeline-total");
  }
}

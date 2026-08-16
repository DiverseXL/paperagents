export type AgentRole = "retriever" | "extractor" | "falsifier" | "synthesizer";

/**
 * Agent name on an event. The four pipeline roles are exhaustive; "historian"
 * and "cross-examiner" are additive agents that emit their own events into the
 * same stream without joining the cost ledger or the pipeline nodes.
 */
export type EventAgent = AgentRole | "historian" | "cross-examiner";

/**
 * Lifecycle status of a claim inside the shared Claim Graph. Claims are created
 * "pending" by the Extractor, may be reopened "under_challenge" by the
 * Cross-Examiner, and are resolved by the Falsifier to a terminal status
 * ("survived" | "falsified" | "unverifiable") that is permanent for the run.
 */
export type ClaimStatus =
  | "pending"
  | "under_challenge"
  | "survived"
  | "falsified"
  | "unverifiable";

/**
 * A recorded challenge against a claim: which agent raised it, why, and when.
 * The Falsifier records every adversarial pass; the Cross-Examiner records a
 * challenge when it reopens a survived claim over a direct contradiction.
 */
export interface ClaimChallenge {
  agent: string;
  reason: string;
  at: string;
}

/**
 * One node of the shared Claim Graph — the ONLY handoff between agents in this
 * system. Later agents are blocked by earlier decisions in code (see
 * lib/claim-graph.ts), not just by prompts: the Extractor creates claims as
 * "pending", only the Falsifier may move a claim to a terminal status, and the
 * Synthesizer may only read nodes that are "survived" with
 * groundingCheckPassed === true. Nodes that reach "falsified" or
 * "unverifiable" are permanent for the run.
 */
export interface ClaimGraphNode {
  id: string;
  text: string;
  citationLabel: string;
  sourceQuote?: string;
  status: ClaimStatus;
  challenges: ClaimChallenge[];
  evidenceQuotes: string[];
  groundingCheckPassed: boolean;
  originPointExcluded: boolean;
  finalVerdict?: "supported" | "falsified" | "unverifiable";
}

/**
 * Lightweight per-claim graph state shipped to the client over SSE so the UI
 * can render live status badges (PENDING → UNDER CHALLENGE → SURVIVED /
 * FALSIFIED / UNVERIFIABLE) while the run is still in flight.
 */
export interface ClaimGraphEntry {
  id: string;
  text: string;
  citationLabel: string;
  graphStatus: ClaimStatus;
  finalVerdict?: "supported" | "falsified" | "unverifiable";
}

export interface AgentEvent {
  agent: EventAgent;
  status: "started" | "streaming" | "done" | "error";
  message: string;
  cacheTier?: string | null;
  benchmarkCost?: number | null;
  customerCharge?: number | null;
  timestamp: number;
}

/**
 * The Falsifier treats the analyzed document's own full extracted text as an
 * always-available evidence source, distinct from externally retrieved
 * abstracts. The per-claim evidence is an EXCERPT of the document with the
 * claim's own origin point (its sourceQuote plus 500 characters around it)
 * structurally removed, so a claim can only be confirmed by a DIFFERENT part
 * of the paper — a self-consistency verdict rather than external
 * corroboration, and never self-matching. This label is a stable contract
 * shared by the Falsifier, the report renderers, and the PDF export.
 */
export const FULL_DOCUMENT_SOURCE_LABEL =
  "Source Document (Full Text, excerpt excluding claim's origin point)";

export interface RetrievedSource {
  title: string;
  summary: string;
  url: string;
  source: "arxiv" | "semantic_scholar" | "openalex";
  /** True when the same paper (same normalized title) was returned by more than one literature API. */
  confirmedByMultipleSources: boolean;
  /** Number of distinct literature APIs that returned this paper (1-3). */
  sourceCount: number;
}

export interface ExtractedClaim {
  id: string;
  text: string;
  sourceQuote: string;
  citedAs: string;
}

export interface VerifiedClaim extends ExtractedClaim {
  /**
   * The Falsifier's verdict. "supported" means the claim survived an
   * adversarial attempt to break it AND a real checkable quote exists;
   * "fabricated" means a grounded quote shows the source clearly does not say
   * it; everything else (missing/partial/ambiguous evidence, ungrounded
   * quotes) is "unverifiable".
   */
  status: "supported" | "fabricated" | "unverifiable";
  matchedSource: string | null;
  /** Verbatim excerpt the model claims to have copied from the matched source's text; empty string when status is not supported/fabricated. */
  evidenceQuote: string;
  reasoning: string;
  confidence: number;
  /**
   * For claims supported/fabricated against the analyzed document's own full
   * text: the minimum character distance in the document between where the
   * evidenceQuote occurs (outside the excluded origin window) and the claim's
   * own sourceQuote span. Absent for external-source matches or when the
   * sourceQuote could not be located in the document. Lets a reader confirm
   * the evidence came from a genuinely different passage.
   */
  documentEvidenceDistance?: number;
  /**
   * ── Claim Graph state ──
   * Always present on runs produced by the constrained multi-agent pipeline;
   * optional so stale persisted reports (from before the Claim Graph existed)
   * still render. graphStatus is the authoritative lifecycle state in the
   * shared Claim Graph; the Synthesizer only ever reads claims whose
   * graphStatus is "survived" with groundingCheckPassed === true.
   */
  graphStatus?: ClaimStatus;
  groundingCheckPassed?: boolean;
  /** True when this claim's evidence could only come from a document excerpt with its origin point excluded. */
  originPointExcluded?: boolean;
  /** Every challenge this claim faced (Falsifier passes + Cross-Examiner reopenings). */
  challenges?: ClaimChallenge[];
  finalVerdict?: "supported" | "falsified" | "unverifiable";
}

/**
 * A single claim compared across two runs of the same paper/claim. Produced by
 * the Historian agent when a prior saved analysis of the same input exists.
 */
export interface ClaimStatusChange {
  claimText: string;
  previousStatus: string;
  currentStatus: string;
  changeType: "improved" | "regressed" | "new_evidence" | "no_change";
}

/**
 * What changed between the last saved analysis of a paper/claim and this one.
 * Attached to the report as an optional field — absent on first-time analyses.
 */
/**
 * A genuine conflict between two or more retrieved sources on the same subject.
 * Produced by the Cross-Examiner agent — only real disagreements, never
 * manufactured ones.
 */
export interface EvidenceConflict {
  claimText: string;
  /**
   * Ids of the claims involved in this conflict (best-effort from the
   * Cross-Examiner; falls back to text matching). Used by the orchestrator to
   * reopen survived claims for one more falsification pass.
   */
  claimIds?: string[];
  conflictingSources: Array<{
    sourceTitle: string;
    excerpt: string;
    position: string;
  }>;
  severity: "direct_contradiction" | "partial_disagreement";
}

/**
 * Result of the Cross-Examiner stage (runs between Falsifier and Synthesizer).
 * An empty conflicts array means the examined sources were consistent (or, in
 * the fallback case, that the analysis failed — see the summary field).
 */
export interface CrossExaminationResult {
  conflicts: EvidenceConflict[];
  summary: string;
}

export interface HistorianBriefing {
  priorAnalysisId: string;
  priorAnalyzedAt: number;
  summary: string;
  claimChanges: ClaimStatusChange[];
  /**
   * "no_overlap_found" when both runs had claims but NONE of them could be
   * matched across the runs (e.g. extraction paraphrased them differently) —
   * a comparison failure, NOT evidence that nothing changed. "matched" when
   * at least one claim was successfully compared.
   */
  matchQuality: "matched" | "no_overlap_found";
  newSourcesFound: number;
  sourcesNoLongerFound: number;
}

export interface AnalysisReport {
  input: string;
  claims: VerifiedClaim[];
  consensus: string;
  gaps: string[];
  generatedAt: number;
  /**
   * Rollup of the scientific integrity gate (present on runs produced by the
   * constrained multi-agent pipeline): how many claims survived adversarial
   * falsification + the deterministic grounding check and were therefore
   * eligible to ground the consensus, and how many were excluded from it.
   */
  integrityGate?: {
    survivedCount: number;
    excludedCount: number;
    statusCounts: Record<ClaimStatus, number>;
  };
  /** Present only when a prior saved analysis of the same paper/claim exists. */
  historianBriefing?: HistorianBriefing;
  /** Present only when the run had enough cross-source evidence to examine. */
  crossExamination?: CrossExaminationResult;
  costSummary: {
    totalBenchmarkCost: number;
    totalCustomerCharge: number;
    totalSaved: number;
    perAgent: {
      agent: AgentRole;
      benchmarkCost: number;
      customerCharge: number;
      cacheTier: string | null;
    }[];
  };
  /**
   * Honest disclosure of degraded conditions during this report's own
   * generation (sources that returned nothing or errored, extraction retries
   * or failures, agent timeouts). Empty array on a clean run.
   */
  dataQualityNotes: string[];
}

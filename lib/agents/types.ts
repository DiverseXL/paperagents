export type AgentRole = "retriever" | "extractor" | "verifier" | "synthesizer";

/**
 * Agent name on an event. The four pipeline roles are exhaustive; "historian"
 * and "cross-examiner" are additive agents that emit their own events into the
 * same stream without joining the cost ledger or the pipeline nodes.
 */
export type EventAgent = AgentRole | "historian" | "cross-examiner";

export interface AgentEvent {
  agent: EventAgent;
  status: "started" | "streaming" | "done" | "error";
  message: string;
  cacheTier?: string | null;
  benchmarkCost?: number | null;
  customerCharge?: number | null;
  timestamp: number;
}

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
  status: "supported" | "unsupported" | "fabricated" | "unclear";
  matchedSource: string | null;
  /** Verbatim excerpt the model claims to have copied from the matched source's text; empty string when status is not supported/fabricated. */
  evidenceQuote: string;
  reasoning: string;
  confidence: number;
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
  conflictingSources: Array<{
    sourceTitle: string;
    excerpt: string;
    position: string;
  }>;
  severity: "direct_contradiction" | "partial_disagreement";
}

/**
 * Result of the Cross-Examiner stage (runs between Verifier and Synthesizer).
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

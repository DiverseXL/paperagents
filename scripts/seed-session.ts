/**
 * Seeds a sample saved analysis into the local SQLite DB (data/paperagents.db).
 *
 * Useful for exercising the persistence + restore layer without a live
 * pipeline run (which needs OPENROUTER_API_KEY / RUNTIME_API_KEY). Run:
 *
 *   npx tsx scripts/seed-session.ts
 *
 * Then reload /analyze — the seeded report should appear as the restored
 * session. Re-running overwrites "latest" with a fresh record.
 */
import { saveAnalysis, getLatestAnalysis, listAnalyses } from "../lib/db";
import type { AnalysisReport } from "../lib/agents/types";

const report: AnalysisReport = {
  input:
    "The transformer architecture relies entirely on self-attention without recurrence or convolution, and BERT outperforms humans on GLUE.",
  claims: [
    {
      id: "seed-c1",
      text: "The transformer relies entirely on self-attention and draws no recurrent or convolutional layers.",
      sourceQuote:
        "the Transformer, which relies entirely on an attention mechanism and draws no recurrent or convolutional layers",
      citedAs: "Vaswani et al., 2017",
      status: "supported",
      matchedSource: "Attention Is All You Need (arXiv:1706.03762)",
      evidenceQuote:
        "the Transformer, which relies entirely on an attention mechanism and draws no recurrent or convolutional layers",
      reasoning:
        "The quoted sentence appears verbatim in the source's abstract.",
      confidence: 0.99,
      graphStatus: "survived",
      groundingCheckPassed: true,
      originPointExcluded: false,
      challenges: [],
      finalVerdict: "supported",
    },
    {
      id: "seed-c2",
      text: "BERT outperforms humans on the GLUE benchmark on every single task.",
      sourceQuote: "BERT outperforms humans on GLUE",
      citedAs: "Devlin et al., 2019",
      status: "unverifiable",
      matchedSource: null,
      evidenceQuote: "",
      reasoning:
        "No retrieved source text contains this claim verbatim or in substance — the GLUE leaderboard figures are not present in the corpus.",
      confidence: 0.87,
      graphStatus: "unverifiable",
      groundingCheckPassed: false,
      originPointExcluded: false,
      challenges: [],
      finalVerdict: "unverifiable",
    },
  ],
  consensus:
    "The architectural claim about the Transformer is fully backed by the source text. The BERT/GLUE claim, however, is not supported by any of the retrieved sources.",
  gaps: [
    "GLUE-specific result tables were not among the retrieved abstracts.",
    "No source for the BERT paper was returned by the literature APIs.",
  ],
  generatedAt: Date.now(),
  costSummary: {
    totalBenchmarkCost: 0.00231,
    totalCustomerCharge: 0.0012,
    totalSaved: 0.00111,
    perAgent: [
      {
        agent: "retriever",
        benchmarkCost: 0.00012,
        customerCharge: 0.00006,
        cacheTier: null,
      },
      {
        agent: "extractor",
        benchmarkCost: 0.00087,
        customerCharge: 0.00045,
        cacheTier: "silver",
      },
      {
        agent: "falsifier",
        benchmarkCost: 0.00098,
        customerCharge: 0.00051,
        cacheTier: "gold",
      },
      {
        agent: "synthesizer",
        benchmarkCost: 0.00034,
        customerCharge: 0.00018,
        cacheTier: "silver",
      },
    ],
  },
  dataQualityNotes: [],
};

const id = saveAnalysis(report, report.input);
console.log("Saved analysis:", id);
console.log(
  "Latest consensus:",
  getLatestAnalysis()?.consensus.slice(0, 80) + "…"
);
console.log(
  "Records on file:",
  listAnalyses(5).map(
    (s) => `${new Date(s.created_at).toISOString()} — ${s.input.slice(0, 48)}…`
  )
);

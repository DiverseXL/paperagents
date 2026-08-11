import { callRuntime } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import type {
  AgentEvent,
  CrossExaminationResult,
  EvidenceConflict,
  RetrievedSource,
  VerifiedClaim,
} from "./types";

const CROSS_EXAMINER_SYSTEM_PROMPT = `You are the Cross-Examiner agent in a research verification pipeline. Your job is to check whether the retrieved sources genuinely disagree with each other about a claim — not to re-verify the claims themselves (the Verifier has already done that), but to find places where the evidence is NOT unanimous.

You will receive a list of verified claims, each with the title of the source it was matched against and that source's text (its abstract). When two different claims are matched against different sources that discuss the same subject, those sources may disagree with each other.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- Identify only GENUINE contradictions or notable disagreements between sources on the same subject. The disagreement must be about the claim's subject matter (same paper, same benchmark, same mechanism, same specific outcome) — not merely different topics or different wording.
- severity:
  - "direct_contradiction": two sources state incompatible facts about the same subject (e.g. one says an effect exists, another says it does not; one reports result X, another reports a conflicting result Y).
  - "partial_disagreement": sources differ meaningfully without outright contradiction (e.g. materially different numbers, different scopes, or one qualifies the other's claim).
- conflictingSources: for each source involved, give its title, a short verbatim excerpt from its abstract showing its position, and the position within the source (usually "Abstract").
- claimText should be the text of the claim this conflict concerns.
- If the sources are consistent, return an EMPTY conflicts array. Do NOT manufacture disagreement to seem thorough — an honest "no conflicts" is a valid and valuable result.
- Output schema:
{"conflicts": [{"claimText": "string", "conflictingSources": [{"sourceTitle": "string", "excerpt": "string", "position": "string"}], "severity": "direct_contradiction|partial_disagreement"}], "summary": "string"}

The summary is 1-2 plain sentences summarizing what the cross-examination found (e.g. how many conflicts, or that all examined sources were consistent).`;

// Safety cap on the cross-examiner LLM call — same 45s ceiling as the verifier
// and synthesizer. A timeout rejects callRuntime and flows into the fallback
// below; the stage must never block the pipeline.
const CROSS_EXAMINER_CALL_TIMEOUT_MS = 45_000;

const FALLBACK: CrossExaminationResult = {
  conflicts: [],
  summary: "No structured conflict analysis available due to a processing error",
};

interface RawConflictSource {
  sourceTitle?: unknown;
  excerpt?: unknown;
  position?: unknown;
}

interface RawConflict {
  claimText?: unknown;
  conflictingSources?: unknown;
  severity?: unknown;
}

function parseConflicts(content: string): CrossExaminationResult | null {
  try {
    const parsed = JSON.parse(content) as {
      conflicts?: unknown;
      summary?: unknown;
    };
    if (!Array.isArray(parsed.conflicts)) return null;

    const conflicts: EvidenceConflict[] = [];
    for (const raw of parsed.conflicts) {
      const c = raw as RawConflict;
      if (
        typeof c.claimText !== "string" ||
        !Array.isArray(c.conflictingSources) ||
        (c.severity !== "direct_contradiction" && c.severity !== "partial_disagreement") ||
        c.conflictingSources.length < 2
      ) {
        continue;
      }

      const conflictingSources: EvidenceConflict["conflictingSources"] = [];
      // Never render more than 4 competing sources per conflict.
      for (const rawSource of c.conflictingSources.slice(0, 4)) {
        const s = rawSource as RawConflictSource;
        if (typeof s.sourceTitle !== "string" || typeof s.excerpt !== "string") {
          continue;
        }
        conflictingSources.push({
          sourceTitle: s.sourceTitle,
          excerpt: s.excerpt,
          position: typeof s.position === "string" ? s.position : "Abstract",
        });
      }

      if (conflictingSources.length < 2) continue; // conflict needs >= 2 sources

      conflicts.push({
        claimText: c.claimText,
        conflictingSources,
        severity: c.severity,
      });
    }

    return {
      conflicts,
      summary:
        typeof parsed.summary === "string"
          ? parsed.summary
          : conflicts.length > 0
            ? `${conflicts.length} evidence conflict${conflicts.length === 1 ? "" : "s"} identified.`
            : "The examined sources were consistent; no conflicting evidence was found.",
    };
  } catch {
    return null;
  }
}

/**
 * The Cross-Examiner — a fifth, additive stage between the Verifier and the
 * Synthesizer. Checks whether genuinely different sources contradict each other
 * about the same subject. The orchestrator only calls this when there is enough
 * cross-source evidence to examine (>= 2 verified claims matched to >= 2
 * distinct sources); within the stage, every eligible claim is compared against
 * the OTHER sources its matched source might conflict with, via one LLM call.
 */
export async function runCrossExaminer(
  claims: VerifiedClaim[],
  sources: RetrievedSource[],
  onEvent: (e: AgentEvent) => void
): Promise<CrossExaminationResult> {
  const evidenceClaims = claims.filter((c) => c.matchedSource);

  onEvent({
    agent: "cross-examiner",
    status: "started",
    message: `Cross-examining ${evidenceClaims.length} evidence-backed claim(s) against distinct sources...`,
    timestamp: Date.now(),
  });

  // Source summaries by (lowercased) title — the only text available per source
  // (the retriever's merge keeps one merged summary per paper).
  const normalizedSources = sources.map((s) => ({
    title: s.title.toLowerCase().trim(),
    summary: s.summary.slice(0, 1200),
  }));

  /**
   * The verifier's matchedSource is free text from the LLM, so it rarely equals
   * a source title exactly. Exact key first, then a containment fallback (the
   * matchedSource mentions the title or the title mentions the matchedSource),
   * preferring the longest title — so the model never sees an empty excerpt
   * for a claimed source when a plausible match exists.
   */
  function findSourceText(matchedSource: string): string {
    const key = matchedSource.toLowerCase().trim();
    if (!key) return "";

    const exact = normalizedSources.find((s) => s.title === key);
    if (exact) return exact.summary;

    let best = "";
    let bestLen = 0;
    for (const s of normalizedSources) {
      if (s.title.includes(key) || key.includes(s.title)) {
        if (s.title.length > bestLen) {
          best = s.summary;
          bestLen = s.title.length;
        }
      }
    }
    return best;
  }

  // Intentional token-budget cap — beyond 12 evidence claims the prompt would
  // grow unboundedly; the most relevant claims were already extracted first.
  const userMessage = JSON.stringify({
    claims: evidenceClaims.slice(0, 12).map((c) => ({
      text: c.text,
      status: c.status,
      matchedSource: c.matchedSource,
      sourceText: findSourceText(c.matchedSource ?? ""),
    })),
  });

  const request = {
    model: "deepseek/deepseek-chat",
    messages: [
      { role: "system" as const, content: CROSS_EXAMINER_SYSTEM_PROMPT },
      { role: "user" as const, content: userMessage },
    ],
    maxTokens: 800,
    // promptCacheKey: "cross-examiner-v1",
    responseFormat: "json_object" as const,
  };

  try {
    let runtimeRes = await withTimeout(
      callRuntime(request),
      CROSS_EXAMINER_CALL_TIMEOUT_MS,
      "Cross-Examiner API call"
    );

    let result = parseConflicts(runtimeRes.content);

    // Malformed JSON on the first attempt — retry exactly once before falling
    // back (same pattern as the extractor).
    if (!result) {
      onEvent({
        agent: "cross-examiner",
        status: "streaming",
        message: "Retrying cross-examination after malformed JSON response",
        timestamp: Date.now(),
      });
      runtimeRes = await withTimeout(
        callRuntime(request),
        CROSS_EXAMINER_CALL_TIMEOUT_MS,
        "Cross-Examiner API call (retry)"
      );
      result = parseConflicts(runtimeRes.content);
    }

    if (result) {
      onEvent({
        agent: "cross-examiner",
        status: "streaming",
        message: "Cross-examination received from Runtime API.",
        cacheTier: runtimeRes.cacheTier,
        benchmarkCost: runtimeRes.benchmarkCost,
        customerCharge: runtimeRes.customerCharge,
        timestamp: Date.now(),
      });
      onEvent({
        agent: "cross-examiner",
        status: "done",
        message:
          result.conflicts.length > 0
            ? `Cross-examiner filed: ${result.conflicts.length} evidence conflict${result.conflicts.length === 1 ? "" : "s"} between sources.`
            : "Cross-examiner filed: no conflicting evidence found.",
        timestamp: Date.now(),
      });
      return result;
    }

    onEvent({
      agent: "cross-examiner",
      status: "error",
      message: "Failed to parse cross-examination JSON after retry",
      timestamp: Date.now(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({
      agent: "cross-examiner",
      status: "error",
      message: `Cross-examiner API call failed: ${message}`,
      timestamp: Date.now(),
    });
  }

  onEvent({
    agent: "cross-examiner",
    status: "done",
    message: "Cross-examiner filed a fallback result.",
    timestamp: Date.now(),
  });
  return FALLBACK;
}

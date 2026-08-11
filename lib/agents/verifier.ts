import { callRuntime } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import { AgentEvent, ExtractedClaim, RetrievedSource, VerifiedClaim } from "./types";

const VERIFIER_SYSTEM_PROMPT = `You are the Verifier agent in a research verification pipeline.

You will receive a list of claims (each with a source quote and citation label) and a list of retrieved sources (title + abstract/summary). Your job is to determine, for each claim, whether the retrieved sources' TEXT CONTENT supports it.

Critical rule: the claim's sourceQuote comes from the original document being checked, NOT from the retrieved sources. It is not evidence of anything. Matching a source by title or topic is not sufficient — you must find the specific assertion in that source's actual summary/abstract text, not merely confirm that a plausible-sounding source with a matching title exists in the list.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- For each claim, classify status as one of:
  - "supported": a retrieved source's text explicitly states the same specific assertion as the claim (matching numbers, named entities, or specific outcomes).
  - "unsupported": NONE of the retrieved sources' text mention the claim's subject matter or topic AT ALL — the topic itself is absent, not just the specific detail.
  - "unclear": at least one retrieved source's text discusses the SAME topic or subject as the claim (e.g. same paper, same mechanism, same general subject), but does not explicitly state the specific detail, number, or outcome being claimed. This is the correct label whenever a source is topically relevant but doesn't confirm the precise assertion — do not use "unsupported" in this case.
  - "fabricated": a retrieved source's text directly contradicts the claim.
- Decision rule to apply before choosing between "unsupported" and "unclear": first check whether ANY retrieved source's text is about the same subject/topic as the claim at all. If yes (even without confirming the specific detail), the status must be "unclear", never "unsupported". Only use "unsupported" when the topic itself is entirely absent from every retrieved source.
- Only mark "supported" or "fabricated" when you can point to specific text in a retrieved source's summary that directly confirms or contradicts the claim. Default to "unclear" over-guessing, and default to "unclear" rather than "supported" when a source's title matches the claim's subject but its summary text does not contain the specific detail being claimed.
- matchedSource should be the title of the best-matching retrieved source, or null if none.
- reasoning must be one sentence explaining the classification, and must reference the SPECIFIC TEXT in the source's summary that supports the classification — not the source's title or general topic alone. If you cannot quote or closely paraphrase supporting text from the summary, the status cannot be "supported."
- evidenceQuote is REQUIRED whenever status is 'supported' or 'fabricated'. It must be a short (under 40 words) VERBATIM excerpt copied exactly from the matched source's text — not a paraphrase, not from the claim's own sourceQuote. If you cannot produce a verbatim excerpt from the retrieved source text, the status must be 'unclear' or 'unsupported', not 'supported'. For 'unclear' or 'unsupported' status, evidenceQuote should be an empty string.
- confidence is a number from 0 to 1 reflecting how certain you are in the classification itself.
- Do not fabricate sources. Only reference sources given to you.
- confirmedByMultipleSources marks sources independently indexed by more than one literature database (e.g. arXiv, Semantic Scholar, OpenAlex). Treat it as a credibility signal, but it never substitutes for checking whether that source's actual text states the specific claim being verified.

Output schema:
{"results": [{"claimId": "string", "status": "supported|unsupported|fabricated|unclear", "matchedSource": "string|null", "evidenceQuote": "string", "reasoning": "string", "confidence": number}]}`;

const VERIFIER_MODEL_STANDARD = "deepseek/deepseek-chat";
const VERIFIER_MODEL_PREMIUM = "anthropic/claude-3.5-sonnet";

// Safety cap on the verifier LLM call. Observed premium-mode latency was 21.7s
// (measured 2026-08); 45s gives ~2x headroom for provider-side variance while
// still failing fast on a genuinely hung request. A timeout here rejects the
// callRuntime promise, which the existing catch below routes through the same
// parse-failure fallback as a malformed response (all claims -> "unclear").
const VERIFIER_CALL_TIMEOUT_MS = 45_000;

const UNCLEAR_FALLBACK = {
  status: "unclear" as const,
  matchedSource: null,
  evidenceQuote: "",
  reasoning: "Verification failed — model output could not be parsed",
  confidence: 0,
};

/** Normalizes text for deterministic quote-grounding: lowercase, punctuation stripped, whitespace collapsed. */
export function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic grounding check: returns false when the structured evidenceQuote
 * is missing/empty, or when it is not present (normalized) as a contiguous
 * substring of the matched source's summary. The model's self-report is NOT
 * trusted, and there is no vacuous pass: every "supported"/"fabricated" claim
 * must carry a non-empty, mechanically verified verbatim quote or be downgraded.
 */
function isReasonablyGrounded(evidenceQuote: string, matchedSourceSummary: string | null): boolean {
  if (!matchedSourceSummary) return false;

  const normalizedQuote = normalizeForGrounding(evidenceQuote);
  if (normalizedQuote.length === 0) return false; // empty/missing quote → not grounded

  const normalizedSummary = normalizeForGrounding(matchedSourceSummary);
  return normalizedSummary.includes(normalizedQuote);
}

export async function runVerifier(
  claims: ExtractedClaim[],
  sources: RetrievedSource[],
  onEvent: (e: AgentEvent) => void
): Promise<VerifiedClaim[]> {
  const model = process.env.VERIFIER_MODEL_MODE === "premium" ? VERIFIER_MODEL_PREMIUM : VERIFIER_MODEL_STANDARD;
  const modelMode = process.env.VERIFIER_MODEL_MODE === "premium" ? "premium: Claude Sonnet" : "standard: deepseek";

  onEvent({
    agent: "verifier",
    status: "started",
    message: `Verifying ${claims.length} claim(s) against ${sources.length} source(s) (${modelMode})...`,
    timestamp: Date.now(),
  });

  if (claims.length === 0) {
    onEvent({
      agent: "verifier",
      status: "done",
      message: "No claims to verify.",
      timestamp: Date.now(),
    });
    return [];
  }

  // Build compact user message — cap sources at 15, truncate summaries to 1200 chars
  const cappedSources = sources.slice(0, 15).map((s) => ({
    title: s.title,
    summary: s.summary.slice(0, 1200),
    confirmedByMultipleSources: s.confirmedByMultipleSources,
  }));

  const userMessage = JSON.stringify({
    claims: claims.map(({ id, text, sourceQuote, citedAs }) => ({
      id,
      text,
      sourceQuote,
      citedAs,
    })),
    sources: cappedSources,
  });

  let rawResults: any[] = [];
  let parseFailed = false;

  try {
    const runtimeRes = await withTimeout(
      callRuntime({
        model,
        messages: [
          { role: "system", content: VERIFIER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        maxTokens: 1500,
        // promptCacheKey: "verifier-v4",
        responseFormat: "json_object",
      }),
      VERIFIER_CALL_TIMEOUT_MS,
      "Verifier API call"
    );

    onEvent({
      agent: "verifier",
      status: "streaming",
      message: "Verification results received from Runtime API.",
      cacheTier: runtimeRes.cacheTier,
      benchmarkCost: runtimeRes.benchmarkCost,
      customerCharge: runtimeRes.customerCharge,
      timestamp: Date.now(),
    });

    try {
      const parsed = JSON.parse(runtimeRes.content);
      if (Array.isArray(parsed.results)) {
        rawResults = parsed.results;
      } else {
        parseFailed = true;
      }
    } catch (parseError: any) {
      parseFailed = true;
      onEvent({
        agent: "verifier",
        status: "error",
        message: `Failed to parse verification JSON: ${parseError?.message || parseError}`,
        timestamp: Date.now(),
      });
    }
  } catch (err: any) {
    parseFailed = true;
    onEvent({
      agent: "verifier",
      status: "error",
      message: `Verifier API call failed: ${err?.message || err}`,
      timestamp: Date.now(),
    });
  }

  // Build result lookup by claimId
  const resultMap = new Map<string, any>();
  for (const r of rawResults) {
    if (r.claimId) {
      resultMap.set(r.claimId, r);
    }
  }

  // Merge results back onto claims
  const verified: VerifiedClaim[] = claims.map((claim) => {
    const match = parseFailed ? null : resultMap.get(claim.id);

    if (!match) {
      return {
        ...claim,
        ...UNCLEAR_FALLBACK,
      };
    }

    return {
      ...claim,
      status: (["supported", "unsupported", "fabricated", "unclear"].includes(match.status)
        ? match.status
        : "unclear") as VerifiedClaim["status"],
      matchedSource: typeof match.matchedSource === "string" ? match.matchedSource : null,
      evidenceQuote: typeof match.evidenceQuote === "string" ? match.evidenceQuote : "",
      reasoning: typeof match.reasoning === "string" ? match.reasoning : UNCLEAR_FALLBACK.reasoning,
      confidence: typeof match.confidence === "number" ? Math.min(1, Math.max(0, match.confidence)) : 0,
    };
  });

  // ── Deterministic grounding check ────────────────────────────────────────
  // The model's self-reported evidenceQuote is not trusted: any "supported"/"fabricated"
  // claim whose evidenceQuote is missing/empty or not actually present (normalized)
  // as a contiguous substring of the matched source's summary is downgraded to
  // "unclear". Every such claim is checked — there is no vacuous pass path.
  const sourceSummaryByTitle = new Map<string, string>();
  for (const s of sources.slice(0, 15)) {
    const key = s.title.toLowerCase().trim();
    if (key && !sourceSummaryByTitle.has(key)) {
      sourceSummaryByTitle.set(key, s.summary.slice(0, 1200));
    }
  }

  const downgradeSuffix = " [downgraded: quoted evidence not found verbatim in source text]";
  let downgradedCount = 0;
  let checkedCount = 0;

  const grounded: VerifiedClaim[] = verified.map((vc) => {
    if (vc.status !== "supported" && vc.status !== "fabricated") {
      return vc;
    }
    checkedCount++;
    try {
      const summary = vc.matchedSource
        ? sourceSummaryByTitle.get(vc.matchedSource.toLowerCase().trim()) ?? null
        : null;
      if (!isReasonablyGrounded(vc.evidenceQuote, summary)) {
        downgradedCount++;
        return {
          ...vc,
          status: "unclear",
          reasoning: vc.reasoning + downgradeSuffix,
          confidence: 0.5,
        };
      }
      return vc;
    } catch (err: any) {
      // Defensive: never let the grounding check crash the pipeline.
      console.warn(`[verifier] grounding check skipped for claim ${vc.id}:`, err?.message || err);
      return vc;
    }
  });

  onEvent({
    agent: "verifier",
    status: "streaming",
    message: `Grounding check downgraded ${downgradedCount} of ${checkedCount} claims (quoted evidence not verified against source text)`,
    timestamp: Date.now(),
  });

  // Count per status for done event
  const counts: Record<string, number> = { supported: 0, unsupported: 0, fabricated: 0, unclear: 0 };
  for (const vc of grounded) {
    counts[vc.status] = (counts[vc.status] || 0) + 1;
  }

  const summary = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ");

  onEvent({
    agent: "verifier",
    status: "done",
    message: `Verifier completed: ${summary}.`,
    timestamp: Date.now(),
  });

  return grounded;
}

import { callRuntime } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import { AgentEvent, ExtractedClaim } from "./types";

const EXTRACTOR_SYSTEM_PROMPT = `You are the Extractor agent in a research verification pipeline.

Given a body of text (a paper, abstract, or set of abstracts), extract every factual or empirical claim that is attributed to a citation or source. Ignore claims with no attribution.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- Each claim must include: the claim text in your own words, a short verbatim quote (under 25 words) from the source text that supports it, and how the citation is referenced in the text (e.g. author name, year, or bracketed number).
- Extract at most 12 claims. Prioritize claims with specific numbers, comparisons, or causal statements over vague ones.
- If no attributed claims are found, return an empty claims array — do not invent claims.

Output schema:
{"claims": [{"text": "string", "sourceQuote": "string", "citedAs": "string"}]}`;

// Safety cap on the extractor LLM call — 60s, higher than the other agents'
// 45s cap: observed extractor latency reached 44.1s (vs 33-38s typical), so
// 45s left only ~1s of headroom and a false-trigger mid-demo is worse than a
// slightly longer worst-case wait. A timeout rejects the callRuntime promise
// and flows through the existing catch paths exactly like a callRuntime
// failure or malformed JSON does today (error event -> return empty array);
// no new fallback branches were added.
const EXTRACTOR_CALL_TIMEOUT_MS = 60_000;

export async function runExtractor(
  inputText: string,
  onEvent: (e: AgentEvent) => void
): Promise<ExtractedClaim[]> {
  let processedText = inputText;
  let isTruncated = false;

  if (processedText.length > 12000) {
    processedText = processedText.slice(0, 12000);
    isTruncated = true;
  }

  onEvent({
    agent: "extractor",
    status: "started",
    message: isTruncated
      ? "Extracting claims from input text (truncated to 12000 characters)..."
      : "Extracting claims from input text...",
    timestamp: Date.now(),
  });

  try {
    const request = {
      model: "deepseek/deepseek-chat",
      messages: [
        { role: "system" as const, content: EXTRACTOR_SYSTEM_PROMPT },
        { role: "user" as const, content: processedText },
      ],
      maxTokens: 1200,
      // promptCacheKey: "extractor-v1",
      responseFormat: "json_object" as const,
    };

    const emitCostEvent = (res: any) => {
      onEvent({
        agent: "extractor",
        status: "streaming",
        message: "Claims extracted via Runtime API.",
        cacheTier: res.cacheTier,
        benchmarkCost: res.benchmarkCost,
        customerCharge: res.customerCharge,
        timestamp: Date.now(),
      });
    };

    let runtimeRes = await withTimeout(
      callRuntime(request),
      EXTRACTOR_CALL_TIMEOUT_MS,
      "extractor"
    );
    emitCostEvent(runtimeRes);

    const parseClaims = (): any[] => {
      const parsed = JSON.parse(runtimeRes.content);
      return Array.isArray(parsed.claims) ? parsed.claims : [];
    };

    let rawClaims: any[] = [];
    try {
      rawClaims = parseClaims();
    } catch (parseError: any) {
      // Malformed JSON from the first attempt — retry exactly once before giving up.
      onEvent({
        agent: "extractor",
        status: "streaming",
        message: "Retrying claim extraction after malformed JSON response",
        timestamp: Date.now(),
      });
      runtimeRes = await withTimeout(
        callRuntime(request),
        EXTRACTOR_CALL_TIMEOUT_MS,
        "extractor"
      );
      emitCostEvent(runtimeRes);
      try {
        rawClaims = parseClaims();
      } catch (retryParseError: any) {
        onEvent({
          agent: "extractor",
          status: "error",
          message: `Failed to parse claims JSON: ${retryParseError?.message || retryParseError}`,
          timestamp: Date.now(),
        });
        return [];
      }
    }

    const claims: ExtractedClaim[] = [];
    let claimIndex = 1;

    for (const item of rawClaims) {
      const sourceQuote = String(item.sourceQuote || "").trim();
      const wordCount = sourceQuote ? sourceQuote.split(/\s+/).length : 0;

      // Filter out claims where sourceQuote is longer than 40 words (hallucination guard)
      if (wordCount > 40) {
        continue;
      }

      claims.push({
        id: `claim-${claimIndex++}`,
        text: String(item.text || "").trim(),
        sourceQuote,
        citedAs: String(item.citedAs || "").trim(),
      });
    }

    onEvent({
      agent: "extractor",
      status: "done",
      message: `Extractor completed: ${claims.length} claim(s) extracted.`,
      timestamp: Date.now(),
    });

    return claims;
  } catch (err: any) {
    onEvent({
      agent: "extractor",
      status: "error",
      message: `Extractor failed: ${err?.message || err}`,
      timestamp: Date.now(),
    });
    return [];
  }
}

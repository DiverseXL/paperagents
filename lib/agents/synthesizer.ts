import { callRuntime, RuntimeResult } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import { FREE_MODELS } from "../models";
import { AgentEvent, CrossExaminationResult, VerifiedClaim } from "./types";

const SYNTHESIZER_SYSTEM_PROMPT = `You are the Synthesizer agent — the Arbiter — in a constrained multi-agent research verification system.

You will receive TWO lists of claims, and you must treat them very differently:

1. survivedClaims: claims that have already survived adversarial falsification by the Falsifier AND a deterministic verbatim grounding check. ONLY these claims may ground your consensus reasoning.
2. excludedClaims: every other claim — falsified by the Falsifier, or unverifiable because the evidence was missing, partial, ambiguous, or failed the grounding check. You may ONLY use these to write the gaps list. Never promote an excluded claim into the consensus.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- consensus: a 3-5 sentence plain-language summary of what the evidence overall supports, written for someone who has not read the source material. You may only reason from survivedClaims. If few claims survived, say so clearly and lower your confidence in the conclusion. Mention how many claims were falsified or left unverifiable and were therefore excluded from the conclusion — do not soften or omit this.
- If a crossExaminationResult with non-empty conflicts is provided, explicitly mention the disagreement and which sources conflict, rather than smoothing it into a single averaged conclusion.
- gaps: a list of up to 5 short strings, each describing a specific area where evidence was missing, contradictory, or where verification could not be completed. Each excludedClaim is a gap: describe why it did not survive (falsified, unverifiable, or failed the grounding check). If there are no meaningful gaps, return an empty array — do not invent gaps to fill the list.
- Do not add claims, sources, or conclusions beyond what is present in the input.

Output schema:
{"consensus": "string", "gaps": ["string"]}`;

const FALLBACK_PARSE_FAILURE = {
  consensus:
    "Synthesis failed — model output could not be parsed. See individual claim verifications above.",
  gaps: [] as string[],
};

// Safety cap on the synthesizer LLM call — same rationale as the falsifier's cap
// (45s headroom over observed latency). A timeout rejects the callRuntime
// promise, which the existing catch below routes through the same parse-failure
// fallback as a malformed response.
const SYNTHESIZER_CALL_TIMEOUT_MS = 45_000;

/** One-line gap entry for an excluded claim. */
function excludedClaimGap(c: VerifiedClaim): string {
  const why =
    c.graphStatus === "falsified"
      ? "falsified by the Falsifier"
      : c.status === "unverifiable"
        ? "evidence unverifiable or failed the verbatim grounding check"
        : "did not survive the integrity gate";
  const text = c.text.length > 140 ? `${c.text.slice(0, 137)}…` : c.text;
  return `${text} — ${why}`;
}

/**
 * The Synthesizer (Arbiter) is HARD-GATED by the Claim Graph: it may only
 * reason from claims that survived adversarial falsification plus the
 * deterministic grounding check. The orchestrator passes `survivedClaims`
 * (consensus input) and `excludedClaims` (gaps-only input) as separate lists,
 * and the prompt enforces the boundary as well — excluded claims can never be
 * promoted into the consensus.
 */
export async function runSynthesizer(
  input: string,
  survivedClaims: VerifiedClaim[],
  excludedClaims: VerifiedClaim[],
  onEvent: (e: AgentEvent) => void,
  crossExamination?: CrossExaminationResult | null
): Promise<{ consensus: string; gaps: string[] }> {
  const total = survivedClaims.length + excludedClaims.length;

  onEvent({
    agent: "synthesizer",
    status: "started",
    message: `Arbitrating a consensus from ${survivedClaims.length} survived claim(s) (${excludedClaims.length} excluded by the integrity gate)...`,
    timestamp: Date.now(),
  });

  if (survivedClaims.length === 0) {
    // Nothing passed the gate — the Arbiter has nothing to reason from. This is
    // a deterministic, honest result; no LLM call is needed to state it.
    onEvent({
      agent: "synthesizer",
      status: "done",
      message:
        "No claims survived the integrity gate — filing a gated consensus with no grounded conclusions.",
      timestamp: Date.now(),
    });
    return {
      consensus:
        total === 0
          ? "No attributed claims were found in the input to verify."
          : "No claims survived the scientific integrity gate. Every claim was either falsified by the Falsifier or could not be verified against source text (missing, partial, or ambiguous evidence, or a quote that failed the deterministic grounding check). No conclusion can be grounded from this analysis.",
      gaps: excludedClaims.slice(0, 5).map(excludedClaimGap),
    };
  }

  const userMessage = JSON.stringify({
    survivedClaims: survivedClaims.map((c) => ({
      text: c.text,
      status: c.status,
      matchedSource: c.matchedSource,
      reasoning: c.reasoning,
      confidence: c.confidence,
      citationLabel: c.citedAs,
    })),
    // Gaps-only input: the Arbiter may describe these as gaps but never reason
    // from them in the consensus.
    excludedClaims: excludedClaims.map((c) => ({
      text: c.text,
      status: c.status,
      graphStatus: c.graphStatus ?? "unverifiable",
      citationLabel: c.citedAs,
    })),
    // Passed only when the Cross-Examiner actually identified conflicts — the
    // synthesizer must mention them, not average them away.
    crossExamination: crossExamination?.conflicts?.length
      ? { conflicts: crossExamination.conflicts, summary: crossExamination.summary }
      : null,
  });

  try {
    let runtimeRes = await withTimeout(
      callRuntime({
        model: FREE_MODELS.default,
        messages: [
          { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        maxTokens: 500,
        responseFormat: "json_object",
      }),
      SYNTHESIZER_CALL_TIMEOUT_MS,
      "Synthesizer API call"
    );

    const emitCostEvent = (res: RuntimeResult) => {
      onEvent({
        agent: "synthesizer",
        status: "streaming",
        message: "Synthesis received from Runtime API.",
        cacheTier: res.cacheTier,
        benchmarkCost: res.benchmarkCost,
        customerCharge: res.customerCharge,
        timestamp: Date.now(),
      });
    };
    emitCostEvent(runtimeRes);

    const parseSynthesis = (): { consensus: string; gaps: string[] } => {
      const parsed = JSON.parse(runtimeRes.content);
      let consensus: string = FALLBACK_PARSE_FAILURE.consensus;
      let gaps: string[] = [];
      if (typeof parsed.consensus === "string") {
        consensus = parsed.consensus;
      }
      if (Array.isArray(parsed.gaps)) {
        gaps = parsed.gaps.filter((g: any) => typeof g === "string");
      }
      return { consensus, gaps };
    };

    let result: { consensus: string; gaps: string[] };
    try {
      result = parseSynthesis();
    } catch {
      // Malformed or empty JSON from the first attempt — retry exactly once
      // before giving up (same pattern as the extractor). The free-tier
      // reasoning models occasionally return an empty response under load.
      onEvent({
        agent: "synthesizer",
        status: "streaming",
        message: "Retrying synthesis after malformed JSON response",
        timestamp: Date.now(),
      });
      runtimeRes = await withTimeout(
        callRuntime({
          model: FREE_MODELS.default,
          messages: [
            { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          maxTokens: 500,
          responseFormat: "json_object",
        }),
        SYNTHESIZER_CALL_TIMEOUT_MS,
        "Synthesizer API call (retry)"
      );
      emitCostEvent(runtimeRes);
      try {
        result = parseSynthesis();
      } catch (retryParseError: any) {
        onEvent({
          agent: "synthesizer",
          status: "error",
          message: `Failed to parse synthesis JSON: ${retryParseError?.message || retryParseError}`,
          timestamp: Date.now(),
        });
        return FALLBACK_PARSE_FAILURE;
      }
    }

    onEvent({
      agent: "synthesizer",
      status: "done",
      message: "Synthesis complete.",
      timestamp: Date.now(),
    });

    return result;
  } catch (err: any) {
    onEvent({
      agent: "synthesizer",
      status: "error",
      message: `Synthesizer API call failed: ${err?.message || err}`,
      timestamp: Date.now(),
    });
    return FALLBACK_PARSE_FAILURE;
  }
}

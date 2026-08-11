import { callRuntime } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import { AgentEvent, CrossExaminationResult, VerifiedClaim } from "./types";

const SYNTHESIZER_SYSTEM_PROMPT = `You are the Synthesizer agent in a research verification pipeline.

You will receive a list of verified claims, each with a status (supported, unsupported, fabricated, unclear), matched source, and reasoning. Produce a final consensus summary.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- consensus: a 3-5 sentence plain-language summary of what the evidence overall supports, written for someone who has not read the source material. Mention any fabricated or unsupported claims explicitly and by how many there are — do not soften or omit this.
- If a crossExaminationResult with non-empty conflicts is provided, explicitly mention the disagreement and which sources conflict, rather than smoothing it into a single averaged conclusion.
- gaps: a list of up to 5 short strings, each describing a specific area where evidence was missing, contradictory, or where verification could not be completed. If there are no meaningful gaps, return an empty array — do not invent gaps to fill the list.
- Do not add claims, sources, or conclusions beyond what is present in the input.

Output schema:
{"consensus": "string", "gaps": ["string"]}`;

const FALLBACK_PARSE_FAILURE = {
  consensus:
    "Synthesis failed — model output could not be parsed. See individual claim verifications above.",
  gaps: [] as string[],
};

// Safety cap on the synthesizer LLM call — same rationale as the verifier's cap
// (45s headroom over observed latency). A timeout rejects the callRuntime
// promise, which the existing catch below routes through the same parse-failure
// fallback as a malformed response.
const SYNTHESIZER_CALL_TIMEOUT_MS = 45_000;

export async function runSynthesizer(
  input: string,
  claims: VerifiedClaim[],
  onEvent: (e: AgentEvent) => void,
  crossExamination?: CrossExaminationResult | null
): Promise<{ consensus: string; gaps: string[] }> {
  onEvent({
    agent: "synthesizer",
    status: "started",
    message: `Synthesizing consensus from ${claims.length} verified claim(s)...`,
    timestamp: Date.now(),
  });

  if (claims.length === 0) {
    onEvent({
      agent: "synthesizer",
      status: "done",
      message: "No claims to synthesize.",
      timestamp: Date.now(),
    });
    return {
      consensus: "No attributed claims were found in the input to verify.",
      gaps: [],
    };
  }

  const userMessage = JSON.stringify({
    claims: claims.map((c) => ({
      text: c.text,
      status: c.status,
      matchedSource: c.matchedSource,
      reasoning: c.reasoning,
      confidence: c.confidence,
    })),
    // Passed only when the Cross-Examiner actually identified conflicts — the
    // synthesizer must mention them, not average them away.
    crossExamination: crossExamination?.conflicts?.length
      ? { conflicts: crossExamination.conflicts, summary: crossExamination.summary }
      : null,
  });

  try {
    const runtimeRes = await withTimeout(
      callRuntime({
        model: "deepseek/deepseek-chat",
        messages: [
          { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        maxTokens: 500,
        // promptCacheKey: "synthesizer-v1",
        responseFormat: "json_object",
      }),
      SYNTHESIZER_CALL_TIMEOUT_MS,
      "Synthesizer API call"
    );

    onEvent({
      agent: "synthesizer",
      status: "streaming",
      message: "Synthesis received from Runtime API.",
      cacheTier: runtimeRes.cacheTier,
      benchmarkCost: runtimeRes.benchmarkCost,
      customerCharge: runtimeRes.customerCharge,
      timestamp: Date.now(),
    });

    let consensus: string = FALLBACK_PARSE_FAILURE.consensus;
    let gaps: string[] = [];

    try {
      const parsed = JSON.parse(runtimeRes.content);
      if (typeof parsed.consensus === "string") {
        consensus = parsed.consensus;
      }
      if (Array.isArray(parsed.gaps)) {
        gaps = parsed.gaps.filter((g: any) => typeof g === "string");
      }
    } catch (parseError: any) {
      onEvent({
        agent: "synthesizer",
        status: "error",
        message: `Failed to parse synthesis JSON: ${parseError?.message || parseError}`,
        timestamp: Date.now(),
      });
      return FALLBACK_PARSE_FAILURE;
    }

    onEvent({
      agent: "synthesizer",
      status: "done",
      message: "Synthesis complete.",
      timestamp: Date.now(),
    });

    return { consensus, gaps };
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

import { callRuntime } from "./runtime-client";
import { withTimeout } from "./with-timeout";
import { normalizeForGrounding } from "./agents/verifier";
import { getAnalysisId } from "./db";
import type {
  AgentEvent,
  AnalysisReport,
  ClaimStatusChange,
  HistorianBriefing,
} from "./agents/types";

const HISTORIAN_SYSTEM_PROMPT = `You are the Historian agent in a research verification pipeline. You compare the current analysis of a paper or claim against a previous analysis of the same paper or claim, and you write a short plain-language briefing of what changed.

You will receive structured data:
- claimChanges: claims that were verified in both runs, each with previousStatus, currentStatus, and changeType.
  changeType meanings:
  - "new_evidence": the claim was NOT supported before and now IS supported — new evidence surfaced that wasn't available last time.
  - "improved": the claim's verification standing improved (but it is not newly supported).
  - "regressed": the claim's verification standing worsened (e.g. supported became unclear or unsupported).
  - "no_change": the claim's status is unchanged.
- newClaimsCount: how many claims are present in the current run that had no counterpart in the previous run (nothing to diff against — mention them only briefly if notable).
- currentClaimsCount / priorClaimsCount: how many claims each run found.
- matchQuality: "matched" when at least some claims were successfully compared, or "no_overlap_found" when BOTH runs had claims but NONE of them could be matched across the runs (the claim wording differed enough that a direct comparison wasn't possible).
- newSourcesFound / sourcesNoLongerFound: source-level diff counts. NOTE: source-level tracking is not persisted yet, so these are always 0 — do not claim anything about sources beyond repeating the counts.

Rules:
- Output ONLY a plain-language summary of 2-3 sentences. No JSON, no headers, no preamble, no bullet lists.
- If matchQuality is "no_overlap_found": the summary MUST communicate that claim wording differed enough between the two runs that a direct comparison was not possible this time, and MUST state the current and prior claim counts. NEVER say or imply that no changes were detected — comparison failure is not evidence of stability. Example shape: "Claim wording differed enough between this run and the prior analysis that a direct comparison wasn't possible; this run found N claims, the prior found M."
- Otherwise, lead with the most notable movement: newly supported claims (new evidence), regressions, or an explicit "nothing changed" if the statuses are unchanged.
- Refer to claim counts plainly (e.g. "2 claims gained supporting evidence", "1 claim's status regressed to unclear").`;

/**
 * Historical verification standing of a status, high = better. Used only to
 * order "improved" vs "regressed"; "new_evidence" is handled separately below
 * because a claim becoming supported is a specific, notable event.
 */
const STATUS_SCORE: Record<string, number> = {
  supported: 3,
  fabricated: 2,
  unclear: 1,
  unsupported: 0,
};

function classifyChange(
  previousStatus: string,
  currentStatus: string
): ClaimStatusChange["changeType"] {
  if (previousStatus === currentStatus) return "no_change";

  const prev = STATUS_SCORE[previousStatus] ?? 1;
  const curr = STATUS_SCORE[currentStatus] ?? 1;

  if (curr > prev) {
    // New supporting evidence surfaced: previously not supported, now supported.
    return currentStatus === "supported" ? "new_evidence" : "improved";
  }
  return "regressed";
}

/**
 * Deterministic claim matching between two reports. Claims are matched by
 * normalized text: lowercase, punctuation stripped, whitespace collapsed,
 * trimmed — the same normalization the verifier uses for quote-grounding.
 * Matching is exact-first, then a CONTAINMENT fallback (one normalized claim's
 * text is a substring of the other's) guarded by a minimum length so tiny
 * fragments like "the model" can never match. No fuzzy scoring — pure string
 * ops. Exported for direct testing.
 */
export function matchClaimsBetween(
  currentReport: AnalysisReport,
  priorReport: AnalysisReport
): { claimChanges: ClaimStatusChange[]; newClaimCount: number } {
  // Reuses the verifier's canonical normalization for exact string matching
  // (lowercase, punctuation stripped, whitespace collapsed, trimmed).
  const normalizeClaimText = normalizeForGrounding;

  // Claims shorter than this can only match exactly — containment must not
  // fire on fragments (they are too ambiguous to be the same claim).
  const MIN_CONTAINMENT_LENGTH = 30;

  const priorClaims = priorReport.claims.map((claim) => ({
    text: claim.text,
    norm: normalizeClaimText(claim.text),
    status: claim.status,
  }));

  // Exact pass.
  const priorStatusByClaim = new Map<string, string>();
  for (const claim of priorClaims) {
    if (claim.norm) priorStatusByClaim.set(claim.norm, claim.status);
  }

  /** Deterministic containment match — most specific (longest contained) prior claim. */
  function findContainedMatch(norm: string): string | undefined {
    let bestShorterLength = -1;
    let bestStatus: string | undefined;
    for (const prior of priorClaims) {
      if (!prior.norm) continue;
      const shorter = norm.length <= prior.norm.length ? norm : prior.norm;
      const longer = norm.length <= prior.norm.length ? prior.norm : norm;
      if (shorter.length < MIN_CONTAINMENT_LENGTH) continue;
      if (longer.includes(shorter) && shorter.length > bestShorterLength) {
        bestShorterLength = shorter.length;
        bestStatus = prior.status;
      }
    }
    return bestStatus;
  }

  const claimChanges: ClaimStatusChange[] = [];
  let newClaimCount = 0;

  for (const claim of currentReport.claims) {
    const norm = normalizeClaimText(claim.text);
    if (!norm) {
      newClaimCount++;
      continue; // no usable text — cannot be matched or diffed
    }
    const previousStatus =
      priorStatusByClaim.get(norm) ?? findContainedMatch(norm);
    if (!previousStatus) {
      newClaimCount++; // new claim — nothing to diff against
      continue;
    }

    claimChanges.push({
      claimText: claim.text,
      previousStatus,
      currentStatus: claim.status,
      changeType: classifyChange(previousStatus, claim.status),
    });
  }

  return { claimChanges, newClaimCount };
}

/** Templated fallback — used only when the summary LLM call fails or times out. */
function buildFallbackSummary(
  changes: ClaimStatusChange[],
  newClaimsCount: number,
  matchQuality: HistorianBriefing["matchQuality"],
  currentClaimsCount: number,
  priorClaimsCount: number,
  priorGeneratedAt: number
): string {
  // Comparison failure, not stability: never imply "no changes" when the runs'
  // claims didn't overlap enough to compare.
  if (matchQuality === "no_overlap_found") {
    const filed = new Date(priorGeneratedAt).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    return `Claim wording differed enough between this run and the prior analysis (filed ${filed}) that a direct comparison wasn't possible. This run found ${currentClaimsCount} claim${currentClaimsCount === 1 ? "" : "s"}; the prior run found ${priorClaimsCount}.`;
  }

  const newlySupported = changes.filter((c) => c.changeType === "new_evidence").length;
  const improved = changes.filter((c) => c.changeType === "improved").length;
  const regressed = changes.filter((c) => c.changeType === "regressed").length;
  const unchanged = changes.filter((c) => c.changeType === "no_change").length;

  const sentences: string[] = [];
  if (changes.length === 0) {
    sentences.push(
      "No claims were verified in either run, so there is nothing to compare."
    );
  } else {
    const movement: string[] = [];
    if (newlySupported > 0) {
      movement.push(
        `${newlySupported} claim${newlySupported === 1 ? "" : "s"} gained supporting evidence`
      );
    }
    if (improved > 0) {
      movement.push(
        `${improved} claim${improved === 1 ? "" : "s"} improved but without new supporting evidence`
      );
    }
    if (regressed > 0) {
      movement.push(
        `${regressed} claim${regressed === 1 ? "" : "s"} regressed`
      );
    }
    sentences.push(
      movement.length > 0
        ? `Since the last analysis, ${movement.join(", ")}.`
        : `Since the last analysis, all ${unchanged} matched claim${unchanged === 1 ? "" : "s"} kept the same status.`
    );
  }
  if (newClaimsCount > 0) {
    sentences.push(
      `${newClaimsCount} claim${newClaimsCount === 1 ? " was" : "s were"} newly extracted this run with no prior counterpart to compare against.`
    );
  }
  sentences.push("Source-level changes are not tracked yet.");
  return sentences.join(" ");
}

/**
 * The Historian — a lightweight, mechanical diff between the current report and
 * the most recent prior saved analysis of the same paper/claim, plus ONE LLM
 * call that turns the structured diff into a plain-language summary.
 *
 * Deliberately NOT a full agent: claim matching is mechanical string
 * comparison — exact match after normalization, with a deterministic
 * containment fallback (one claim's normalized text contained in the other's)
 * — and the summary call has a 45s cap with a templated fallback so a model
 * failure can never block the briefing.
 */
export async function generateHistorianBriefing(
  currentReport: AnalysisReport,
  priorReport: AnalysisReport,
  onEvent: (e: AgentEvent) => void
): Promise<HistorianBriefing> {
  onEvent({
    agent: "historian",
    status: "started",
    message: "Comparing this run against the last saved analysis of the same paper/claim…",
    timestamp: Date.now(),
  });

  // ── 1. Mechanical claim matching ────────────────────────────────────────
  const { claimChanges, newClaimCount } = matchClaimsBetween(
    currentReport,
    priorReport
  );

  // Both runs produced claims but none overlapped: the paraphrase-mismatch
  // case. This is a comparison failure, NOT evidence of stability — the
  // briefing must never imply "no changes" from it.
  const matchQuality: HistorianBriefing["matchQuality"] =
    claimChanges.length === 0 &&
    currentReport.claims.length > 0 &&
    priorReport.claims.length > 0
      ? "no_overlap_found"
      : "matched";

  // ── 2. Source diff ──────────────────────────────────────────────────────
  // AnalysisReport does not persist the retrieved source list, so a true
  // source-by-source diff is out of scope for this stage. Both counts are 0
  // and the summary prompt (and fallback) says so explicitly rather than
  // pretending to know.
  const newSourcesFound = 0;
  const sourcesNoLongerFound = 0;

  // ── 3. Plain-language summary — ONE LLM call, 45s cap, templated fallback ──
  let summary: string;
  try {
    const runtimeRes = await withTimeout(
      callRuntime({
        model: "deepseek/deepseek-chat",
        messages: [
          { role: "system", content: HISTORIAN_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              claimChanges,
              newClaimsCount: newClaimCount,
              currentClaimsCount: currentReport.claims.length,
              priorClaimsCount: priorReport.claims.length,
              matchQuality,
              newSourcesFound,
              sourcesNoLongerFound,
            }),
          },
        ],
        maxTokens: 300,
      }),
      45_000,
      "Historian summary call"
    );

    onEvent({
      agent: "historian",
      status: "streaming",
      message: "Briefing summary drafted via Runtime API.",
      cacheTier: runtimeRes.cacheTier,
      benchmarkCost: runtimeRes.benchmarkCost,
      customerCharge: runtimeRes.customerCharge,
      timestamp: Date.now(),
    });

    summary = runtimeRes.content.trim();
    if (!summary) throw new Error("empty summary from model");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[historian] summary draft failed, using templated fallback: ${msg}`);
    onEvent({
      agent: "historian",
      status: "error",
      message: "Briefing summary failed — filed a templated summary instead",
      timestamp: Date.now(),
    });
    summary = buildFallbackSummary(
      claimChanges,
      newClaimCount,
      matchQuality,
      currentReport.claims.length,
      priorReport.claims.length,
      priorReport.generatedAt
    );
  }

  onEvent({
    agent: "historian",
    status: "done",
    message: `Historian filed: ${claimChanges.length} claim change${claimChanges.length === 1 ? "" : "s"} on the record.`,
    timestamp: Date.now(),
  });

  return {
    priorAnalysisId: getAnalysisId(priorReport) ?? `prior-${priorReport.generatedAt}`,
    priorAnalyzedAt: priorReport.generatedAt,
    summary,
    claimChanges,
    matchQuality,
    newSourcesFound,
    sourcesNoLongerFound,
  };
}

import { callRuntime } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import { FREE_MODELS } from "../models";
import { ClaimGraph } from "../claim-graph";
import {
  AgentEvent,
  ExtractedClaim,
  FULL_DOCUMENT_SOURCE_LABEL,
  RetrievedSource,
  VerifiedClaim,
} from "./types";

/**
 * Falsifier system prompt — verifier-v5-adversarial.
 *
 * The Falsifier is adversarial by design: its job is to try to BREAK each
 * claim, not to confirm it. A claim may only be marked "survived" when the
 * Falsifier failed to break it AND a real, mechanically checkable quote
 * exists. The verdict vocabulary is deliberately smaller than the old
 * Verifier's: "unsupported" and "unclear" collapsed into "unverifiable",
 * because the only question that matters at this stage is whether the claim
 * can be grounded in real text or not.
 */
const FALSIFIER_SYSTEM_PROMPT = `You are the Falsifier agent in a constrained multi-agent research verification system.

Your job is to try to BREAK each claim, not to confirm it. You succeed when you produce a concrete reason the claim should not be trusted. Only if you fail to break it may the claim be marked "survived".

You will receive a list of claims (each with a source quote and citation label), a list of retrieved sources (title + abstract/summary from external literature databases), and — when the analyzed document's full text is available — per-claim excerpts of that document under the "${FULL_DOCUMENT_SOURCE_LABEL}" section.

Your job is to attempt to falsify each claim against the available text: external sources test the claim against OTHER papers, while the document excerpts let you test claims the paper makes about itself by cross-referencing DIFFERENT parts of the same paper.

Verdict rules:
- "supported" — you tried to falsify the claim and FAILED: a real, checkable quote exists in the matched source's text that states the same specific assertion as the claim.
- "fabricated" — the claim attributes something the source clearly does NOT say, and a real, checkable quote shows what the source actually says in its place.
- "unverifiable" — the evidence is missing, partial, or ambiguous: no available text states the specific assertion, and no text clearly contradicts it either. Default to this whenever you cannot break the claim but also cannot ground it in a real quote.

Critical rules:
- The claim's sourceQuote comes from the original document being checked, NOT from the retrieved sources. It is not evidence of anything. Matching a source by title or topic is not sufficient — you must find the specific assertion in that source's actual text.
- STRUCTURAL EXCLUSION: each document excerpt has the claim's OWN ORIGIN POINT REMOVED — the sentence the claim's sourceQuote was extracted from, plus 500 characters around it, is cut out (the excerpt header says so). The removed region is exactly where the claim came from; it is NOT evidence. You physically cannot see it, and you must never treat it as confirmation. Finding the claim's own sourceQuote (or near-identical text of it) anywhere in the excerpts is likewise not evidence.
- Matching against the document is for CROSS-REFERENCING: confirming a claim because a DIFFERENT sentence, paragraph, or section of the same paper states the same specific assertion (e.g. a numeric detail restated in the model-architecture section, the decoder description confirming an encoder claim, a methods or results sentence confirming an abstract-level claim). Evidence drawn from the document must come from text that REMAINS in the excerpts.
- Excerpts are labeled with the claim id they belong to, but every excerpt is the same document. To be mechanically verifiable, the supporting text for a claim must be quotable from THAT claim's own excerpt — do not quote text that appears only inside another claim's excerpt (it may sit inside this claim's excluded origin region, which is not evidence for this claim).
- External corroboration is stronger evidence than in-paper cross-referencing: when an external source's text actually contains the specific assertion, prefer it as matchedSource. Use the document when the external sources do not cover the specific detail (e.g. body-level details like model dimensions or layer counts that abstracts never mention).
- Attribution discipline: when you quote text from the document excerpts, matchedSource MUST be exactly "${FULL_DOCUMENT_SOURCE_LABEL}" — never attribute document text to an external source's title just because that external source is the same paper.
- Quoting discipline: evidenceQuote must be a single CONTIGUOUS verbatim run of the matched text. Never merge text from two places with an ellipsis ("...") — non-contiguous quotes cannot be mechanically verified and will be rejected.

Falsification discipline:
- You MUST output an evidenceQuote for ANY "supported" or "fabricated" verdict. That quote will be checked programmatically — if it is not found verbatim in the matched source's text, the claim is automatically downgraded to "unverifiable" regardless of your reasoning.
- For "supported", the quote must be a short (under 40 words) VERBATIM run copied from the matched source's text that states the same specific assertion as the claim.
- For "fabricated", the quote must be a short VERBATIM run from the matched source's text that shows what the source actually says in place of the claim.
- Never mark "supported" because a topic matches — only because the specific assertion is grounded in a real quote. For "unverifiable", evidenceQuote must be an empty string.
- If you cannot produce a verbatim excerpt from the matched source's text, the verdict must be "unverifiable", not "supported".

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- For each claim, classify status as one of: "supported", "fabricated", or "unverifiable".
- matchedSource should be the title of the best-matching retrieved source, or exactly "${FULL_DOCUMENT_SOURCE_LABEL}" when the supporting text comes from the analyzed document's own full-text excerpt, or null if none.
- reasoning must be one sentence explaining the classification, and must reference the SPECIFIC TEXT that supports the classification — not a source's title or general topic alone. When the evidence comes from the document, note that it comes from a different part of the paper than the claim's own sourceQuote. If you cannot quote or closely paraphrase supporting text, the status cannot be "supported."
- confidence is a number from 0 to 1 reflecting how certain you are in the classification itself.
- Do not fabricate sources. Only reference text given to you.
- confirmedByMultipleSources marks sources independently indexed by more than one literature database (e.g. arXiv, Semantic Scholar, OpenAlex). Treat it as a credibility signal, but it never substitutes for checking whether that source's actual text states the specific claim being verified.

Output schema:
{"results": [{"claimId": "string", "status": "supported|fabricated|unverifiable", "matchedSource": "string|null", "evidenceQuote": "string", "reasoning": "string", "confidence": number}]}`;

// Safety cap on the falsifier LLM call. Observed latency was 21.7s (measured
// 2026-08), and the full-document self-verification feature made the prompt
// ~4x larger, so 60s (matching the extractor's outer cap) gives ~1.5x headroom
// while still failing fast on a genuinely hung request. With the runtime
// client's per-attempt cap at 40s (ATTEMPT_TIMEOUT_MS), a first-model timeout
// leaves ~20s for the fallback model to actually complete — vs ~5s at the old
// 45s outer cap, which would have killed the fallback almost immediately. A
// timeout here rejects the callRuntime promise, which the existing catch below
// routes through the same parse-failure fallback as a malformed response (all
// claims -> "unverifiable").
const FALSIFIER_CALL_TIMEOUT_MS = 60_000;

const UNVERIFIABLE_FALLBACK = {
  status: "unverifiable" as const,
  matchedSource: null,
  evidenceQuote: "",
  reasoning: "Falsification failed — model output could not be parsed",
  confidence: 0,
};

// ── Full-document excerpt tuning ───────────────────────────────────────────
// Per the structural self-match exclusion: each claim's evidence excerpt is the
// document with a window around the claim's own sourceQuote removed, then
// capped so the prompt stays a reasonable size.
const DOC_EXCLUDE_RADIUS = 500; // chars removed before/after the located sourceQuote
const DOC_EXCERPT_MAX_CHARS = 7000; // per-claim excerpt cap (user range: 6000-8000)
const DOC_OPENING_CHARS = 2000; // always keep the document opening (title + abstract)
// The extractor only ever saw the first 12000 characters of the document (see
// runExtractor's truncation), so a claim's sourceQuote MUST have originated
// within that window. When locating the origin point we therefore prefer
// occurrences inside the window: an occurrence found only beyond it is almost
// certainly a restatement, not the origin, and excluding it instead of the true
// origin would leave the origin sentence visible to the model.
const EXTRACTOR_TEXT_WINDOW = 12000;

/**
 * Normalizes text for deterministic quote-grounding: lowercase, punctuation
 * stripped, whitespace collapsed. A hyphen is treated as a WORD SEPARATOR
 * (space), not dropped: PDF extraction splits hyphenated compounds across line
 * ends ("English-\nto-German"), which otherwise would normalize to
 * "english togerman" while the model's clean "English-to-German" normalizes to
 * "englishtogerman" — a genuine verbatim quote would fail grounding, and the
 * claim's origin point would not be located for structural exclusion. Treating
 * the hyphen as a space makes both spellings normalize identically.
 */
export function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a normalized copy of `text` (identical normalization to
 * normalizeForGrounding) while recording, for each normalized character, the
 * index it came from in the original text. This lets us locate a quote in the
 * normalized text and map the hit back to original character offsets — needed
 * because PDF extraction may differ from the extracted sourceQuote in
 * whitespace and punctuation (line breaks, hyphens, etc.) even though the two
 * match once normalized.
 */
function normalizeWithOffsets(text: string): { normalized: string; offsets: number[] } {
  let normalized = "";
  const offsets: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const lower = text[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(lower)) {
      normalized += lower;
      offsets.push(i);
      prevSpace = false;
    } else if (/\s/u.test(lower) || lower === "-") {
      // A hyphen is a word separator (see normalizeForGrounding) — it emits a
      // space like any other whitespace, so offsets stay aligned.
      if (!prevSpace && normalized.length > 0) {
        normalized += " ";
        offsets.push(i);
        prevSpace = true;
      }
    }
    // punctuation and everything else is stripped, matching normalizeForGrounding
  }
  // normalizeForGrounding trims; keep the offsets in sync with the trimmed
  // string (leading space is never emitted, so only the trailing one can exist).
  const trimmed = normalized.trimEnd();
  if (trimmed.length < normalized.length) {
    normalized = trimmed;
    offsets.length = trimmed.length;
  }
  return { normalized, offsets };
}

/**
 * Locates a quote within the normalized document text and maps the hit back to
 * original character offsets. The extractor occasionally elides parts of a
 * quote with "...", which makes the full quote non-contiguous — in that case
 * locate by elision-free chunks, preferring the quote's BEGINNING (its start is
 * the best proxy for the origin point) over a later chunk that might sit in a
 * different passage.
 */
function locateQuote(
  normalized: string,
  offsets: number[],
  rawQuote: string,
  normalizedQuote: string,
  maxOriginOffset: number
): { quoteStart: number; quoteEnd: number } | null {
  // First occurrence of `needle` whose original offset is inside the extractor's
  // window (where the quote came from); falls back to the earliest occurrence
  // overall so a genuinely out-of-window quote still gets an anchor.
  const findOccurrence = (needle: string): { quoteStart: number; quoteEnd: number } | null => {
    let first: { quoteStart: number; quoteEnd: number } | null = null;
    let from = 0;
    for (;;) {
      const hit = normalized.indexOf(needle, from);
      if (hit < 0) break;
      const quoteStart = offsets[hit];
      const quoteEnd = offsets[hit + needle.length - 1] + 1;
      if (!first) first = { quoteStart, quoteEnd };
      if (quoteStart < maxOriginOffset) return { quoteStart, quoteEnd };
      from = hit + 1;
    }
    return first;
  };

  const chunks = rawQuote
    .split(/…|\.{2,}/)
    .map((c) => normalizeForGrounding(c))
    .filter((c) => c.length > 0);

  let result = findOccurrence(normalizedQuote);
  if (!result) {
    let fallback: { quoteStart: number; quoteEnd: number } | null = null;
    for (const chunk of chunks) {
      const r = findOccurrence(chunk);
      if (!r) continue;
      if (chunk.length >= 15) {
        result = r; // substantial chunk from the quote's beginning — good anchor
        break;
      }
      if (!fallback) fallback = r;
    }
    if (!result && fallback) result = fallback;
  }
  return result;
}

export interface ClaimExcerpt {
  claimId: string;
  text: string;
  /** Char span of the claim's sourceQuote in the full document (absent when not located). */
  sourceQuoteSpan?: { start: number; end: number };
  /** The window excluded around the sourceQuote (absent when not located). */
  exclusionSpan?: { start: number; end: number };
}

/**
 * Assembles a per-claim document excerpt with the origin window cut out:
 * the document opening (title + abstract) is always kept, then the sections
 * AFTER the origin point (where cross-referencing restatements most often
 * live), then the sections BEFORE it — capped at maxChars total. The excluded
 * hole is explained in a header so the model knows why the text jumps.
 */
function assembleExcerpt(
  fullText: string,
  exclusionSpan: { start: number; end: number },
  excludeRadius: number,
  maxChars: number
): string {
  const header = `[The claim's own origin point — its sourceQuote and ${excludeRadius} characters around it — has been excluded from this excerpt and is NOT evidence]`;

  const pieces: Array<{ label: string; start: number; end: number }> = [
    {
      label: "Document opening (title and abstract)",
      start: 0,
      end: Math.min(DOC_OPENING_CHARS, exclusionSpan.start),
    },
    {
      label: "Sections after the claim's origin point",
      start: exclusionSpan.end,
      end: fullText.length,
    },
    {
      label: "Sections before the claim's origin point",
      start: DOC_OPENING_CHARS,
      end: exclusionSpan.start,
    },
  ];

  let out = header;
  for (const p of pieces) {
    if (p.end <= p.start) continue;
    const chunk = fullText.slice(p.start, p.end).trim();
    if (!chunk) continue;
    const room = maxChars - out.length;
    if (room < 60) break;
    const label = `\n\n[${p.label}]\n`;
    if (label.length + 40 > room) break;
    out += label;
    const chunkRoom = maxChars - out.length;
    out += chunk.length <= chunkRoom ? chunk : chunk.slice(0, chunkRoom);
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars).trim();
}

/**
 * STRUCTURAL SELF-MATCH EXCLUSION — the heart of full-text self-verification.
 *
 * For EACH claim individually: locate the claim's own sourceQuote within the
 * full document text; if found, cut a window of `excludeRadius` characters
 * before and after that match (DOC_EXCLUDE_RADIUS = 500) out of the copy of the
 * document that becomes THAT claim's evidence. The origin point is where the
 * claim was extracted from, so it is expected to contain the claim's wording —
 * it can never serve as confirmation. The model therefore can only support a
 * claim from document text that exists SOMEWHERE ELSE in the paper. This is a
 * structural exclusion applied before anything reaches the model — not a
 * prompt instruction.
 *
 * If the sourceQuote cannot be located (extraction paraphrased it, or it came
 * from a different source), there is nothing to exclude — the capped full text
 * is used as-is for that claim, with a header making clear that no exclusion
 * applied and that the claim's own sourceQuote is still not evidence.
 *
 * Known edge: when the sourceQuote appears multiple times inside the
 * extractor's window, the FIRST in-window occurrence is treated as the origin.
 * If a genuine restatement precedes the true origin, the exclusion lands
 * around the restatement and the true origin sentence stays visible — an
 * inherent limit of locating without the extractor's position metadata (the
 * sourceQuote-is-not-evidence prompt rule remains as the second layer).
 *
 * The excerpt is capped (DOC_EXCERPT_MAX_CHARS = 7000) preferring the abstract
 * plus the sections after the origin point, where cross-referencing
 * restatements most often live.
 */
export function buildClaimExcerpts(
  fullText: string,
  claims: ExtractedClaim[],
  excludeRadius = DOC_EXCLUDE_RADIUS,
  maxChars = DOC_EXCERPT_MAX_CHARS
): ClaimExcerpt[] {
  const { normalized, offsets } = normalizeWithOffsets(fullText);
  const excerpts: ClaimExcerpt[] = [];
  const noExclusionHeader =
    "[The claim's sourceQuote could not be located in the document, so no origin-point exclusion was applied to this excerpt. The claim's own sourceQuote (or near-identical text of it) is still NOT evidence for this claim]";

  for (const claim of claims) {
    const quote = normalizeForGrounding(claim.sourceQuote);
    if (!quote) {
      // No origin to exclude — send the capped document opening as-is, with a
      // header explaining that the structural exclusion did not apply here.
      excerpts.push({
        claimId: claim.id,
        text: `${noExclusionHeader}\n\n${fullText.slice(0, maxChars)}`.slice(0, maxChars),
      });
      continue;
    }

    const located = locateQuote(
      normalized,
      offsets,
      claim.sourceQuote,
      quote,
      EXTRACTOR_TEXT_WINDOW
    );
    if (!located) {
      // sourceQuote not located — nothing to exclude; use the capped full text.
      excerpts.push({
        claimId: claim.id,
        text: `${noExclusionHeader}\n\n${fullText.slice(0, maxChars)}`.slice(0, maxChars),
      });
      continue;
    }

    const { quoteStart, quoteEnd } = located;
    const exclusionSpan = {
      start: Math.max(0, quoteStart - excludeRadius),
      end: Math.min(fullText.length, quoteEnd + excludeRadius),
    };

    excerpts.push({
      claimId: claim.id,
      text: assembleExcerpt(fullText, exclusionSpan, excludeRadius, maxChars),
      sourceQuoteSpan: { start: quoteStart, end: quoteEnd },
      exclusionSpan,
    });
  }

  return excerpts;
}

/**
 * Minimum character distance (in the full document) between an evidenceQuote
 * occurrence OUTSIDE the excluded origin window and the claim's own sourceQuote
 * span. Undefined when the quote is absent outside the window. Used to confirm
 * that document-supported claims rest on genuine cross-referencing, not on text
 * that merely brushed past the exclusion edge.
 */
export function minQuoteToOriginDistance(
  fullText: string,
  sourceQuoteSpan: { start: number; end: number },
  exclusionSpan: { start: number; end: number },
  evidenceQuote: string
): number | undefined {
  const { normalized, offsets } = normalizeWithOffsets(fullText);
  const q = normalizeForGrounding(evidenceQuote);
  if (!q) return undefined;

  let minDist = Infinity;
  let from = 0;
  for (;;) {
    const hit = normalized.indexOf(q, from);
    if (hit < 0) break;
    const eStart = offsets[hit];
    const eEnd = offsets[hit + q.length - 1] + 1;
    // Only occurrences OUTSIDE the excluded window count — anything inside it
    // was not visible to the model.
    if (eEnd <= exclusionSpan.start || eStart >= exclusionSpan.end) {
      const dist =
        eEnd <= sourceQuoteSpan.start
          ? sourceQuoteSpan.start - eEnd
          : eStart >= sourceQuoteSpan.end
            ? eStart - sourceQuoteSpan.end
            : 0;
      if (dist < minDist) minDist = dist;
    }
    from = hit + 1;
  }
  return minDist === Infinity ? undefined : minDist;
}

/**
 * Canonicalizes the model's matchedSource to the stable full-document label so
 * the grounding check and the UI always see the same string for in-paper
 * matches, whatever variant the model emits.
 */
function canonicalizeMatchedSource(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const lower = raw.toLowerCase().trim();
  // Exact (normalized) match on the canonical label first.
  if (normalizeForGrounding(lower) === normalizeForGrounding(FULL_DOCUMENT_SOURCE_LABEL)) {
    return FULL_DOCUMENT_SOURCE_LABEL;
  }
  // Near-variants the model may emit. Require BOTH a document-word and an
  // exclusion-word so an external paper whose title merely contains "full
  // text" or "source document" is not mis-canonicalized.
  if (
    (lower.includes("full text") || lower.includes("full document")) &&
    (lower.includes("origin point") || lower.includes("excerpt") || lower.includes("source document"))
  ) {
    return FULL_DOCUMENT_SOURCE_LABEL;
  }
  return raw.trim();
}

/**
 * Deterministic grounding check: returns false when the structured evidenceQuote
 * is missing/empty, or when it is not present (normalized) as a contiguous
 * substring of the matched source's text. The model's self-report is NOT
 * trusted, and there is no vacuous pass: every "supported"/"fabricated" claim
 * must carry a non-empty, mechanically verified verbatim quote or be downgraded
 * to "unverifiable". The check is identical for external abstracts and for the
 * document source — for the latter, the source text is the claim's own excerpt
 * (which has its origin point excluded), so quoting the origin back to itself
 * can never ground.
 */
function isReasonablyGrounded(evidenceQuote: string, matchedSourceText: string | null): boolean {
  if (!matchedSourceText) return false;

  const normalizedQuote = normalizeForGrounding(evidenceQuote);
  if (normalizedQuote.length === 0) return false; // empty/missing quote → not grounded

  const normalizedText = normalizeForGrounding(matchedSourceText);
  return normalizedText.includes(normalizedQuote);
}

/**
 * The Falsifier — the adversarial agent that owns the Claim Graph's terminal
 * transitions. For each claim it tries to find a concrete reason the claim
 * should not be trusted; only claims it fails to break AND that carry a real,
 * mechanically verified quote reach "survived".
 *
 * `graph` is the shared Claim Graph: every claim here was registered by the
 * Extractor (status "pending", or "under_challenge" on a Cross-Examiner
 * re-check), and this function is the ONLY caller of
 * ClaimGraph.resolveFalsifierVerdict — the only code path that moves a claim to
 * a terminal status.
 */
export async function runFalsifier(
  claims: ExtractedClaim[],
  sources: RetrievedSource[],
  onEvent: (e: AgentEvent) => void,
  graph: ClaimGraph,
  fullDocumentText?: string,
  recheck = false
): Promise<VerifiedClaim[]> {
  // The uploaded document's own full text (before the extractor's 12000-char
  // truncation) is an additional, always-available evidence source. Per-claim
  // excerpts structurally exclude each claim's own origin point.
  const hasFullDocument = Boolean(fullDocumentText && fullDocumentText.trim().length > 0);

  // Free-tier-only inference: plain runs use the stronger-reasoning falsifier
  // model; full-document runs (whose prompt is ~4x larger) use the long-context
  // model. No premium mode — cost is $0.00 either way.
  const model = hasFullDocument ? FREE_MODELS.fullText : FREE_MODELS.falsifier;
  const docExcerpts = hasFullDocument ? buildClaimExcerpts(fullDocumentText!, claims) : [];

  onEvent({
    agent: "falsifier",
    status: "started",
    message: recheck
      ? `Re-falsifying ${claims.length} challenged claim(s) after a cross-examiner contradiction (${model})...`
      : hasFullDocument
        ? `Attempting to falsify ${claims.length} claim(s) against ${sources.length} external source(s) and ${docExcerpts.length} full-document excerpt(s) with origin points excluded (${model})...`
        : `Attempting to falsify ${claims.length} claim(s) against ${sources.length} source(s) (${model})...`,
    timestamp: Date.now(),
  });

  if (claims.length === 0) {
    onEvent({
      agent: "falsifier",
      status: "done",
      message: "No claims to falsify.",
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
    ...(docExcerpts.length > 0
      ? {
          fullDocument: {
            label: FULL_DOCUMENT_SOURCE_LABEL,
            excerpts: docExcerpts.map(({ claimId, text }) => ({ claimId, text })),
          },
        }
      : {}),
  });

  let rawResults: any[] = [];
  let parseFailed = false;

  try {
    const runtimeRes = await withTimeout(
      callRuntime({
        model,
        messages: [
          { role: "system", content: FALSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        maxTokens: 1500,
        // promptCacheKey: "falsifier-v5",
        responseFormat: "json_object",
      }),
      FALSIFIER_CALL_TIMEOUT_MS,
      "Falsifier API call"
    );

    onEvent({
      agent: "falsifier",
      status: "streaming",
      message: "Falsification results received from Runtime API.",
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
        agent: "falsifier",
        status: "error",
        message: `Failed to parse falsification JSON: ${parseError?.message || parseError}`,
        timestamp: Date.now(),
      });
    }
  } catch (err: any) {
    parseFailed = true;
    onEvent({
      agent: "falsifier",
      status: "error",
      message: `Falsifier API call failed: ${err?.message || err}`,
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

  // Merge results back onto claims. The model's "unsupported"/"unclear" labels
  // (if it emits them) and any invalid label collapse into "unverifiable" — the
  // Falsifier's only non-verdict answer.
  const verified: VerifiedClaim[] = claims.map((claim) => {
    const match = parseFailed ? null : resultMap.get(claim.id);

    if (!match) {
      return {
        ...claim,
        ...UNVERIFIABLE_FALLBACK,
      };
    }

    const rawStatus = match.status;
    const status = rawStatus === "supported" || rawStatus === "fabricated"
      ? rawStatus
      : "unverifiable";

    return {
      ...claim,
      status,
      matchedSource: canonicalizeMatchedSource(match.matchedSource),
      evidenceQuote: typeof match.evidenceQuote === "string" ? match.evidenceQuote : "",
      reasoning: typeof match.reasoning === "string" ? match.reasoning : UNVERIFIABLE_FALLBACK.reasoning,
      confidence: typeof match.confidence === "number" ? Math.min(1, Math.max(0, match.confidence)) : 0,
    };
  });

  // Per-claim document excerpts — the exact document text each claim could see.
  const excerptByClaimId = new Map<string, string>();
  for (const e of docExcerpts) {
    excerptByClaimId.set(e.claimId, e.text);
  }

  // External source summaries by (lowercased) title — the only external text.
  const sourceTextByTitle = new Map<string, string>();
  for (const s of sources.slice(0, 15)) {
    const key = s.title.toLowerCase().trim();
    if (key && !sourceTextByTitle.has(key)) {
      sourceTextByTitle.set(key, s.summary.slice(0, 1200));
    }
  }

  // ── Source-attribution correction ─────────────────────────────────────────
  // The model sometimes quotes document text yet attributes the evidence to the
  // external paper's title (same paper identity), which grounding would then
  // rightly reject because the abstract never contains body-level detail. Fix
  // the attribution deterministically: a quote that is NOT present in the
  // claimed external source's text but IS present in this claim's document
  // excerpt — the only document text the model could quote — came from the
  // document, so relabel the claim to the full-document source. Because the
  // excerpt has the claim's origin point structurally excluded, any quote found
  // in it is necessarily a cross-reference, never the origin itself.
  const correctSourceAttribution = (vc: VerifiedClaim): VerifiedClaim => {
    if (vc.status !== "supported" && vc.status !== "fabricated") return vc;
    if (!vc.evidenceQuote.trim()) return vc;

    const isDocLabeled = vc.matchedSource === FULL_DOCUMENT_SOURCE_LABEL;

    // External attribution is fine as-is when the quote is really in that
    // source's text.
    if (!isDocLabeled) {
      const claimedText = vc.matchedSource
        ? sourceTextByTitle.get(vc.matchedSource.toLowerCase().trim()) ?? null
        : null;
      if (isReasonablyGrounded(vc.evidenceQuote, claimedText)) return vc;
    }

    // Not verified in the claimed source. Is it verified in the document
    // excerpt (origin point excluded) the model actually saw?
    if (hasFullDocument) {
      const excerpt = excerptByClaimId.get(vc.id);
      if (excerpt && isReasonablyGrounded(vc.evidenceQuote, excerpt)) {
        return { ...vc, matchedSource: FULL_DOCUMENT_SOURCE_LABEL };
      }
    }

    // The model sometimes quotes an EXTERNAL abstract — most often the same
    // paper's own abstract retrieved via the literature APIs, which is clean
    // text without the PDF's line-break hyphenation — but attributes the
    // evidence to the document (or to the wrong external title). Mirror the
    // correction above: relabel to whichever external source's text actually
    // contains the quote verbatim. Fully deterministic — the label only
    // changes when the quote is mechanically verified in the new source.
    for (const [title, text] of sourceTextByTitle) {
      if (isReasonablyGrounded(vc.evidenceQuote, text)) {
        return { ...vc, matchedSource: title };
      }
    }
    return vc;
  };

  const corrected = verified.map(correctSourceAttribution);

  // ── Deterministic grounding check ────────────────────────────────────────
  // The model's self-reported evidenceQuote is not trusted: any
  // "supported"/"fabricated" claim whose evidenceQuote is missing/empty or not
  // actually present (normalized) as a contiguous substring of the matched
  // source's text is downgraded to "unverifiable" — regardless of the model's
  // reasoning. Every such claim is checked — there is no vacuous pass path. For
  // document-labeled claims the matched source's text is the claim's own excerpt
  // (origin point excluded), so a self-matching origin quote can never ground.
  const downgradeSuffix = " [downgraded: quoted evidence not found verbatim in source text]";
  let downgradedCount = 0;
  let checkedCount = 0;

  const grounded: VerifiedClaim[] = corrected.map((vc) => {
    if (vc.status !== "supported" && vc.status !== "fabricated") {
      return vc;
    }
    checkedCount++;
    try {
      const sourceText =
        vc.matchedSource === FULL_DOCUMENT_SOURCE_LABEL
          ? excerptByClaimId.get(vc.id) ?? null
          : vc.matchedSource
            ? sourceTextByTitle.get(vc.matchedSource.toLowerCase().trim()) ?? null
            : null;
      if (!isReasonablyGrounded(vc.evidenceQuote, sourceText)) {
        downgradedCount++;
        return {
          ...vc,
          status: "unverifiable",
          // The full-document label claims a verified cross-reference; after a
          // downgrade that claim is false, so clear it rather than show a
          // misleading in-paper source on an unverifiable verdict.
          matchedSource:
            vc.matchedSource === FULL_DOCUMENT_SOURCE_LABEL ? null : vc.matchedSource,
          reasoning: vc.reasoning + downgradeSuffix,
          confidence: 0.5,
        };
      }
      return vc;
    } catch (err: any) {
      // Defensive: never let the grounding check crash the pipeline.
      console.warn(`[falsifier] grounding check skipped for claim ${vc.id}:`, err?.message || err);
      return vc;
    }
  });

  onEvent({
    agent: "falsifier",
    status: "streaming",
    message: `Grounding check downgraded ${downgradedCount} of ${checkedCount} claims to unverifiable (quoted evidence not verified against source text)`,
    timestamp: Date.now(),
  });

  // ── Evidence-to-origin distance for document-supported claims ─────────────
  // Records how far (in characters) the grounded evidence lies from the claim's
  // own sourceQuote, so a reader can confirm genuine cross-referencing rather
  // than evidence that merely brushed past the exclusion edge.
  const excerptMetaById = new Map<string, ClaimExcerpt>(
    docExcerpts.map((e) => [e.claimId, e] as [string, ClaimExcerpt])
  );

  const withDistance: VerifiedClaim[] = grounded.map((vc) => {
    if (vc.status !== "supported" && vc.status !== "fabricated") return vc;
    if (vc.matchedSource !== FULL_DOCUMENT_SOURCE_LABEL || !hasFullDocument) return vc;
    const meta = excerptMetaById.get(vc.id);
    if (!meta?.sourceQuoteSpan || !meta.exclusionSpan) return vc;
    const dist = minQuoteToOriginDistance(
      fullDocumentText!,
      meta.sourceQuoteSpan,
      meta.exclusionSpan,
      vc.evidenceQuote
    );
    return dist === undefined ? vc : { ...vc, documentEvidenceDistance: dist };
  });

  // ── Claim Graph: apply the hard status update ─────────────────────────────
  // The Falsifier is the only agent that may move a claim to a terminal status;
  // ClaimGraph.resolveFalsifierVerdict is the only writer. groundingCheckPassed
  // is true only when a "supported"/"fabricated" verdict carried a verbatim,
  // mechanically verified quote (so "supported" survives, "fabricated" is
  // falsified); everything else — including quotes that failed grounding —
  // lands on "unverifiable".
  const withGraphState: VerifiedClaim[] = withDistance.map((vc) => {
    const groundingCheckPassed = vc.status === "supported" || vc.status === "fabricated";
    const originPointExcluded =
      hasFullDocument && (excerptMetaById.get(vc.id)?.exclusionSpan != null);

    const node = graph.resolveFalsifierVerdict({
      id: vc.id,
      verdict: vc.status,
      groundingCheckPassed,
      originPointExcluded,
      evidenceQuote: vc.evidenceQuote,
      reason: recheck
        ? `Re-challenged by the Cross-Examiner — ${vc.reasoning}`
        : vc.reasoning,
    });

    return {
      ...vc,
      graphStatus: node.status,
      groundingCheckPassed: node.groundingCheckPassed,
      originPointExcluded: node.originPointExcluded,
      challenges: node.challenges,
      finalVerdict: node.finalVerdict,
    };
  });

  // Count per graph status for the done event
  const counts: Record<string, number> = {
    survived: 0,
    falsified: 0,
    unverifiable: 0,
  };
  for (const vc of withGraphState) {
    const key = vc.graphStatus ?? "unverifiable";
    counts[key] = (counts[key] || 0) + 1;
  }

  const summary =
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${status}`)
      .join(", ");

  onEvent({
    agent: "falsifier",
    status: "done",
    message: recheck
      ? `Re-check complete: ${summary} after the challenge.`
      : `Falsifier filed: ${summary}. Only survived claims may ground the consensus.`,
    timestamp: Date.now(),
  });

  return withGraphState;
}

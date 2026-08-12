import { callRuntime } from "../runtime-client";
import { withTimeout } from "../with-timeout";
import {
  AgentEvent,
  ExtractedClaim,
  FULL_DOCUMENT_SOURCE_LABEL,
  RetrievedSource,
  VerifiedClaim,
} from "./types";

const VERIFIER_SYSTEM_PROMPT = `You are the Verifier agent in a research verification pipeline.

You will receive a list of claims (each with a source quote and citation label), a list of retrieved sources (title + abstract/summary from external literature databases), and — when the analyzed document's full text is available — per-claim excerpts of that document under the "${FULL_DOCUMENT_SOURCE_LABEL}" section.

Your job is to determine, for each claim, whether the available text supports it: external sources corroborate the claim against OTHER papers, while the document excerpts let you confirm claims the paper makes about itself by cross-referencing DIFFERENT parts of the same paper.

Critical rules:
- The claim's sourceQuote comes from the original document being checked, NOT from the retrieved sources. It is not evidence of anything. Matching a source by title or topic is not sufficient — you must find the specific assertion in that source's actual text.
- STRUCTURAL EXCLUSION: each document excerpt has the claim's OWN ORIGIN POINT REMOVED — the sentence the claim's sourceQuote was extracted from, plus 500 characters around it, is cut out (the excerpt header says so). The removed region is exactly where the claim came from; it is NOT evidence. You physically cannot see it, and you must never treat it as confirmation. Finding the claim's own sourceQuote (or near-identical text of it) anywhere in the excerpts is likewise not evidence.
- Matching against the document is for CROSS-REFERENCING: confirming a claim because a DIFFERENT sentence, paragraph, or section of the same paper states the same specific assertion (e.g. a numeric detail restated in the model-architecture section, the decoder description confirming an encoder claim, a methods or results sentence confirming an abstract-level claim). Evidence drawn from the document must come from text that REMAINS in the excerpts.
- Excerpts are labeled with the claim id they belong to, but every excerpt is the same document. To be mechanically verifiable, the supporting text for a claim must be quotable from THAT claim's own excerpt — do not quote text that appears only inside another claim's excerpt (it may sit inside this claim's excluded origin region, which is not evidence for this claim).
- External corroboration is stronger evidence than in-paper cross-referencing: when an external source's text actually contains the specific assertion, prefer it as matchedSource. Use the document when the external sources do not cover the specific detail (e.g. body-level details like model dimensions or layer counts that abstracts never mention).
- Attribution discipline: when you quote text from the document excerpts, matchedSource MUST be exactly "${FULL_DOCUMENT_SOURCE_LABEL}" — never attribute document text to an external source's title just because that external source is the same paper.
- Quoting discipline: evidenceQuote must be a single CONTIGUOUS verbatim run of the matched text. Never merge text from two places with an ellipsis ("...") — non-contiguous quotes cannot be mechanically verified and will be rejected.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- For each claim, classify status as one of:
  - "supported": a retrieved source's text — or the document text outside the claim's own excluded origin point — explicitly states the same specific assertion as the claim (matching numbers, named entities, or specific outcomes).
  - "unsupported": NONE of the available text (external sources, or the document outside the claim's excluded origin point) mentions the claim's subject matter or topic AT ALL — the topic itself is absent, not just the specific detail.
  - "unclear": at least one source's text or the document discusses the SAME topic or subject as the claim (e.g. same paper, same mechanism, same general subject), but the specific detail, number, or outcome is not explicitly stated anywhere outside the claim's own excluded origin point. This is the correct label whenever text is topically relevant but doesn't confirm the precise assertion — do not use "unsupported" in this case. In particular, a claim whose specific detail appears only at its own origin point is "unclear", never "supported".
  - "fabricated": a retrieved source's text or the document's text directly contradicts the claim.
- Decision rule to apply before choosing between "unsupported" and "unclear": first check whether ANY available text is about the same subject/topic as the claim at all. If yes (even without confirming the specific detail), the status must be "unclear", never "unsupported". Only use "unsupported" when the topic itself is entirely absent from every source.
- Only mark "supported" or "fabricated" when you can point to specific text that directly confirms or contradicts the claim. Default to "unclear" over-guessing, and default to "unclear" rather than "supported" when a source's title matches the claim's subject but its summary text does not contain the specific detail being claimed.
- matchedSource should be the title of the best-matching retrieved source, or exactly "${FULL_DOCUMENT_SOURCE_LABEL}" when the supporting text comes from the analyzed document's own full-text excerpt, or null if none.
- reasoning must be one sentence explaining the classification, and must reference the SPECIFIC TEXT that supports the classification — not a source's title or general topic alone. When the evidence comes from the document, note that it comes from a different part of the paper than the claim's own sourceQuote. If you cannot quote or closely paraphrase supporting text, the status cannot be "supported."
- evidenceQuote is REQUIRED whenever status is 'supported' or 'fabricated'. It must be a short (under 40 words) VERBATIM excerpt copied exactly from the matched source's text — not a paraphrase, not from the claim's own sourceQuote. If you cannot produce a verbatim excerpt from the matched source's text, the status must be 'unclear' or 'unsupported', not 'supported'. For 'unclear' or 'unsupported' status, evidenceQuote should be an empty string.
- confidence is a number from 0 to 1 reflecting how certain you are in the classification itself.
- Do not fabricate sources. Only reference text given to you.
- confirmedByMultipleSources marks sources independently indexed by more than one literature database (e.g. arXiv, Semantic Scholar, OpenAlex). Treat it as a credibility signal, but it never substitutes for checking whether that source's actual text states the specific claim being verified.

Output schema:
{"results": [{"claimId": "string", "status": "supported|unsupported|fabricated|unclear", "matchedSource": "string|null", "evidenceQuote": "string", "reasoning": "string", "confidence": number}]}`;

// Safety cap on the verifier LLM call. Observed latency was 21.7s (measured
// 2026-08), and the full-document self-verification feature made the prompt
// ~4x larger, so 60s (matching the extractor's outer cap) gives ~1.5x headroom
// while still failing fast on a genuinely hung request. With the runtime
// client's per-attempt cap at 40s (ATTEMPT_TIMEOUT_MS), a first-model timeout
// leaves ~20s for the fallback model to actually complete — vs ~5s at the old
// 45s outer cap, which would have killed the fallback almost immediately. A
// timeout here rejects the callRuntime promise, which the existing catch below
// routes through the same parse-failure fallback as a malformed response (all
// claims -> "unclear").
const VERIFIER_CALL_TIMEOUT_MS = 60_000;

const UNCLEAR_FALLBACK = {
  status: "unclear" as const,
  matchedSource: null,
  evidenceQuote: "",
  reasoning: "Verification failed — model output could not be parsed",
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

/** Normalizes text for deterministic quote-grounding: lowercase, punctuation stripped, whitespace collapsed. */
export function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
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
    } else if (/\s/u.test(lower)) {
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
 * must carry a non-empty, mechanically verified verbatim quote or be downgraded.
 * The check is identical for external abstracts and for the document source —
 * for the latter, the source text is the claim's own excerpt (which has its
 * origin point excluded), so quoting the origin back to itself can never ground.
 */
function isReasonablyGrounded(evidenceQuote: string, matchedSourceText: string | null): boolean {
  if (!matchedSourceText) return false;

  const normalizedQuote = normalizeForGrounding(evidenceQuote);
  if (normalizedQuote.length === 0) return false; // empty/missing quote → not grounded

  const normalizedText = normalizeForGrounding(matchedSourceText);
  return normalizedText.includes(normalizedQuote);
}

export async function runVerifier(
  claims: ExtractedClaim[],
  sources: RetrievedSource[],
  onEvent: (e: AgentEvent) => void,
  fullDocumentText?: string
): Promise<VerifiedClaim[]> {
  // Single consistent cheap model tier across every agent — no premium mode.
  const model = "deepseek/deepseek-chat";

  // The uploaded document's own full text (before the extractor's 12000-char
  // truncation) is an additional, always-available evidence source. Per-claim
  // excerpts structurally exclude each claim's own origin point.
  const hasFullDocument = Boolean(fullDocumentText && fullDocumentText.trim().length > 0);
  const docExcerpts = hasFullDocument ? buildClaimExcerpts(fullDocumentText!, claims) : [];

  onEvent({
    agent: "verifier",
    status: "started",
    message: hasFullDocument
      ? `Verifying ${claims.length} claim(s) against ${sources.length} external source(s) and ${docExcerpts.length} full-document excerpt(s) with origin points excluded (${model})...`
      : `Verifying ${claims.length} claim(s) against ${sources.length} source(s) (${model})...`,
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
      matchedSource: canonicalizeMatchedSource(match.matchedSource),
      evidenceQuote: typeof match.evidenceQuote === "string" ? match.evidenceQuote : "",
      reasoning: typeof match.reasoning === "string" ? match.reasoning : UNCLEAR_FALLBACK.reasoning,
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
    return vc;
  };

  const corrected = verified.map(correctSourceAttribution);

  // ── Deterministic grounding check ────────────────────────────────────────
  // The model's self-reported evidenceQuote is not trusted: any "supported"/"fabricated"
  // claim whose evidenceQuote is missing/empty or not actually present (normalized)
  // as a contiguous substring of the matched source's text is downgraded to
  // "unclear". Every such claim is checked — there is no vacuous pass path. For
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
          status: "unclear",
          // The full-document label claims a verified cross-reference; after a
          // downgrade that claim is false, so clear it rather than show a
          // misleading in-paper source on an unclear verdict.
          matchedSource:
            vc.matchedSource === FULL_DOCUMENT_SOURCE_LABEL ? null : vc.matchedSource,
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

  // Count per status for done event
  const counts: Record<string, number> = { supported: 0, unsupported: 0, fabricated: 0, unclear: 0 };
  for (const vc of withDistance) {
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

  return withDistance;
}

# Reproducibility

## Models

All inference is routed through **Runtime** (`api.rntm.sh`), an OpenAI-compatible gateway, via **OpenRouter as the primary provider** with **Runtime's own gateway as an automatic fallback**.

| Agent | Default model | Notes |
|---|---|---|
| Retriever | `deepseek/deepseek-chat` | Query generation only; source fetching is deterministic (no LLM) |
| Extractor | `deepseek/deepseek-chat` | Originally `qwen/qwen-2.5-72b-instruct`; switched after diagnosis showed qwen intermittently hanging on OpenRouter with no response, silently forcing every "successful" call through a wasted 15–25s wait before falling back to deepseek anyway |
| Verifier | `deepseek/deepseek-chat` | Same tier as every other agent — no premium mode. PDF/full-document runs also cross-reference the paper's own full text via per-claim excerpts with the claim's origin point excluded (see [Full-text self-verification](#full-text-self-verification)) |
| Cross-Examiner | `deepseek/deepseek-chat` | Only invoked when ≥2 evidence-backed claims have ≥2 distinct matched sources |
| Synthesizer | `deepseek/deepseek-chat` | |
| Historian | `deepseek/deepseek-chat` | Only invoked when a prior analysis of the same input/document exists |

Fallback chain (OpenRouter path): `[preferred model, deepseek/deepseek-chat]`.
Fallback chain (Runtime gateway path, used if OpenRouter is unavailable): `[preferred model, btl-2, deepseek-v4-flash]`.
Each individual model attempt in a chain is capped at **40 seconds** (raised from 25s in 2026-08 — the verifier's full-document excerpts made its prompt ~4x larger, pushing slow first responses past the old cap); if it hangs or errors, the next model in the chain is tried automatically. Each agent call additionally has an outer cap: **60s for the Extractor and Verifier** (the two largest prompts — the verifier's was raised from 45s for the same reason), **45s for the Retriever, Synthesizer, Cross-Examiner, and Historian**. A timeout fails the stage gracefully — empty claims, all-unclear verdicts, or a skipped/templated optional stage — rather than failing the run. Extractor, Verifier, and Synthesizer timeouts are disclosed in the report's data-quality notes; the Retriever's query-generation timeout is silent by design, and a Cross-Examiner or Historian failure degrades to a skipped or templated stage.

## APIs / data sources

| Source | Purpose | Auth | Notes |
|---|---|---|---|
| **arXiv** (`export.arxiv.org/api/query`) | Topic search + targeted title search for the analyzed paper | None | Public API; occasionally rate-limits under sustained load. Title search uses a quoted `ti:` field query (unquoted queries return unrelated results, since arXiv only scopes the first token to the field). |
| **Semantic Scholar** (`api.semanticscholar.org/graph/v1`) | Topic search | API key (free tier) | Documented limit: 1 request/second, cumulative across all endpoints, per approved key. Enforced client-side via a promise-chain throttle so parallel queries don't violate this. Retry-with-backoff on 429s (max 2 attempts, 500ms/1500ms backoff). |
| **OpenAlex** (`api.openalex.org/works`) | Topic search | None (polite pool via `mailto` param) | Returns abstracts as an inverted-index (word→positions map), reconstructed to plain text client-side. Has not shown rate-limiting in testing. |

All three sources' results are merged by normalized title; when the same paper is found via more than one database, the longest available summary is kept and the source is flagged as `confirmedByMultipleSources` — a credibility signal surfaced to the Verifier (not treated as automatic evidence of any specific claim).

## Full-text self-verification

For PDF / pasted-document runs, the paper's own extracted text (the input text *before* the Extractor's 12,000-character truncation) is passed to the Verifier as an additional, always-available evidence source, and each claim is verified against **both** the external literature and the paper itself. All of the following is deterministic — applied in code before anything reaches the model:

1. **Origin-point location.** Each claim's `sourceQuote` is located in the full document text using normalization-aware matching (lowercase, punctuation stripped, whitespace collapsed, with original-offset mapping so PDF-extraction differences in whitespace/hyphenation don't matter). Occurrences inside the Extractor's 12,000-character window are preferred — a claim's quote must have originated there.
2. **Structural exclusion.** A window of ±500 characters around the located quote is removed from the copy of the document that becomes **that claim's** evidence. The model physically cannot see the sentence the claim was extracted from, so a claim can never be confirmed by quoting its own origin point.
3. **Capped excerpts.** Each claim's excerpt is capped at ~7,000 characters, keeping the document opening (title + abstract, ~2,000 chars, unless a very early origin point cuts it short) and preferring the sections AFTER the origin point, where cross-referencing restatements most often live. When the `sourceQuote` cannot be located, the capped full text is used as-is with an explicit header that the claim's own origin is still not evidence.
4. **Grounded like everything else.** The deterministic grounding check runs against the claim's own excerpt: the model's `evidenceQuote` must exist verbatim (normalized) in it. A source-attribution pass additionally relabels document quotes the model mis-attributed to an external paper's title — abstracts never contain body-level detail, so such a quote could only have come from the document.
5. **Distance reporting.** Supported in-paper claims carry `documentEvidenceDistance` — the minimum character distance between the evidence quote and the claim's own origin span — shown in the UI and PDF export as `In-paper evidence: N chars from claim's origin point`.

Because in-paper self-consistency is weaker evidence than external corroboration, the report and the PDF export label the two differently (`[In paper] Source Document (full text, cross-referenced)` vs `[External] …`), and the Verifier is instructed to prefer an external source whenever its text actually contains the specific assertion.

## Datasets

No training or fine-tuning was performed — PaperAgents is an inference-time pipeline. Test/validation was performed against real, published papers retrieved live from the sources above, primarily:

- *Attention Is All You Need* (Vaswani et al., 2017) — used as the primary validation paper across most of development, since it indexes reliably across all three literature sources
- A second, more recently published paper — used specifically to stress-test behavior against thin/inconsistent source indexing (see Known Limitations)

## Estimated run cost

Based on real measured runs (not estimates) using the project's single model configuration:

| Run type | Typical total cost | Range observed |
|---|---|---|
| Verifier, no prior analysis | ~$0.0013–0.0043 | Varies with claim count (typically 7–12) and source count (typically 20–30) |
| With Historian (prior analysis exists) | +~$0.0002–0.0005 | One additional lightweight summary call |
| With Cross-Examiner (gate conditions met) | +~$0.0002–0.0005 | Only runs when ≥2 multi-source-confirmed claims exist |

A full six-step run typically costs well under a cent. Prompt caching (Runtime's `prompt_cache_key` mechanism, used on the Runtime-gateway fallback path — OpenRouter does not support the same mechanism) has been observed reducing per-call cost by roughly half on a cache hit.

The verifier's full-document excerpts enlarge its prompt roughly 4x (up to ~104k characters in testing, ~7k per claim excerpt); the per-claim excerpt cap bounds that growth, and PDF-run costs in testing remained within the ranges above. Plain claim/arXiv runs (no full text) sit at the low end.

Pipeline latency: typically 40–110+ seconds end to end across all six steps, dominated by LLM response time rather than source-fetching (source retrieval across all three databases in parallel typically completes in under 10 seconds). PDF runs with full-text self-verification tend toward the upper end — the verifier's prompt is ~4x larger — which is also why its outer timeout is 60s.

## Known limitations

- **Recently published papers may have thin literature-database coverage.** A paper published only days before analysis may not yet be well-indexed by Semantic Scholar or OpenAlex, leading to reduced source coverage and more "unclear" verdicts than a well-established paper would produce. This is disclosed to the user via the report's data-quality notes rather than hidden, but it means verification confidence is lower for very new papers by nature of the literature ecosystem, not a flaw in the pipeline.
- **The grounding check only catches quoted-and-checkable fabrications.** The Verifier is required to produce a structured `evidenceQuote` field for any "supported"/"fabricated" verdict, and that quote is mechanically checked (exact, normalized substring match) against the retrieved source text — a claim cannot be marked "supported" without a real, checkable quote. This closes the most severe failure mode (confident overreach with no basis) but does not evaluate the *reasoning* prose for subtler misrepresentation.
- **Claim matching across repeated analyses (Historian) uses deterministic containment matching, not semantic matching.** Because claim extraction re-paraphrases wording slightly between runs, claims that are substantively the same but worded very differently between two analyses may not be recognized as matches. When this happens, the Historian explicitly reports that direct comparison wasn't possible (`matchQuality: "no_overlap_found"`) rather than falsely implying a confirmed "no change."
- **Cross-source overlap is typically modest.** Across testing, roughly 2–3 of ~27 retrieved sources per run are found by more than one of the three literature databases. This is expected given each database's distinct indexing and ranking, not an indication that cross-source verification is failing.
- **arXiv's public API is occasionally aggressively rate-limited** in ways outside this project's control; the three-source design with cross-validation is intended to make the pipeline resilient to any single source being temporarily unavailable, not to guarantee any individual source's uptime.
- **The Cross-Examiner's usefulness is bounded by the modest cross-source overlap above** — it can only compare evidence across different claims citing different sources (the pre-merge per-database text for a single merged source is not retained), so genuine detectable conflicts are relatively rare in practice. An empty "no conflicts found" result is the common and expected outcome, consistent with the design principle of not manufacturing disagreement.
- **Full-text self-verification is bounded by the Extractor's 12,000-character window.** A claim whose `sourceQuote` sits beyond that window — or was paraphrased enough to be unlocatable — gets no origin-point exclusion; the capped full text is used with a header, and the claim then relies on the prompt-level "sourceQuote is not evidence" rule alone.
- **Origin-point location is a heuristic.** When a claim's `sourceQuote` appears multiple times inside the Extractor's window, the FIRST occurrence is treated as the origin; if a genuine restatement precedes the true origin, the exclusion lands around the restatement and the true origin sentence stays visible (the prompt rule remains the second layer).
- **In-paper grounding is per-claim and excerpt-bounded.** The grounding check only accepts evidence present verbatim in THAT claim's own excerpt (origin excluded, ~7,000 chars). A quote drawn from another claim's excerpt, from beyond the excerpt cap, or hallucinated fails grounding and downgrades the claim to "unclear" — the same no-vacuous-pass rule as external sources, by design.
- **PDF title-guessing is a heuristic**, not a real title parser — it scans the first several non-empty lines of extracted text for a plausible title while filtering common boilerplate (copyright notices, arXiv preprint headers, page numbers), with a same-line fallback if nothing passes the filters. It can be wrong for PDFs with unusual layouts.
- **No user accounts or per-user data isolation.** Session restore and Historian comparisons operate on the single most recent / matching analysis in local storage; this is a single-user development/demo tool, not a multi-tenant product.
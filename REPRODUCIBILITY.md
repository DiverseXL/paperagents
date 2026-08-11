# Reproducibility

## Models

All inference is routed through **Runtime** (`api.rntm.sh`), an OpenAI-compatible gateway, via **OpenRouter as the primary provider** with **Runtime's own gateway as an automatic fallback**.

| Agent | Default model | Notes |
|---|---|---|
| Retriever | `deepseek/deepseek-chat` | Query generation only; source fetching is deterministic (no LLM) |
| Extractor | `deepseek/deepseek-chat` | Originally `qwen/qwen-2.5-72b-instruct`; switched after diagnosis showed qwen intermittently hanging on OpenRouter with no response, silently forcing every "successful" call through a wasted 15–25s wait before falling back to deepseek anyway |
| Verifier | `deepseek/deepseek-chat` (standard mode) or a Claude Sonnet–tier model via OpenRouter (`premium` mode, toggled with `VERIFIER_MODEL_MODE=premium`) | Premium mode showed materially better claim-classification precision in testing at a modest cost increase (see below) |
| Cross-Examiner | `deepseek/deepseek-chat` | Only invoked when ≥2 evidence-backed claims have ≥2 distinct matched sources |
| Synthesizer | `deepseek/deepseek-chat` | |
| Historian | `deepseek/deepseek-chat` | Only invoked when a prior analysis of the same input/document exists |

Fallback chain (OpenRouter path): `[preferred model, deepseek/deepseek-chat]`.
Fallback chain (Runtime gateway path, used if OpenRouter is unavailable): `[preferred model, btl-2, deepseek-v4-flash]`.
Each individual model attempt in a chain is capped at 25 seconds; if it hangs or errors, the next model in the chain is tried automatically within the agent's outer timeout budget.

## APIs / data sources

| Source | Purpose | Auth | Notes |
|---|---|---|---|
| **arXiv** (`export.arxiv.org/api/query`) | Topic search + targeted title search for the analyzed paper | None | Public API; occasionally rate-limits under sustained load. Title search uses a quoted `ti:` field query (unquoted queries return unrelated results, since arXiv only scopes the first token to the field). |
| **Semantic Scholar** (`api.semanticscholar.org/graph/v1`) | Topic search | API key (free tier) | Documented limit: 1 request/second, cumulative across all endpoints, per approved key. Enforced client-side via a promise-chain throttle so parallel queries don't violate this. Retry-with-backoff on 429s (max 2 attempts, 500ms/1500ms backoff). |
| **OpenAlex** (`api.openalex.org/works`) | Topic search | None (polite pool via `mailto` param) | Returns abstracts as an inverted-index (word→positions map), reconstructed to plain text client-side. Has not shown rate-limiting in testing. |

All three sources' results are merged by normalized title; when the same paper is found via more than one database, the longest available summary is kept and the source is flagged as `confirmedByMultipleSources` — a credibility signal surfaced to the Verifier (not treated as automatic evidence of any specific claim).

## Datasets

No training or fine-tuning was performed — PaperAgents is an inference-time pipeline. Test/validation was performed against real, published papers retrieved live from the sources above, primarily:

- *Attention Is All You Need* (Vaswani et al., 2017) — used as the primary validation paper across most of development, since it indexes reliably across all three literature sources
- A second, more recently published paper — used specifically to stress-test behavior against thin/inconsistent source indexing (see Known Limitations)

## Estimated run cost

Based on real measured runs (not estimates) using the standard-tier model configuration:

| Run type | Typical total cost | Range observed |
|---|---|---|
| Standard verifier, no prior analysis | ~$0.0013–0.0043 | Varies with claim count (typically 7–12) and source count (typically 20–30) |
| Premium verifier (Claude Sonnet–tier) | ~$0.003–0.004 | Modest increase over standard for materially stricter claim classification |
| With Historian (prior analysis exists) | +~$0.0002–0.0005 | One additional lightweight summary call |
| With Cross-Examiner (gate conditions met) | +~$0.0002–0.0005 | Only runs when ≥2 multi-source-confirmed claims exist |

A full six-step run typically costs well under a cent. Prompt caching (Runtime's `prompt_cache_key` mechanism, used on the Runtime-gateway fallback path — OpenRouter does not support the same mechanism) has been observed reducing per-call cost by roughly half on a cache hit.

Pipeline latency: typically 40–110 seconds end to end across all six steps, dominated by LLM response time rather than source-fetching (source retrieval across all three databases in parallel typically completes in under 10 seconds).

## Known limitations

- **Recently published papers may have thin literature-database coverage.** A paper published only days before analysis may not yet be well-indexed by Semantic Scholar or OpenAlex, leading to reduced source coverage and more "unclear" verdicts than a well-established paper would produce. This is disclosed to the user via the report's data-quality notes rather than hidden, but it means verification confidence is lower for very new papers by nature of the literature ecosystem, not a flaw in the pipeline.
- **The grounding check only catches quoted-and-checkable fabrications.** The Verifier is required to produce a structured `evidenceQuote` field for any "supported"/"fabricated" verdict, and that quote is mechanically checked (exact, normalized substring match) against the retrieved source text — a claim cannot be marked "supported" without a real, checkable quote. This closes the most severe failure mode (confident overreach with no basis) but does not evaluate the *reasoning* prose for subtler misrepresentation.
- **Claim matching across repeated analyses (Historian) uses deterministic containment matching, not semantic matching.** Because claim extraction re-paraphrases wording slightly between runs, claims that are substantively the same but worded very differently between two analyses may not be recognized as matches. When this happens, the Historian explicitly reports that direct comparison wasn't possible (`matchQuality: "no_overlap_found"`) rather than falsely implying a confirmed "no change."
- **Cross-source overlap is typically modest.** Across testing, roughly 2–3 of ~27 retrieved sources per run are found by more than one of the three literature databases. This is expected given each database's distinct indexing and ranking, not an indication that cross-source verification is failing.
- **arXiv's public API is occasionally aggressively rate-limited** in ways outside this project's control; the three-source design with cross-validation is intended to make the pipeline resilient to any single source being temporarily unavailable, not to guarantee any individual source's uptime.
- **The Cross-Examiner's usefulness is bounded by the modest cross-source overlap above** — it can only compare evidence across different claims citing different sources (the pre-merge per-database text for a single merged source is not retained), so genuine detectable conflicts are relatively rare in practice. An empty "no conflicts found" result is the common and expected outcome, consistent with the design principle of not manufacturing disagreement.
- **PDF title-guessing is a heuristic**, not a real title parser — it scans the first several non-empty lines of extracted text for a plausible title while filtering common boilerplate (copyright notices, arXiv preprint headers, page numbers), with a same-line fallback if nothing passes the filters. It can be wrong for PDFs with unusual layouts.
- **No user accounts or per-user data isolation.** Session restore and Historian comparisons operate on the single most recent / matching analysis in local storage; this is a single-user development/demo tool, not a multi-tenant product.
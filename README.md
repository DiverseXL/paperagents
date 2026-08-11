# PaperAgents

**A multi-agent citation verification desk.** Four specialists work in parallel to check whether a paper's claims actually hold up against the literature — a Retriever finds sources, an Extractor isolates claims, a Verifier checks each one against real source text, and a Synthesizer files the final report. A Cross-Examiner checks sources for disagreement, and a Historian remembers what changed since your last visit.

Every "supported" verdict is backed by a verbatim quote that's mechanically checked against the retrieved source text in code — not just asserted by the model. Built for the Research Agents Hack (IIT Madras, August 2026).

---

## What it does

Give PaperAgents a research claim, an arXiv link, or a PDF. It will:

1. **Retrieve** — search arXiv, Semantic Scholar, and OpenAlex in parallel, merge and deduplicate results, and flag any source independently confirmed by more than one database
2. **Extract** — pull every citation-attributed claim from the input, along with the exact quote and citation label it came from
3. **Verify** — check each claim against the retrieved sources' actual text. Every "supported" or "fabricated" verdict requires a verbatim evidence quote, which is checked programmatically against the source text before the verdict is allowed to stand. If the quote isn't really there, the claim is downgraded to "unclear" — regardless of what the model's reasoning says.
4. **Cross-examine** — check whether independently retrieved sources actually agree with each other on the same subject, surfacing genuine contradictions rather than manufacturing disagreement where none exists
5. **Synthesize** — produce a plain-language consensus, a list of evidence gaps, and (if you've analyzed this paper before) a Historian briefing on what changed since last time

Every run also discloses its own data quality — if a source API failed, an agent timed out, or extraction had to retry, the final report says so explicitly rather than presenting a degraded run as clean.

---

## Architecture

```
Next.js app
├── /                    landing page (the pitch)
├── /analyze             the product — paste a claim, upload a PDF, watch the pipeline run
├── /analyze/api/run     SSE endpoint: orchestrates all 6 steps, streams live events
├── /analyze/api/session restores the last completed analysis on page reload
├── /analyze/api/export-pdf   generates a downloadable PDF of any report
└── SQLite (better-sqlite3, on a persistent volume in production)
    └── analyses         one row per completed run — input, full report JSON, timestamps
        (powers session restore and the Historian's "since last time" comparisons)
```

### The pipeline

| Step | Role | Model (default) |
|---|---|---|
| Retriever | Generates search queries, fetches from arXiv, Semantic Scholar, and OpenAlex in parallel, merges duplicates across sources | `deepseek/deepseek-chat` |
| Extractor | Isolates every citation-attributed claim, with its verbatim source quote and citation label | `deepseek/deepseek-chat` |
| Verifier | Checks each claim against retrieved source text; requires a real, checkable quote for any "supported"/"fabricated" verdict | `deepseek/deepseek-chat` (standard) or a Claude Sonnet–tier model (premium mode) |
| Cross-Examiner | Compares evidence across multi-source-confirmed claims for genuine disagreement | `deepseek/deepseek-chat` |
| Synthesizer | Writes the final consensus, gap list, and cost rollup | `deepseek/deepseek-chat` |
| Historian | If this paper/claim was analyzed before, diffs the new verdicts against the prior run | `deepseek/deepseek-chat` |

Model choice for the Verifier is configurable via `VERIFIER_MODEL_MODE` (`standard` or `premium`) so you can iterate cheaply and switch to a stronger model for a final run.

---

## Powered by Runtime (BTL)

All LLM calls are routed through **[Runtime](https://rntm.sh)** (formerly Bad Theory Labs), an OpenAI-compatible inference gateway, with **OpenRouter as the primary provider and Runtime's own gateway as an automatic fallback** if the primary is unavailable.

Runtime provides:

- **Prompt caching** — each agent uses a fixed, versioned system prompt (`retriever-v1`, `verifier-v4`, etc.) paired with a stable cache key, so repeated calls on the same prompt structure can hit cache instead of paying full inference cost. Observed live: a cached call returned `benchmark: $0.000432 / charge: $0.000216` — roughly half the uncached cost on that call.
- **Per-call cost telemetry** — every response carries benchmark cost, actual charge, and cache tier, which PaperAgents surfaces live in the UI's cost meter and persists in every saved report.
- **Provider-level resilience** — if OpenRouter is unreachable or out of credits, calls automatically retry against Runtime's own gateway (`api.rntm.sh`) with a documented model-name mapping, so a single provider outage doesn't take down the whole pipeline. This fallback path was validated live during development when the OpenRouter account temporarily ran out of credits — calls transparently continued via Runtime's `deepseek-v4-flash`.
- **Per-attempt timeouts within the fallback chain** — if the first model in a call's chain hangs (observed live with `qwen/qwen-2.5-72b-instruct` on OpenRouter, which intermittently hung with no response), a 25-second per-attempt cap forces the chain to move to the next model rather than blocking the whole request.

This is why the cost meter and per-agent cost breakdown in every PaperAgents report are real, measured numbers — not estimates.

---

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your keys, see below
npm run dev                  # http://localhost:3000
```

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes (or `RUNTIME_API_KEY`) | Primary LLM provider |
| `RUNTIME_API_KEY` | Yes (or `OPENROUTER_API_KEY`) | Fallback LLM provider (`api.rntm.sh`) |
| `SEMANTIC_SCHOLAR_API_KEY` | Recommended | Raises rate limits significantly; the app works without it but is more prone to throttling |
| `VERIFIER_MODEL_MODE` | No | `standard` (default, cheap) or `premium` (stronger verifier model) |
| `DB_PATH` | No | SQLite file location; defaults to `./data/paperagents.db`. Set this to a mounted volume path in production. |

At least one of `OPENROUTER_API_KEY` / `RUNTIME_API_KEY` must be set. Both is recommended, since that's what enables the fallback chain.

### Testing the pipeline directly

```bash
npm run test:pipeline                          # runs against a default test claim
npm run test:pipeline:pdf -- "<path-to-pdf>"    # runs against a real PDF
npm run test:pipeline:pdf -- "<path-to-pdf>" "<claim or topic>"
```

---

## Deployment

PaperAgents runs a **persistent server process**, not serverless functions — the pipeline can take 60–150+ seconds end to end across all six steps, and it writes to a local SQLite file for session restore and Historian comparisons. Both of these are a poor fit for ephemeral serverless platforms (Vercel's function timeout and read-only filesystem in particular).

**Recommended: [Railway](https://railway.app)**, or any platform that runs a persistent Node process with an attached persistent volume.

1. Connect the GitHub repo — Railway auto-detects the Next.js app via `railway.json`
2. Set environment variables in the service's Variables tab
3. Attach a persistent volume, mounted at the path `DB_PATH` points to (e.g. `/data`)
4. Deploy — the healthcheck hits `/`, which returns 200 once the app is up

If you deploy to Vercel anyway, note that `maxDuration` in `app/analyze/api/run/route.ts` needs to be raised well past its current setting to survive a full six-step run, and you'll need external persistent storage (not local SQLite) for session restore and Historian to work correctly.

---

## Known limitations

See `REPRODUCIBILITY.md` for the full list, including literature-source coverage gaps for very recently published papers, retrieval variance run-to-run, and the scope of the automated grounding check.

---

## License / Credits

Built for the Research Agents Hack (IIT Madras). Sources: arXiv, Semantic Scholar, OpenAlex. Inference: Runtime (OpenRouter primary, Runtime gateway fallback).

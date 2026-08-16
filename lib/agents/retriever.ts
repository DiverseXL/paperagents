import { callRuntime } from "../runtime-client";
import { searchArxiv, searchArxivByTitle } from "../sources/arxiv";
import type { ArxivResult } from "../sources/arxiv";
import { searchSemanticScholar } from "../sources/semantic-scholar";
import { searchOpenAlex } from "../sources/openalex";
import { withTimeout } from "../with-timeout";
import { FREE_MODELS } from "../models";
import { AgentEvent, RetrievedSource } from "./types";

const RETRIEVER_SYSTEM_PROMPT = `You are the Retriever agent in a research verification pipeline.

Given a research claim, paper title, or arXiv link, generate 2-3 focused search queries that will surface the most relevant primary sources and related work.

Rules:
- Output ONLY valid JSON, no preamble, no markdown fences.
- Queries should be short (3-8 words), specific, and non-redundant with each other.
- Prefer technical/academic phrasing over conversational phrasing.
- If the input is already an arXiv ID or URL, extract the core topic for supplementary queries rather than re-searching the exact paper.

Output schema:
{"queries": ["query 1", "query 2", "query 3"]}`;

const mapArxivToRetrieved = (items: ArxivResult[]): RetrievedSource[] =>
  items.map((item) => ({
    title: item.title,
    summary: item.summary,
    url: item.url,
    source: "arxiv" as const,
    confirmedByMultipleSources: false,
    sourceCount: 1,
  }));

/** Dedup/merge key: lowercase, whitespace-collapsed, trimmed title. */
export const normalizeTitle = (title: string): string =>
  title.toLowerCase().replace(/\s+/g, " ").trim();

// Safety cap on the query-generation LLM call — same 45s ceiling as the other
// agents. Only wraps the LLM call that produces search queries; the source
// fetches (arxiv / semantic-scholar / openalex / title search) keep their own
// error handling and are intentionally NOT wrapped. A timeout rejects and flows
// into the existing catch, falling back to a single query from the input —
// identical to a JSON parse failure on this call. No new fallback branches.
const RETRIEVER_CALL_TIMEOUT_MS = 45_000;

export async function runRetriever(
  input: string,
  onEvent: (e: AgentEvent) => void,
  documentTitle?: string
): Promise<RetrievedSource[]> {
  onEvent({
    agent: "retriever",
    status: "started",
    message: "Generating search queries for input...",
    timestamp: Date.now(),
  });

  let queries: string[] = [];

  try {
    const runtimeRes = await withTimeout(
      callRuntime({
        model: FREE_MODELS.default,
        messages: [
          { role: "system", content: RETRIEVER_SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
        maxTokens: 300,
        // promptCacheKey: "retriever-v1",
        responseFormat: "json_object",
      }),
      RETRIEVER_CALL_TIMEOUT_MS,
      "Retriever query generation call"
    );

    onEvent({
      agent: "retriever",
      status: "streaming",
      message: "Search queries generated via Runtime API.",
      cacheTier: runtimeRes.cacheTier,
      benchmarkCost: runtimeRes.benchmarkCost,
      customerCharge: runtimeRes.customerCharge,
      timestamp: Date.now(),
    });

    try {
      const parsed = JSON.parse(runtimeRes.content);
      if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
        queries = parsed.queries.map((q: any) => String(q)).filter(Boolean);
      }
    } catch {
      queries = [input.slice(0, 80)];
    }
  } catch (err: any) {
    console.warn(
      "[retriever] query generation failed, falling back to raw input as query:",
      err?.message ?? err
    );
    queries = [input.slice(0, 80)];
  }

  if (queries.length === 0) {
    queries = [input.slice(0, 80)];
  }

  const allSources: RetrievedSource[] = [];

  // Optional targeted arXiv title search for the document being analyzed. Runs
  // in parallel with the topic-query loop below, giving the retriever a second,
  // more direct route to the paper itself when the broad all: token search
  // misses it. Purely additive — must not throw; failures degrade to [].
  const titleSearchPromise: Promise<RetrievedSource[]> = documentTitle
    ? searchArxivByTitle(documentTitle, 3)
        .then((items) => mapArxivToRetrieved(items))
        .catch((err: any) => {
          const errMsg = err instanceof Error ? err.message : String(err ?? "unknown error");
          console.warn(`[retriever] title search failed for "${documentTitle}":`, errMsg);
          onEvent({
            agent: "retriever",
            status: "streaming",
            message: `Title search for "${documentTitle}" failed: ${errMsg}`,
            timestamp: Date.now(),
          });
          return [];
        })
    : Promise.resolve([]);

  // All queries' source fetches now run in parallel. The three sources within a
  // query were already concurrent via Promise.all, but the loop over queries was
  // sequential (for...of + await), so total fetch time was queries × slowest
  // source. Firing every query at once collapses that to a single slowest-source
  // latency across all queries. Per-query events still emit as each query's
  // fetches resolve, so the streaming log stays live.
  const queryTasks = queries.map(async (query) => {
    const [arxivResults, ssResults, openalexResults] = await Promise.all([
      searchArxiv(query, 3).catch((err: any) => {
        const errMsg = err instanceof Error ? err.message : String(err ?? "unknown error");
        console.warn(`[retriever] source fetch failed for query "${query}":`, errMsg);
        onEvent({
          agent: "retriever",
          status: "streaming",
          message: `arXiv unavailable for "${query}" — continuing with Semantic Scholar and OpenAlex results`,
          timestamp: Date.now(),
        });
        return [];
      }),
      searchSemanticScholar(query, 3).catch((err: any) => {
        const errMsg = err instanceof Error ? err.message : String(err ?? "unknown error");
        console.warn(`[retriever] source fetch failed for query "${query}":`, errMsg);
        const rateLimited = errMsg.includes("rate limited");
        onEvent({
          agent: "retriever",
          status: "streaming",
          message: `Semantic Scholar unavailable for "${query}" (${rateLimited ? "rate limited" : "error"}) — continuing with arXiv and OpenAlex results`,
          timestamp: Date.now(),
        });
        return [];
      }),
      searchOpenAlex(query, 3).catch((err: any) => {
        const errMsg = err instanceof Error ? err.message : String(err ?? "unknown error");
        console.warn(`[retriever] source fetch failed for query "${query}":`, errMsg);
        onEvent({
          agent: "retriever",
          status: "streaming",
          message: `OpenAlex unavailable for "${query}" — continuing with arXiv and Semantic Scholar results`,
          timestamp: Date.now(),
        });
        return [];
      }),
    ]);

    const mappedArxiv: RetrievedSource[] = arxivResults.map((item) => ({
      title: item.title,
      summary: item.summary,
      url: item.url,
      source: "arxiv",
      confirmedByMultipleSources: false,
      sourceCount: 1,
    }));

    const mappedSS: RetrievedSource[] = ssResults.map((item) => ({
      title: item.title,
      summary: item.abstract || "",
      url: item.url,
      source: "semantic_scholar",
      confirmedByMultipleSources: false,
      sourceCount: 1,
    }));

    const mappedOpenAlex: RetrievedSource[] = openalexResults.map((item) => ({
      title: item.title,
      summary: item.abstract,
      url: item.url,
      source: "openalex",
      confirmedByMultipleSources: false,
      sourceCount: 1,
    }));

    onEvent({
      agent: "retriever",
      status: "streaming",
      message: `Query "${query}" -> arxiv: ${mappedArxiv.length}, semanticScholar: ${mappedSS.length}, openalex: ${mappedOpenAlex.length}`,
      timestamp: Date.now(),
    });

    return [...mappedArxiv, ...mappedSS, ...mappedOpenAlex];
  });

  // Await all query fetches and the title search together, then collect results
  // in the original query order (Promise.all preserves order), so dedup behavior
  // is unchanged from the sequential version.
  const [querySourcesByQuery, titleSources] = await Promise.all([
    Promise.all(queryTasks),
    titleSearchPromise,
  ]);

  for (const querySources of querySourcesByQuery) {
    allSources.push(...querySources);
  }
  if (documentTitle) {
    onEvent({
      agent: "retriever",
      status: "streaming",
      message: `Title search for "${documentTitle}" found ${titleSources.length} sources`,
      timestamp: Date.now(),
    });
  }
  // Title-search results go to the FRONT: they are the most direct evidence for
  // the document being analyzed, and the falsifier caps sources at 15 — if they
  // were appended after the topic-query results, the paper could be sliced off.
  allSources.unshift(...titleSources);

  // Merge across sources instead of naive first-seen dedup: group every result
  // by normalized title (lowercased, trimmed, whitespace-collapsed) across all
  // three APIs, then emit one enriched record per unique paper. The merged
  // record keeps the longest non-empty summary (most complete evidence for the
  // Falsifier), prefers a real URL when sources disagree, and flags papers that
  // were independently found by more than one literature database.
  const groups = new Map<string, RetrievedSource[]>();
  for (const src of allSources) {
    const normalizedTitle = normalizeTitle(src.title);
    if (!normalizedTitle) continue;
    const group = groups.get(normalizedTitle);
    if (group) {
      group.push(src);
    } else {
      groups.set(normalizedTitle, [src]);
    }
  }

  const deduplicated: RetrievedSource[] = [];
  const emittedTitles = new Set<string>();
  for (const src of allSources) {
    const normalizedTitle = normalizeTitle(src.title);
    if (!normalizedTitle || emittedTitles.has(normalizedTitle)) continue;
    emittedTitles.add(normalizedTitle);

    const group = groups.get(normalizedTitle)!;
    const distinctSources = new Set(group.map((s) => s.source));

    // Keep the record with the longest non-empty summary; ties keep first-seen.
    let best = group[0];
    for (const candidate of group) {
      if (
        candidate.summary.trim().length > 0 &&
        candidate.summary.length > best.summary.length
      ) {
        best = candidate;
      }
    }

    // Prefer a real URL over a missing one if sources disagree.
    const url =
      best.url.trim().length > 0
        ? best.url
        : group.find((s) => s.url.trim().length > 0)?.url ?? "";

    deduplicated.push({
      ...best,
      url,
      confirmedByMultipleSources: distinctSources.size > 1,
      sourceCount: distinctSources.size,
    });
  }

  const multiConfirmedCount = deduplicated.filter((s) => s.confirmedByMultipleSources).length;
  onEvent({
    agent: "retriever",
    status: "done",
    message: `Retriever completed: ${deduplicated.length} unique sources collected (${multiConfirmedCount} confirmed by multiple databases).`,
    timestamp: Date.now(),
  });

  return deduplicated;
}

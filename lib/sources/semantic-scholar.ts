export interface SemanticScholarResult {
  paperId: string;
  title: string;
  abstract: string | null;
  year: number | null;
  authors: string[];
  url: string;
  citationCount: number;
}

/*
 * ── Process-wide request throttle ──────────────────────────────────────────
 * Semantic Scholar's API terms cap this key at 1 request per second, and the
 * limit is CUMULATIVE across all endpoints — not per query. The retriever
 * fires several queries in parallel (Promise.all), so every call must funnel
 * through a single shared gate; arXiv/OpenAlex have no such constraint and
 * are intentionally NOT throttled.
 *
 * A plain timestamp check would not be enough: N parallel callers all read
 * the same "last request" time, all sleep the same amount, then all fire at
 * once. Instead the gate is a promise-chain mutex — each caller awaits the
 * previous one's slot, then spaces itself >= 1000ms after the previous
 * request. This serializes Semantic Scholar specifically, no matter how many
 * queries arrive concurrently.
 */
const MIN_REQUEST_INTERVAL_MS = 1000;

/** Resolves once the previous caller has taken its slot. */
let gate: Promise<void> = Promise.resolve();
let lastRequestTime = 0;

/** Waits for a free slot, then reserves it. Never rejects. */
async function throttleRequest(): Promise<void> {
  const previous = gate;
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const waitMs = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestTime);
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastRequestTime = Date.now();
  } finally {
    release();
  }
}

export async function searchSemanticScholar(query: string, limit: number = 5): Promise<SemanticScholarResult[]> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,abstract,year,authors,url,citationCount`;

  const MAX_ATTEMPTS = 3;
  const BACKOFF_MS = [500, 1500];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Every request (including 429 retries) passes through the 1/sec gate.
      await throttleRequest();

      const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY ?? "";
      const res = await fetch(url, {
        headers: apiKey ? { "x-api-key": apiKey } : {},
      });

      if (res.status === 429) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
          continue;
        }
        // All retries exhausted
        console.warn(`[semantic-scholar] rate limited after ${MAX_ATTEMPTS} attempts for query: ${query}`);
        throw new Error("Semantic Scholar search rate limited");
      }

      if (!res.ok) {
        throw new Error(`Semantic Scholar API responded with status ${res.status}`);
      }

      const data = await res.json();
      const papers = data.data || [];

      return papers.map((paper: any) => ({
        paperId: paper.paperId || "",
        title: paper.title || "",
        abstract: paper.abstract || null,
        year: paper.year ?? null,
        authors: Array.isArray(paper.authors) ? paper.authors.map((a: any) => a.name).filter(Boolean) : [],
        url: paper.url || (paper.paperId ? `https://www.semanticscholar.org/paper/${paper.paperId}` : ""),
        citationCount: paper.citationCount ?? 0,
      }));
    } catch (error: any) {
      if (error?.message?.includes("rate limited")) {
        throw error;
      }
      throw new Error(`Failed to fetch from Semantic Scholar: ${error?.message || error}`);
    }
  }

  // Should be unreachable, but TypeScript needs a return
  throw new Error("Semantic Scholar search rate limited");
}

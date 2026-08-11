export interface ArxivResult {
  id: string;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  url: string;
}

/** Extracts the raw inner text of the first occurrence of <tag> in an XML feed entry. */
function extractTag(xml: string, tag: string): string {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "";
}

/** Parses an arXiv Atom feed response into structured results. */
export function parseArxivFeed(xml: string): ArxivResult[] {
  const entries = xml.split(/<entry[\s>]/i).slice(1);

  return entries.map((entry) => {
    const entryXml = "<entry>" + entry;

    const rawId = extractTag(entryXml, "id").trim();
    const arxivId = rawId.includes("/abs/") ? rawId.split("/abs/")[1] : rawId;

    const title = extractTag(entryXml, "title").replace(/\s+/g, " ").trim();
    const summary = extractTag(entryXml, "summary").replace(/\s+/g, " ").trim();
    const published = extractTag(entryXml, "published").trim();

    const authorMatches = Array.from(
      entryXml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)
    );
    const authors = authorMatches.map((m) => m[1].replace(/\s+/g, " ").trim());

    const paperUrl = rawId.startsWith("http") ? rawId : `https://arxiv.org/abs/${arxivId}`;

    return {
      id: arxivId,
      title,
      summary,
      authors,
      published,
      url: paperUrl,
    };
  });
}

export async function searchArxiv(query: string, maxResults: number = 5): Promise<ArxivResult[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${maxResults}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ArXiv API responded with status ${res.status}`);
    }

    return parseArxivFeed(await res.text());
  } catch (error: any) {
    throw new Error(`Failed to fetch from arXiv: ${error?.message || error}`);
  }
}

// 750ms backoff before the single title-search retry (same pacing idea as
// semantic-scholar's rate-limit backoff).
const TITLE_SEARCH_RETRY_DELAY_MS = 750;

// Filler words that hurt exact title search — removed (case-insensitively) from
// the title before building the ti: query.
const TITLE_SEARCH_FILLER_WORDS = [
  "a",
  "an",
  "the",
  "paper",
  "study",
  "approach",
  "method",
  "using",
  "deep learning",
  "neural network",
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips common filler words from a title and collapses whitespace for arXiv ti: search. */
export function cleanTitleForSearch(title: string): string {
  let cleaned = title;
  for (const filler of TITLE_SEARCH_FILLER_WORDS) {
    cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(filler)}\\b`, "gi"), " ");
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Searches arXiv by exact title (ti: field) instead of the broad all: token
 * search used by searchArxiv. Same parsing as searchArxiv — this is purely a
 * different query prefix so the paper being analyzed can be found directly.
 */
export async function searchArxivByTitle(title: string, maxResults: number = 3): Promise<ArxivResult[]> {
  const cleaned = cleanTitleForSearch(title) || title;
  if (!cleaned) return [];
  // Wrap in a quoted phrase: arXiv's ti: field search treats bare space-separated
  // terms as implicit AND across all fields (only the first token is ti:-scoped),
  // which misses exact-title matches (e.g. "Attention Is All You Need" returned
  // unrelated papers). A quoted phrase forces an exact title match.
  const url = `https://export.arxiv.org/api/query?search_query=ti:%22${encodeURIComponent(cleaned)}%22&start=0&max_results=${maxResults}`;

  // One retry total (max 2 attempts), covering both observed failure modes:
  // a thrown request (network failure / non-2xx) and a 200-with-zero-results
  // ti: match (arXiv can return an empty set on the first pass). A single
  // loop keeps the two modes mutually exclusive — a retry after a throw never
  // falls through into a second retry for emptiness.
  const MAX_ATTEMPTS = 2;

  async function attempt(): Promise<ArxivResult[]> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`ArXiv API responded with status ${res.status}`);
    }
    return parseArxivFeed(await res.text());
  }

  for (let attemptNum = 1; attemptNum <= MAX_ATTEMPTS; attemptNum++) {
    let results: ArxivResult[];
    try {
      results = await attempt();
    } catch (error) {
      if (attemptNum === MAX_ATTEMPTS) return []; // retry also threw
      console.warn(
        `[arxiv] title search failed, retrying once: ${title} (${error instanceof Error ? error.message : String(error)})`
      );
      await new Promise((r) => setTimeout(r, TITLE_SEARCH_RETRY_DELAY_MS));
      continue;
    }

    if (results.length > 0) return results;
    if (attemptNum === MAX_ATTEMPTS) return []; // retry also matched nothing
    console.warn(`[arxiv] title search returned 0 results, retrying once: ${title}`);
    await new Promise((r) => setTimeout(r, TITLE_SEARCH_RETRY_DELAY_MS));
  }

  // Unreachable — the last iteration always returns — kept for TypeScript.
  return [];
}

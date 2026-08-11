export interface OpenAlexPaper {
  id: string;
  title: string;
  abstract: string;
  authors: string[];
  year: number | null;
  url: string;
  citationCount: number;
}

/**
 * Reconstructs a plain-text abstract from OpenAlex's `abstract_inverted_index`.
 *
 * OpenAlex does not return abstracts as plain strings. Instead, `abstract_inverted_index`
 * maps each word to the array of integer positions at which it appears, e.g.:
 *
 *   { "Attention": [0], "is": [1], "all": [2], "you": [3], "need": [4] }
 *     -> "Attention is all you need"
 *
 * Returns "" for null/undefined input. Gaps (positions with no assigned word) are
 * simply skipped — no placeholder text is inserted.
 */
export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null | undefined
): string {
  if (!invertedIndex) return "";

  let maxPos = -1;
  for (const positions of Object.values(invertedIndex)) {
    for (const pos of positions) {
      if (pos > maxPos) maxPos = pos;
    }
  }
  if (maxPos < 0) return "";

  const words: (string | undefined)[] = new Array(maxPos + 1);
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words[pos] = word;
    }
  }

  return words.filter((w) => w != null).join(" ");
}

/**
 * Searches OpenAlex works by relevance query.
 *
 * The `mailto` param puts requests in OpenAlex's "polite pool", which receives
 * much higher rate limits than the anonymous pool.
 *
 * NOTE: This should be replaced with a real contact email before demo day.
 *
 * No retry/backoff is implemented yet — the polite pool limits are high enough
 * that this likely isn't needed. If it ever becomes necessary, add a retry loop
 * here following the same pattern as semantic-scholar.ts (MAX_ATTEMPTS + backoff
 * on 429, structured error messages).
 */
export async function searchOpenAlex(
  query: string,
  maxResults: number = 5
): Promise<OpenAlexPaper[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per_page=${maxResults}&mailto=your-email@example.com`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OpenAlex API responded with status ${res.status}`);
    }

    const data = await res.json();
    const results = data.results || [];

    return results.map((paper: any): OpenAlexPaper => {
      const oaUrl = paper.open_access?.oa_url;
      // `doi` is usually a full https://doi.org/... URL already; only prefix the
      // bare-DOI form so we never end up with a doubled "https://doi.org/https://...".
      const doiUrl =
        paper.doi && typeof paper.doi === "string" && !paper.doi.startsWith("http")
          ? `https://doi.org/${paper.doi}`
          : paper.doi || "";

      const abstract = reconstructAbstract(paper.abstract_inverted_index).slice(0, 2000);

      return {
        id: paper.id || "",
        title: paper.title || "",
        abstract,
        authors: Array.isArray(paper.authorships)
          ? paper.authorships
              .map((a: any) => a?.author?.display_name)
              .filter((n: any): n is string => typeof n === "string" && n.length > 0)
          : [],
        year: paper.publication_year ?? null,
        url: oaUrl || doiUrl || paper.id || "",
        citationCount: paper.cited_by_count ?? 0,
      };
    });
  } catch (error: any) {
    throw new Error(`Failed to fetch from OpenAlex: ${error?.message || error}`);
  }
}

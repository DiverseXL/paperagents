// pdf-parse v2 exports a PDFParse class (not a default function like v1).
import { PDFParse } from "pdf-parse";

export async function extractPdfText(buffer: Buffer): Promise<{ text: string; numPages: number; guessedTitle: string }> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy();

    let text = result.text || "";
    const numPages = result.total || 0;

    if (text.length > 15000) {
      text = text.slice(0, 15000) + "\n\n[TRUNCATED — document exceeds processing limit]";
    }

    // Best-effort title guess: papers usually render their title as one of the
    // first few non-empty lines of extracted text. This is a heuristic, not a
    // real title parser — PDFs with headers, logos, or copyright notices
    // extracted first (common in arXiv/scholar PDFs) can yield a wrong guess,
    // so treat it as best-effort only. Candidate lines are filtered against
    // common boilerplate patterns (copyright/permission notices, arXiv/preprint
    // stamps, page numbers, running headers, short fragments, and wrapped
    // paragraph continuations).
    const nonEmptyLines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 10);

    const isBoilerplate = (line: string, index: number): boolean => {
      const lower = line.toLowerCase();

      if (
        lower.includes("copyright") ||
        lower.includes("©") ||
        lower.includes("all rights reserved") ||
        lower.includes("arxiv") ||
        lower.includes("preprint") ||
        lower.includes("doi:") ||
        lower.includes("isbn")
      ) {
        return true;
      }

      if (/^\d+$/.test(line) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) return true;

      if (line.length < 8 || line.length > 200) return true;

      if (/^page \d+/i.test(line) || /^\[.*\]$/.test(line)) return true;

      // Wrapped-paragraph fragment heuristics (beyond the boilerplate list):
      // continuation lines typically start lowercase, and a fragment line that
      // ends mid-sentence is followed by a lowercase-starting continuation.
      if (/^[a-z]/.test(line)) return true;

      const nextLine = nonEmptyLines[index + 1];
      if (nextLine && !/[.?!:;]$/.test(line) && /^[a-z]/.test(nextLine)) return true;

      return false;
    };

    const plausibleTitle = nonEmptyLines.find((line, index) => !isBoilerplate(line, index));

    // Fall back to the first non-empty line if everything was filtered out — a
    // wrong guess that at least attempts a title search is better than skipping
    // the search entirely, since the retriever treats title-search failures
    // gracefully.
    const guessedTitle = (plausibleTitle ?? nonEmptyLines[0] ?? "").slice(0, 200);

    return {
      text,
      numPages,
      guessedTitle,
    };
  } catch (error: any) {
    throw new Error(`Failed to parse PDF document: ${error?.message || error}`);
  }
}

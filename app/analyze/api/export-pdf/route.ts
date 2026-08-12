import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import type { NextRequest } from "next/server";
import { FULL_DOCUMENT_SOURCE_LABEL, type AnalysisReport, type VerifiedClaim } from "@/lib/agents/types";

export const runtime = "nodejs";

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.34, 0.33, 0.3);
const GREEN = rgb(0.24, 0.36, 0.24);
const RED = rgb(0.7, 0.15, 0.12);

/**
 * Standard fonts (WinAnsi) can't encode arbitrary Unicode. Map the common
 * typographic characters to ASCII and drop anything else rather than crash
 * the export on a stray glyph.
 */
function sanitize(text: string): string {
  return text
    .replace(/\u2018|\u2019|\u02BC/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2013|\u2014/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/\u00E9/g, "e")
    .replace(/\u00E8/g, "e")
    .replace(/\u00FC/g, "u")
    .replace(/\u00F6/g, "o")
    .replace(/\u00E4/g, "a")
    .replace(/[^\x20-\x7E\n]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of sanitize(text).split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = "";
      }
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
      } else {
        // Hard-break unbreakable tokens (long URLs) so they never run
        // past the right margin.
        let piece = "";
        for (const ch of word) {
          const test = piece + ch;
          if (font.widthOfTextAtSize(test, size) > maxWidth && piece) {
            lines.push(piece);
            piece = ch;
          } else {
            piece = test;
          }
        }
        current = piece;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * In-paper self-consistency verdicts and external corroboration are different
 * strengths of evidence — the export labels them differently, mirroring the
 * on-screen report. Uses the same stable label contract as the Verifier.
 */
function formatMatchedSource(matchedSource: string): string {
  return matchedSource === FULL_DOCUMENT_SOURCE_LABEL
    ? "[In paper] Source Document (full text, cross-referenced)"
    : `[External] ${matchedSource}`;
}

export async function POST(req: NextRequest): Promise<Response> {
  let report: AnalysisReport;
  try {
    const body = (await req.json()) as AnalysisReport;
    if (!body || typeof body !== "object" || !Array.isArray(body.claims)) {
      return Response.json({ error: "Expected an AnalysisReport payload" }, { status: 400 });
    }
    report = body;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  /** Wrapped draw that spills onto a new page when the cursor runs low. */
  function draw(
    text: string,
    size: number,
    opts: { font?: PDFFont; color?: typeof INK; gap?: number } = {}
  ) {
    const f = opts.font ?? font;
    const color = opts.color ?? INK;
    const lineHeight = size * 1.35;
    for (const line of wrap(text, f, size, CONTENT_WIDTH)) {
      if (y < MARGIN + lineHeight) {
        page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      if (line) page.drawText(line, { x: MARGIN, y, size, font: f, color });
      y -= lineHeight;
    }
    y -= opts.gap ?? 0;
  }

  function heading(text: string, gap = 6) {
    draw(text.toUpperCase(), 10, { font: bold, color: MUTED, gap });
  }

  function rule() {
    y -= 6;
    if (y < MARGIN + 8) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.75,
      color: MUTED,
    });
    y -= 14;
  }

  // ── Title block ───────────────────────────────────────────────────────
  draw("PaperAgents — Citation Verification Report", 17, { font: bold });
  draw(
    `Filed ${new Date(report.generatedAt).toLocaleString("en-US", { hour12: false })} · ${report.claims.length} claim${report.claims.length === 1 ? "" : "s"} · The Citation Verification Desk`,
    9,
    { color: MUTED, gap: 4 }
  );
  rule();

  // ── Input ─────────────────────────────────────────────────────────────
  heading("Input");
  draw(report.input, 10, { gap: 10 });

  // ── Data quality notes — the caveat travels with the document ─────────
  const qualityNotes = Array.isArray(report.dataQualityNotes)
    ? report.dataQualityNotes
    : [];
  if (qualityNotes.length > 0) {
    heading("A note on this run's data quality", 4);
    for (const note of qualityNotes) draw(`— ${note}`, 9, { color: MUTED });
    y -= 8;
  }

  // ── Consensus ─────────────────────────────────────────────────────────
  heading("Consensus");
  draw(report.consensus, 10, { gap: 10 });

  // ── Gaps ──────────────────────────────────────────────────────────────
  heading("Gaps in the evidence");
  if (report.gaps.length > 0) {
    for (const gap of report.gaps) draw(`— ${gap}`, 10);
  } else {
    draw("None identified.", 10, { color: GREEN });
  }
  y -= 10;
  rule();

  // ── Claim-by-claim ────────────────────────────────────────────────────
  heading("Claim-by-claim verification", 8);
  const STATUS_TONE: Record<VerifiedClaim["status"], typeof INK> = {
    supported: GREEN,
    unsupported: RED,
    fabricated: RED,
    unclear: MUTED,
  };

  report.claims.forEach((claim, i) => {
    if (y < MARGIN + 40) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    draw(`${i + 1}. ${claim.text}`, 10, { font: bold, gap: 4 });
    draw(`STATUS: ${claim.status.toUpperCase()}`, 9, {
      font: bold,
      color: STATUS_TONE[claim.status] ?? MUTED,
      gap: 3,
    });
    if (claim.evidenceQuote) {
      draw(`“${claim.evidenceQuote}”`, 9.5, { font: italic, color: MUTED, gap: 3 });
    }
    const meta: string[] = [];
    if (claim.matchedSource) meta.push(`Source: ${formatMatchedSource(claim.matchedSource)}`);
    if (claim.matchedSource === FULL_DOCUMENT_SOURCE_LABEL && claim.documentEvidenceDistance != null) {
      meta.push(`In-paper evidence: ${claim.documentEvidenceDistance} chars from claim's origin point`);
    }
    meta.push(`Confidence: ${Math.round(claim.confidence * 100)}%`);
    if (claim.citedAs) meta.push(`Cited as: ${claim.citedAs}`);
    if (meta.length > 0) draw(meta.join("   ·   "), 8, { color: MUTED, gap: 2 });
    if (claim.reasoning) draw(claim.reasoning, 8.5, { color: MUTED, gap: 6 });
    y -= 6;
  });

  rule();

  // ── Cost summary ──────────────────────────────────────────────────────
  heading("Cost summary", 6);
  const { costSummary } = report;
  for (const entry of costSummary.perAgent) {
    draw(
      `${entry.agent}   ${entry.cacheTier ?? "no cache"}   benchmark $${entry.benchmarkCost.toFixed(6)}   charge $${entry.customerCharge.toFixed(6)}`,
      9,
      { color: MUTED }
    );
  }
  draw("", 9);
  draw(`Total benchmark: $${costSummary.totalBenchmarkCost.toFixed(6)}`, 9, { font: bold });
  draw(`Total charge:    $${costSummary.totalCustomerCharge.toFixed(6)}`, 9, { font: bold });
  draw(`Saved:           $${costSummary.totalSaved.toFixed(6)}`, 9, {
    font: bold,
    color: GREEN,
    gap: 10,
  });

  draw("Generated by PaperAgents — every verdict stamped by evidence, not reputation.", 8, {
    color: MUTED,
  });

  const bytes = await pdf.save();
  // Copy the byte view into a standalone ArrayBuffer (BodyInit requires it).
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const date = new Date().toISOString().slice(0, 10);

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="paperagents-report-${date}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

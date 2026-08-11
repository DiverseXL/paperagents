import type { NextRequest } from "next/server";
import { runOrchestration } from "@/lib/orchestrator";
import { extractPdfText } from "@/lib/pdf-parse";
import { saveAnalysis } from "@/lib/db";

// Run on Node.js runtime — pdf-parse requires Node APIs (fs, Buffer)
export const runtime = "nodejs";

// 60 seconds — highest value permitted on Vercel Hobby/free tier
export const maxDuration = 60;

const encoder = new TextEncoder();

export async function POST(req: NextRequest): Promise<Response> {
  // ── 1. Parse multipart/form-data ────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return Response.json({ error: "Failed to parse form data" }, { status: 400 });
  }

  // ── 2. Read fields ───────────────────────────────────────────────────────
  const inputRaw = formData.get("input");
  const input = typeof inputRaw === "string" ? inputRaw.trim() : "";

  const fileField = formData.get("file");
  const file = fileField instanceof File ? fileField : null;

  // Either a claim/topic OR a document is enough to begin a run. A PDF-only
  // submission is valid: retrieval is driven by the document's title (see the
  // documentTitle path below) rather than by free text.
  if (!input && !file) {
    return Response.json(
      { error: "Input text or a PDF file is required" },
      { status: 400 }
    );
  }

  // ── 3. Determine inputText ───────────────────────────────────────────────
  let inputText = "";
  // Best-effort title of the uploaded document. Threaded through to the
  // orchestrator so the retriever can run its targeted arXiv title search —
  // the path built specifically to find a paper independent of any free text.
  let documentTitle: string | undefined;

  if (file) {
    if (file.type !== "application/pdf") {
      return Response.json({ error: "Only PDF files are supported" }, { status: 400 });
    }

    const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB
    if (file.size > MAX_PDF_BYTES) {
      return Response.json({ error: "PDF must be under 15MB" }, { status: 400 });
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const parsed = await extractPdfText(buffer);
      inputText = parsed.text;
      documentTitle =
        parsed.guessedTitle ||
        // Filenames commonly separate words with _ or - — normalize so the
        // title search (and query generation) sees "Attention Is All You Need",
        // not "Attention_Is_All_You_Need".
        file.name
          .replace(/\.pdf$/i, "")
          .replace(/[_-]+/g, " ")
          .trim() ||
        undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: "Could not parse PDF: " + message },
        { status: 400 }
      );
    }
  }
  // else: inputText stays "" — orchestrator will fall back to retrieved abstracts

  // ── 4. Build SSE stream ──────────────────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatId: ReturnType<typeof setInterval> | null = null;

      function enqueue(chunk: string) {
        controller.enqueue(encoder.encode(chunk));
      }

      function send(event: object) {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      }

      try {
        // Heartbeat every 15 seconds to keep connection alive
        heartbeatId = setInterval(() => {
          enqueue(": heartbeat\n\n");
        }, 15_000);

        // PDF-only runs: the extracted title doubles as the query input (a
        // meaningful placeholder — blank input would generate garbage retrieval
        // queries) and as documentTitle for the retriever's targeted title
        // search. When the user supplied free text, the title search is NOT
        // threaded — that keeps the already-tested text+PDF path unchanged
        // (a wrong title guess must not inject sources ahead of the good ones).
        const report = await runOrchestration(
          input || documentTitle || "",
          inputText,
          send,
          input ? undefined : documentTitle
        );

        // Persistence sits around the pipeline, not inside it: the verdict has
        // already been streamed (the orchestrator:done event), so a storage
        // failure must never fail the run — the report still reached the client.
        try {
          const analysisId = saveAnalysis(
            report,
            input || documentTitle || "",
            documentTitle
          );
          send({
            agent: "orchestrator",
            status: "saved",
            message: "Analysis saved",
            analysisId,
            timestamp: Date.now(),
          });
        } catch (saveErr) {
          console.error("[db] failed to save analysis:", saveErr);
        }
      } catch (err) {
        // runOrchestration already sends an orchestrator:error event before rethrowing.
        // Send a final safety event in case something slipped through.
        try {
          send({
            agent: "orchestrator",
            status: "error",
            message: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          });
        } catch {
          // stream may already be closing — ignore
        }
      } finally {
        if (heartbeatId !== null) {
          clearInterval(heartbeatId);
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  // ── 5. Return SSE response ───────────────────────────────────────────────
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

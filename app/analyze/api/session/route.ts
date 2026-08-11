import { getLatestAnalysis } from "@/lib/db";

// SQLite reads need the Node.js runtime, not Edge.
export const runtime = "nodejs";

// Never cache — the latest analysis changes with every completed run.
export const dynamic = "force-dynamic";

/**
 * Session restore endpoint. Returns the most recently saved analysis report
 * as JSON, or 404 when the desk has no saved record yet. The analyze page
 * calls this on mount so reopening the page brings back the last session.
 */
export async function GET(): Promise<Response> {
  const report = getLatestAnalysis();
  if (!report) {
    return Response.json({ error: "No saved analysis" }, { status: 404 });
  }
  return Response.json(report);
}

import { mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { normalizeTitle } from "./agents/retriever";
import type { AnalysisReport } from "./agents/types";

/**
 * Local SQLite persistence for completed analyses.
 *
 * Local dev: <project>/data/paperagents.db (gitignored — this is local dev
 * persistence, not something to commit). Production: set DB_PATH to an
 * absolute path inside the persistent volume mount (e.g. /data/paperagents.db
 * with the volume mounted at /data) so analysis history and Historian
 * briefings survive restarts and redeploys — the container filesystem is
 * ephemeral and is wiped on every redeploy.
 *
 * Next.js externalizes better-sqlite3 automatically (it's on the default
 * server-external list), so the native module is loaded via require() and
 * never bundled. A single module-level connection is reused across requests;
 * the schema is created idempotently so hot reloads and first runs are safe.
 */

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), "data", "paperagents.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    // Create the database's parent directory on demand. Works for both the
    // local default and an absolute volume-mount path (/data) — mkdirSync is
    // a no-op when the directory already exists (e.g. an already-mounted
    // volume).
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    // WAL keeps reads from blocking the write on the next run.
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id             TEXT PRIMARY KEY,
        input          TEXT NOT NULL,
        document_title TEXT,
        report_json    TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
    `);
  }
  return db;
}

/** Parse report_json defensively — a corrupted row must never crash the page. */
function parseReport(json: string): AnalysisReport | null {
  try {
    return JSON.parse(json) as AnalysisReport;
  } catch {
    return null;
  }
}

/**
 * Persist a completed analysis. Returns the new record's id (crypto.randomUUID).
 */
export function saveAnalysis(
  report: AnalysisReport,
  input: string,
  documentTitle?: string | null
): string {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO analyses (id, input, document_title, report_json, created_at, updated_at)
       VALUES (@id, @input, @documentTitle, @reportJson, @createdAt, @updatedAt)`
    )
    .run({
      id,
      input,
      documentTitle: documentTitle ?? null,
      reportJson: JSON.stringify(report),
      createdAt: now,
      updatedAt: now,
    });
  return id;
}

/** Fetch a single analysis by id; null when missing or unparseable. */
export function getAnalysis(id: string): AnalysisReport | null {
  const row = getDb()
    .prepare(`SELECT report_json FROM analyses WHERE id = ?`)
    .get(id) as { report_json: string } | undefined;
  return row ? parseReport(row.report_json) : null;
}

/** Most recently created analysis; null when the table is empty. */
export function getLatestAnalysis(): AnalysisReport | null {
  const row = getDb()
    .prepare(
      `SELECT report_json FROM analyses ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { report_json: string } | undefined;
  return row ? parseReport(row.report_json) : null;
}

/**
 * AnalysisReport has no id field, but the Historian briefing needs the prior
 * record's id. findPriorAnalysis returns the report (per its contract) and
 * records the row id here by object identity, so callers can look it up
 * without touching the report structure or its serialized payload.
 */
const analysisIdByReport = new WeakMap<AnalysisReport, string>();

/** Row id of a report returned by findPriorAnalysis; null for unknown reports. */
export function getAnalysisId(report: AnalysisReport): string | null {
  return analysisIdByReport.get(report) ?? null;
}

/**
 * Most recent PRIOR saved analysis of the same paper/claim.
 *
 * Match strategy: when documentTitle is present, match the most recent record
 * (created before this run started) whose stored document_title normalizes to
 * the same key; otherwise match on the stored input text the same way. Exact
 * match after normalization (lowercase, whitespace-collapsed, trimmed) — the
 * same mechanical approach the retriever uses to dedup source titles. Returns
 * null when no prior analysis exists (first-time analysis — no Historian
 * briefing needed).
 */
export function findPriorAnalysis(
  input: string,
  documentTitle: string | null
): AnalysisReport | null {
  const wantDocumentMatch = Boolean(documentTitle && documentTitle.trim().length > 0);
  const key = normalizeTitle(wantDocumentMatch ? documentTitle! : input);
  if (!key) return null;

  // Scan metadata only (never the report payloads), most recent first, until
  // the normalized key matches — then fetch that single row's report_json.
  const rows = getDb()
    .prepare(
      `SELECT id, document_title, input
       FROM analyses
       WHERE created_at < ?
       ORDER BY created_at DESC`
    )
    .all(Date.now()) as {
    id: string;
    document_title: string | null;
    input: string;
  }[];

  for (const row of rows) {
    const candidate = wantDocumentMatch ? row.document_title : row.input;
    if (!candidate || normalizeTitle(candidate) !== key) continue;

    const payload = getDb()
      .prepare(`SELECT report_json FROM analyses WHERE id = ?`)
      .get(row.id) as { report_json: string } | undefined;
    if (!payload) continue;

    const report = parseReport(payload.report_json);
    if (report) analysisIdByReport.set(report, row.id);
    return report;
  }
  return null;
}

/** Lightweight summaries for a future history list — no report payloads. */
export interface AnalysisSummary {
  id: string;
  input: string;
  created_at: number;
}

export function listAnalyses(limit = 20): AnalysisSummary[] {
  return getDb()
    .prepare(
      `SELECT id, input, created_at FROM analyses ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as AnalysisSummary[];
}

import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";

// Load .env.local explicitly and override any inherited shell env var that may
// shadow it (e.g. a stale RUNTIME_API_KEY in Windows env vars).
config({ path: ".env.local", override: true });

import { runOrchestration } from "../lib/orchestrator";
import { extractPdfText } from "../lib/pdf-parse";
import { AnalysisReport } from "../lib/agents/types";

const pdfPath: string | undefined = process.argv[2];
const inputArg: string | undefined = process.argv[3];

if (!pdfPath) {
  console.error("Usage: npm run test:pipeline:pdf -- <path-to-pdf>");
  process.exit(1);
}

function formatCostLine(event: any): string {
  const parts: string[] = [];
  if (event.cacheTier != null) parts.push(`cacheTier=${event.cacheTier}`);
  if (event.benchmarkCost != null) parts.push(`benchmarkCost=$${event.benchmarkCost.toFixed(6)}`);
  if (event.customerCharge != null) parts.push(`customerCharge=$${event.customerCharge.toFixed(6)}`);
  return parts.join("  ");
}

function send(event: any): void {
  const prefix = `[${event.agent}] ${event.status}: ${event.message}`;
  const costLine = formatCostLine(event);

  if (costLine) {
    console.log(`${prefix}`);
    console.log(`  ↳ ${costLine}`);
  } else {
    console.log(prefix);
  }

  // If this is the final orchestrator done event with a report, pretty-print it
  if (event.agent === "orchestrator" && event.status === "done" && event.report) {
    console.log("\n========== FULL ANALYSIS REPORT ==========");
    console.log(JSON.stringify(event.report, null, 2));
    console.log("==========================================\n");
  }
}

async function main(): Promise<void> {
  const resolvedPath = path.resolve(pdfPath!);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`\n❌ File not found: ${resolvedPath}`);
    process.exit(1);
  }

  console.log(`\n🔬 PaperAgents Pipeline PDF Test`);
  console.log(`   PDF: ${resolvedPath}`);

  const buffer = fs.readFileSync(resolvedPath);
  console.log(`   File size: ${(buffer.length / 1024).toFixed(1)} KB`);

  let extractedText: string;
  let numPages: number;
  let guessedTitle: string = "";
  try {
    const parsed = await extractPdfText(buffer);
    extractedText = parsed.text;
    numPages = parsed.numPages;
    guessedTitle = parsed.guessedTitle;
  } catch (err: any) {
    console.error(`\n❌ PDF parse error:`, err?.message || err);
    process.exit(1);
  }

  console.log(`   Pages: ${numPages}`);
  console.log(`   Extracted text: ${extractedText.length} chars`);
  if (guessedTitle) console.log(`   Guessed title: "${guessedTitle}"`);

  const input: string =
    inputArg?.trim() ||
    extractedText.slice(0, 200).replace(/\s+/g, " ").trim();

  console.log(`   Input: "${input}"`);
  console.log(`   inputText: PDF-extracted (${extractedText.length} chars)\n`);
  console.log("─".repeat(60));

  try {
    const report: AnalysisReport = await runOrchestration(input, extractedText, send, guessedTitle);

    console.log("─".repeat(60));
    console.log("\n--- ALL CLAIMS VERIFIER SPOT CHECK ---\n");

    for (const c of report.claims) {
      console.log(`Original Claim  : ${c.text}`);
      console.log(`Source Quote    : ${c.sourceQuote}`);
      console.log(`Cited As        : ${c.citedAs}`);
      console.log(`Evidence Quote  : ${c.evidenceQuote}`);
      console.log(`Matched Source  : ${c.matchedSource}`);
      if (c.documentEvidenceDistance != null) {
        console.log(`Doc Evidence Dist: ${c.documentEvidenceDistance} chars from origin`);
      }
      console.log(`Status          : ${c.status}`);
      console.log(`Reasoning       : ${c.reasoning}`);
      console.log(`Confidence Score: ${c.confidence}`);
      console.log("─".repeat(60));
    }

    const { totalBenchmarkCost, totalCustomerCharge, totalSaved } = report.costSummary;

    console.log("\n========== FINAL SUMMARY ==========");
    console.log(`Total claims    : ${report.claims.length}`);

    const statusCounts: Record<string, number> = {
      supported: 0,
      unsupported: 0,
      fabricated: 0,
      unclear: 0,
    };
    for (const c of report.claims) {
      statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
    }
    for (const [status, count] of Object.entries(statusCounts)) {
      console.log(`  ${status.padEnd(12)}: ${count}`);
    }

    console.log(`Benchmark cost  : $${totalBenchmarkCost.toFixed(6)}`);
    console.log(`Customer charge : $${totalCustomerCharge.toFixed(6)}`);
    console.log(`Saved           : $${totalSaved.toFixed(6)}`);

    if (report.costSummary.perAgent.length > 0) {
      console.log("\nPer-agent cost breakdown:");
      for (const entry of report.costSummary.perAgent) {
        console.log(
          `  [${entry.agent.padEnd(12)}] bench=$${entry.benchmarkCost.toFixed(6)}  charge=$${entry.customerCharge.toFixed(6)}  tier=${entry.cacheTier ?? "null"}`
        );
      }
    }

    console.log("===================================\n");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ Pipeline error:", err);
    process.exit(1);
  }
}

main();

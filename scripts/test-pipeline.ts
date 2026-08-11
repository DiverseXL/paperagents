import { config } from "dotenv";

// Load .env.local explicitly and override any inherited shell env var that may
// shadow it (e.g. a stale RUNTIME_API_KEY in Windows env vars), but preserve
// values passed explicitly via cross-env in npm scripts (e.g. VERIFIER_MODEL_MODE).
const crossEnvVerifierMode = process.env.VERIFIER_MODEL_MODE;
config({ path: ".env.local", override: true });
if (crossEnvVerifierMode) process.env.VERIFIER_MODEL_MODE = crossEnvVerifierMode;
import { runOrchestration } from "../lib/orchestrator";
import { AnalysisReport } from "../lib/agents/types";

const DEFAULT_CLAIM =
  "Attention is All You Need introduced the transformer architecture, which relies entirely on self-attention mechanisms without recurrence or convolution.";

const input: string = process.argv[2] || DEFAULT_CLAIM;

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
  console.log(`\n🔬 PaperAgents Pipeline Test`);
  console.log(`   Input: "${input}"`);
  console.log(`   inputText: "" (will fall back to retrieved abstracts)\n`);
  console.log("─".repeat(60));

  try {
    const report: AnalysisReport = await runOrchestration(input, "", send);

    const { totalBenchmarkCost, totalCustomerCharge, totalSaved } = report.costSummary;

    console.log("─".repeat(60));
    console.log("✅ Pipeline completed successfully");
    console.log(`   Claims verified : ${report.claims.length}`);

    const statusCounts: Record<string, number> = {};
    for (const c of report.claims) {
      statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
    }
    for (const [status, count] of Object.entries(statusCounts)) {
      console.log(`     ${status.padEnd(12)}: ${count}`);
    }

    console.log(`   Benchmark cost  : $${totalBenchmarkCost.toFixed(6)}`);
    console.log(`   Customer charge : $${totalCustomerCharge.toFixed(6)}`);
    console.log(`   Saved           : $${totalSaved.toFixed(6)}`);

    if (report.costSummary.perAgent.length > 0) {
      console.log("\n   Per-agent cost breakdown:");
      for (const entry of report.costSummary.perAgent) {
        console.log(
          `     [${entry.agent.padEnd(12)}] bench=$${entry.benchmarkCost.toFixed(6)}  charge=$${entry.customerCharge.toFixed(6)}  tier=${entry.cacheTier ?? "null"}`
        );
      }
    }

    console.log("");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ Pipeline error:", err);
    process.exit(1);
  }
}

main();

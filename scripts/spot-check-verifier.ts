import { config } from "dotenv";
const crossEnvVerifierMode = process.env.VERIFIER_MODEL_MODE;
config({ path: ".env.local", override: true });
if (crossEnvVerifierMode) process.env.VERIFIER_MODEL_MODE = crossEnvVerifierMode;

import { runOrchestration } from "../lib/orchestrator";
import { AnalysisReport } from "../lib/agents/types";

const DEFAULT_CLAIM =
  "Attention is All You Need introduced the transformer architecture, which relies entirely on self-attention mechanisms without recurrence or convolution.";

const input: string = process.argv[2] || DEFAULT_CLAIM;

// Dummy receiver for orchestrator events so we don't clutter the spot check console output
function send(event: any): void {
  const prefix = `[${event.agent}] ${event.status}: ${event.message}`;
  console.log(prefix);
}

async function main(): Promise<void> {
  console.log(`\n🔍 Spot-Checking Verifier Quality`);
  console.log(`   Model Mode: ${process.env.VERIFIER_MODEL_MODE || "not set"}`);
  console.log(`   Input: "${input}"\n`);
  console.log("─".repeat(60));

  try {
    const report: AnalysisReport = await runOrchestration(input, "", send);
    console.log("─".repeat(60));
    console.log("\n--- SUPPORTED CLAIMS SPOT CHECK ---\n");

    const supportedClaims = report.claims.filter((c) => c.status === "supported");

    for (const c of supportedClaims) {
      console.log(`Original Claim  : ${c.text}`);
      console.log(`Source Quote    : ${c.sourceQuote}`);
      console.log(`Matched Source  : ${c.matchedSource}`);
      console.log(`Reasoning       : ${c.reasoning}`);
      console.log(`Confidence Score: ${c.confidence}`);
      console.log("─".repeat(60));
    }

    console.log(`\n${supportedClaims.length} claims marked 'supported' — review each block above against the source abstract to confirm the match is genuine, not just topically adjacent.\n`);
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ Spot-check error:", err);
    process.exit(1);
  }
}

main();

import { config } from "dotenv";
const crossEnvVerifierMode = process.env.VERIFIER_MODEL_MODE;
config({ path: ".env.local", override: true });
if (crossEnvVerifierMode) process.env.VERIFIER_MODEL_MODE = crossEnvVerifierMode;

import { callRuntime } from "../lib/runtime-client";

async function main() {
  // Preferred model doesn't exist → chain should fall back to btl-2/deepseek-v4-flash
  const res = await callRuntime({
    model: "does-not-exist",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    maxTokens: 20,
  });
  console.log("FALLBACK_OK — served by:", res.model);
  console.log("content:", JSON.stringify(res.content));
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});

import { config } from "dotenv";
config({ path: ".env.local", override: true });

import { callRuntime } from "../lib/runtime-client";

async function main() {
  // Preferred model doesn't exist → the OpenRouter chain should fall back to
  // the free-tier models (openai/gpt-oss-20b:free, then
  // poolside/laguna-xs-2.1:free, then openrouter/free). If OpenRouter itself
  // is unavailable, callRuntime falls back to the BTL gateway (RUNTIME_API_KEY).
  const res = await callRuntime({
    model: "does-not-exist",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    maxTokens: 50,
  });
  console.log("FALLBACK_OK — served by:", res.model);
  console.log("content:", JSON.stringify(res.content));
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});

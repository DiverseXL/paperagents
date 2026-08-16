import { ClaimGraph } from "../lib/claim-graph";

/**
 * Deterministic verification of the Claim Graph's constraint rules — the parts
 * of the multi-agent system that are enforced in code, no LLM required:
 *
 * 1. The Extractor's only write is "pending".
 * 2. Only the Falsifier can move a claim to a terminal status, via
 *    resolveFalsifierVerdict (supported+grounded → survived, fabricated+grounded
 *    → falsified, everything else → unverifiable).
 * 3. A "supported" verdict whose quote failed the deterministic grounding check
 *    is downgraded to "unverifiable" before it ever reaches the gate.
 * 4. Terminal statuses are permanent — a falsified/unverifiable claim can never
 *    be reopened, not even by the Cross-Examiner.
 * 5. Only "survived" claims can be challenged back to "under_challenge" (the
 *    one re-challenge loop), after which the gate is re-applied.
 * 6. The Synthesizer hard gate: survived() returns exactly the claims with
 *    status === "survived" && groundingCheckPassed === true, and excluded()
 *    returns everything else — the only two read paths available to the
 *    Synthesizer (consensus input vs. Gaps input), and they are disjoint.
 *
 * Run: npx tsx scripts/verify-claim-graph.ts
 */
function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ FAILED: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

const extractorClaims = [
  { id: "claim-1", text: "The model achieves 28.4 BLEU.", sourceQuote: "Our model achieves 28.4 BLEU", citedAs: "Abstract" },
  { id: "claim-2", text: "Additive attention outperforms dot-product attention.", sourceQuote: "additive attention outperforms dot product attention", citedAs: "3.2.1" },
  { id: "claim-3", text: "The model uses 8 attention heads.", sourceQuote: "we employ h = 8 parallel attention layers", citedAs: "3.2.2" },
  { id: "claim-4", text: "Training takes 3.5 days.", sourceQuote: "after training for 3.5 days", citedAs: "Abstract" },
  { id: "claim-5", text: "The encoder has 6 layers.", sourceQuote: "The encoder is composed of a stack of N = 6 identical layers", citedAs: "3.1" },
];

// ── 1. Extractor creates claims as pending ──────────────────────────────
const graph = ClaimGraph.registerAll(extractorClaims);
assert(graph.all().length === 5, "all 5 extracted claims are registered");
assert(
  graph.all().every((n) => n.status === "pending"),
  "Extractor-created claims are all PENDING (no other status writable at creation)"
);

// ── 2. Only the Falsifier's resolve moves claims to terminal status ─────
assert(
  graph.resolveFalsifierVerdict({
    id: "claim-1",
    verdict: "supported",
    groundingCheckPassed: true, // quote mechanically verified verbatim
    originPointExcluded: false,
    evidenceQuote: "Our model achieves 28.4 BLEU",
    reason: "tried to falsify; failed — quote grounded",
  }).status === "survived",
  "supported + grounded → SURVIVED"
);

assert(
  graph.resolveFalsifierVerdict({
    id: "claim-2",
    verdict: "fabricated",
    groundingCheckPassed: true, // contradiction quote verified
    originPointExcluded: false,
    evidenceQuote: "the two mechanisms perform similarly",
    reason: "source clearly says the opposite",
  }).status === "falsified",
  "fabricated + grounded → FALSIFIED"
);

assert(
  graph.resolveFalsifierVerdict({
    id: "claim-3",
    verdict: "unverifiable",
    groundingCheckPassed: false,
    originPointExcluded: true,
    evidenceQuote: "",
    reason: "specific detail only at the excluded origin point",
  }).status === "unverifiable",
  "anything else → UNVERIFIABLE"
);

// ── 3. Ungrounded quotes are downgraded and can never survive ───────────
assert(
  graph.resolveFalsifierVerdict({
    id: "claim-4",
    verdict: "supported",
    groundingCheckPassed: false, // quote failed the verbatim grounding check
    originPointExcluded: false,
    evidenceQuote: "",
    reason: "quote not found verbatim in source text",
  }).status === "unverifiable",
  "a supported verdict whose quote is NOT grounded can never reach SURVIVED — it is downgraded to UNVERIFIABLE"
);

// ── 4. Terminal permanence ──────────────────────────────────────────────
const reopened = graph.challenge(
  ["claim-2", "claim-3", "claim-4"],
  "cross-examiner",
  "direct contradiction"
);
assert(
  reopened.length === 0,
  "FALSIFIED/UNVERIFIABLE claims are terminal — the Cross-Examiner cannot reopen them"
);
assert(
  graph.get("claim-2")!.status === "falsified" &&
    graph.get("claim-3")!.status === "unverifiable" &&
    graph.get("claim-4")!.status === "unverifiable",
  "terminal statuses are permanent for the run"
);

// ── 5. Re-challenge loop: only SURVIVED claims reopen, then the gate re-applies ──
assert(
  graph.resolveFalsifierVerdict({
    id: "claim-5",
    verdict: "supported",
    groundingCheckPassed: true,
    originPointExcluded: false,
    evidenceQuote: "The encoder is composed of a stack of N = 6 identical layers",
    reason: "tried to falsify; failed — quote grounded",
  }).status === "survived",
  "claim-5 SURVIVED after the falsification pass"
);

const reopenedSurvived = graph.challenge(["claim-5"], "cross-examiner", "direct contradiction between survived claims");
assert(
  reopenedSurvived.length === 1 && graph.get("claim-5")!.status === "under_challenge",
  "SURVIVED claim reopens → UNDER CHALLENGE"
);

graph.resolveFalsifierVerdict({
  id: "claim-5",
  verdict: "supported",
  groundingCheckPassed: true,
  originPointExcluded: false,
  evidenceQuote: "The encoder is composed of a stack of N = 6 identical layers",
  reason: "re-falsification pass: still not breakable",
});
assert(graph.get("claim-5")!.status === "survived", "re-falsification pass re-applies the gate → SURVIVED again");
assert(
  graph.get("claim-5")!.challenges.length >= 2 &&
    graph.get("claim-5")!.challenges.some((c) => c.agent === "cross-examiner"),
  "the claim's challenge log records the falsifier passes and the cross-examiner reopening"
);

// ── 6. The Synthesizer hard gate ────────────────────────────────────────
const survived = graph.survived();
const excluded = graph.excluded();
assert(
  survived.length === 2 &&
    survived.every((n) => n.id === "claim-1" || n.id === "claim-5"),
  "survived() returns ONLY claims with status=SURVIVED && groundingCheckPassed=true"
);
assert(
  excluded.length === 3 &&
    excluded.every((n) => n.id === "claim-2" || n.id === "claim-3" || n.id === "claim-4"),
  "excluded() returns every other claim (the only Gaps-section input)"
);
assert(
  excluded.every((n) => !survived.some((s) => s.id === n.id)),
  "consensus input and Gaps input are disjoint — no excluded claim can leak into the consensus"
);
assert(
  survived.every((n) => n.finalVerdict === "supported"),
  "every survived claim carries finalVerdict=supported"
);

if (process.exitCode) {
  console.error("\nClaim Graph verification FAILED.");
  process.exit(1);
}
console.log("\nClaim Graph verification passed — the constraints hold in code, not just in prompts.");

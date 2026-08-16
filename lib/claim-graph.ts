import type {
  ClaimGraphEntry,
  ClaimGraphNode,
  ClaimStatus,
  ExtractedClaim,
} from "./agents/types";

/**
 * ── The Claim Graph — shared state that constrains the agents ─────────────
 *
 * PaperAgents is a constrained multi-agent system, not a linear pipeline.
 * Agents communicate ONLY through this graph: there is no free-text handoff
 * between stages. Every rule below is enforced in code, not just in prompts:
 *
 * - The Extractor's only write is `register` — claims enter the graph as
 *   "pending". It can never set any other status.
 * - `resolveFalsifierVerdict` is the ONLY code path that moves a claim to a
 *   terminal status ("survived" | "falsified" | "unverifiable"), and it is
 *   only ever called by the Falsifier. No other agent can write a terminal
 *   status.
 * - `survived()` is the ONLY accessor that satisfies the Synthesizer's hard
 *   gate (status === "survived" && groundingCheckPassed === true). The
 *   Synthesizer never receives a node that did not pass the gate.
 * - Terminal statuses are permanent for the run: once a claim is "falsified"
 *   or "unverifiable", no later stage (including the Cross-Examiner's
 *   re-challenge loop) can reopen it. Only "survived" claims may be set back
 *   to "under_challenge".
 *
 * The graph is in-memory for the run; the per-claim state it produces is
 * persisted with the report (each VerifiedClaim carries its graphStatus,
 * groundingCheckPassed, originPointExcluded, challenges, and finalVerdict).
 */
export class ClaimGraph {
  private nodes: ClaimGraphNode[] = [];
  private byId = new Map<string, ClaimGraphNode>();

  /** Builds a graph from the Extractor's output — every claim enters "pending". */
  static registerAll(claims: ExtractedClaim[]): ClaimGraph {
    const graph = new ClaimGraph();
    for (const claim of claims) graph.register(claim);
    return graph;
  }

  /** The Extractor's only write: a claim enters the graph as "pending". */
  register(claim: ExtractedClaim): ClaimGraphNode {
    const node: ClaimGraphNode = {
      id: claim.id,
      text: claim.text,
      citationLabel: claim.citedAs,
      sourceQuote: claim.sourceQuote,
      status: "pending",
      challenges: [],
      evidenceQuotes: [],
      groundingCheckPassed: false,
      originPointExcluded: false,
    };
    this.byId.set(claim.id, node);
    this.nodes.push(node);
    return node;
  }

  get(id: string): ClaimGraphNode | undefined {
    return this.byId.get(id);
  }

  /** All nodes in insertion (extraction) order. */
  all(): ClaimGraphNode[] {
    return this.nodes;
  }

  /**
   * THE ONLY writer of terminal statuses. Called exclusively by the Falsifier
   * after it returns its verdict and the deterministic grounding check has
   * been applied. Applies the hard status update:
   *
   *   supported + grounded       → "survived"
   *   fabricated + grounded      → "falsified"
   *   anything else (ungrounded
   *   quote, missing evidence)   → "unverifiable"
   *
   * The grounding check runs BEFORE this call (in the Falsifier), so a
   * "supported"/"fabricated" verdict whose evidenceQuote is not found verbatim
   * arrives here already downgraded to "unverifiable". Once a claim reaches
   * "falsified" or "unverifiable" it is permanent for the run — a late
   * duplicate resolve is a no-op.
   */
  resolveFalsifierVerdict(input: {
    id: string;
    verdict: "supported" | "fabricated" | "unverifiable";
    groundingCheckPassed: boolean;
    originPointExcluded: boolean;
    evidenceQuote?: string;
    reason: string;
  }): ClaimGraphNode {
    let node = this.byId.get(input.id);
    if (!node) {
      // Defensive: an id the graph has never seen (should not happen — every
      // claim the Falsifier sees was registered by the Extractor) enters as
      // pending and is resolved in the same call.
      node = this.register({ id: input.id, text: "", sourceQuote: "", citedAs: "" });
    }

    // Terminal statuses are permanent for the run.
    if (node.status === "falsified" || node.status === "unverifiable") {
      return node;
    }

    let next: ClaimStatus;
    if (input.verdict === "supported" && input.groundingCheckPassed) {
      next = "survived";
    } else if (input.verdict === "fabricated" && input.groundingCheckPassed) {
      next = "falsified";
    } else {
      next = "unverifiable";
    }

    node.status = next;
    node.groundingCheckPassed = input.groundingCheckPassed;
    node.originPointExcluded = input.originPointExcluded;
    node.finalVerdict =
      next === "survived" ? "supported" : next === "falsified" ? "falsified" : "unverifiable";
    if (input.evidenceQuote && input.evidenceQuote.trim()) {
      if (!node.evidenceQuotes.includes(input.evidenceQuote)) {
        node.evidenceQuotes.push(input.evidenceQuote);
      }
    }
    node.challenges.push({
      agent: "falsifier",
      reason: input.reason,
      at: new Date().toISOString(),
    });
    return node;
  }

  /**
   * Cross-Examiner re-challenge: only "survived" claims may be reopened (set
   * back to "under_challenge") — terminal claims can never be challenged
   * again. Returns the nodes that were actually reopened.
   */
  challenge(ids: string[], agent: string, reason: string): ClaimGraphNode[] {
    const challenged: ClaimGraphNode[] = [];
    for (const id of ids) {
      const node = this.byId.get(id);
      if (!node || node.status !== "survived") continue;
      node.status = "under_challenge";
      node.challenges.push({ agent, reason, at: new Date().toISOString() });
      challenged.push(node);
    }
    return challenged;
  }

  /**
   * The Synthesizer's hard gate: the ONLY accessor that may feed the
   * consensus. Returns claims that survived adversarial falsification AND the
   * deterministic verbatim grounding check. Nothing else is readable here.
   */
  survived(): ClaimGraphNode[] {
    return this.nodes.filter(
      (n) => n.status === "survived" && n.groundingCheckPassed === true
    );
  }

  /** Everything that did NOT survive the gate — the Gaps-section input. */
  excluded(): ClaimGraphNode[] {
    return this.nodes.filter(
      (n) => !(n.status === "survived" && n.groundingCheckPassed === true)
    );
  }

  /** Lightweight snapshot for live SSE status badges in the UI. */
  snapshot(): ClaimGraphEntry[] {
    return this.nodes.map((n) => ({
      id: n.id,
      text: n.text,
      citationLabel: n.citationLabel,
      graphStatus: n.status,
      finalVerdict: n.finalVerdict,
    }));
  }
}

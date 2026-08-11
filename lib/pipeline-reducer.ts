import type { AgentRole, AnalysisReport } from "./agents/types";

/**
 * Client-side pipeline state — a pure reducer with no server imports.
 * One SSE event from /analyze/api/run maps to one action, so the live
 * UI (nodes, feed, cost meter, report) is always a pure function of the
 * event stream.
 */

export type Phase = "idle" | "running" | "done" | "error";
export type NodeState = "pending" | "active" | "done" | "error";

export const AGENTS: AgentRole[] = [
  "retriever",
  "extractor",
  "verifier",
  "synthesizer",
];

export const AGENT_LABELS: Record<AgentRole, string> = {
  retriever: "Retriever",
  extractor: "Extractor",
  verifier: "Verifier",
  synthesizer: "Synthesizer",
};

/** Raw SSE payload pushed by the /analyze/api/run stream. */
export interface StreamEvent {
  agent: string;
  status: string;
  message?: string;
  cacheTier?: string | null;
  benchmarkCost?: number | null;
  customerCharge?: number | null;
  timestamp?: number;
  report?: AnalysisReport;
}

export interface LogEntry {
  id: number;
  agent: string;
  status: string;
  message: string;
  cacheTier: string | null;
  benchmarkCost: number | null;
  customerCharge: number | null;
  timestamp: number;
}

export interface PipelineState {
  phase: Phase;
  nodes: Record<AgentRole, NodeState>;
  log: LogEntry[];
  benchmarkCost: number;
  customerCharge: number;
  report: AnalysisReport | null;
  error: string | null;
}

export type PipelineAction =
  | { type: "start" }
  | { type: "event"; event: StreamEvent }
  | { type: "fail"; message: string }
  | { type: "reset" };

const INITIAL_NODES: Record<AgentRole, NodeState> = {
  retriever: "pending",
  extractor: "pending",
  verifier: "pending",
  synthesizer: "pending",
};

export const INITIAL_STATE: PipelineState = {
  phase: "idle",
  nodes: { ...INITIAL_NODES },
  log: [],
  benchmarkCost: 0,
  customerCharge: 0,
  report: null,
  error: null,
};

const LOG_LIMIT = 150;

let logId = 0;

function nodeFromStatus(status: string): NodeState {
  if (status === "started" || status === "streaming") return "active";
  if (status === "done") return "done";
  if (status === "error") return "error";
  return "pending";
}

function toLogEntry(event: StreamEvent): LogEntry {
  return {
    id: ++logId,
    agent: event.agent,
    status: event.status,
    message: event.message ?? "",
    cacheTier: event.cacheTier ?? null,
    benchmarkCost: event.benchmarkCost ?? null,
    customerCharge: event.customerCharge ?? null,
    timestamp: event.timestamp ?? Date.now(),
  };
}

export function pipelineReducer(
  state: PipelineState,
  action: PipelineAction
): PipelineState {
  switch (action.type) {
    case "start":
      return {
        ...INITIAL_STATE,
        phase: "running",
        nodes: { ...INITIAL_NODES }, // fresh object, never shares module state
        log: [],
      };
    case "reset":
      return INITIAL_STATE;
    case "fail":
      return { ...state, phase: "error", error: action.message };

    case "event": {
      const event = action.event;
      const log = [...state.log, toLogEntry(event)].slice(-LOG_LIMIT);

      // ── Orchestrator events resolve the whole run ─────────────────────
      if (event.agent === "orchestrator") {
        if (event.status === "done" && event.report) {
          // A stage that errored earlier keeps its error state — do not
          // paper over it in the final view.
          const nodes = { ...state.nodes };
          for (const agent of AGENTS) {
            if (nodes[agent] === "pending" || nodes[agent] === "active") {
              nodes[agent] = "done";
            }
          }
          return {
            ...state,
            phase: "done",
            report: event.report,
            nodes,
            log,
          };
        }
        if (event.status === "error") {
          return {
            ...state,
            phase: "error",
            error: event.message ?? "The analysis failed.",
            log,
          };
        }
        return { ...state, log };
      }

      // ── Per-agent events drive a node and (if streaming) the meter ────
      const agent = event.agent as AgentRole;
      if (!(agent in INITIAL_NODES)) return { ...state, log };

      const isStreaming = event.status === "streaming";

      return {
        ...state,
        nodes: { ...state.nodes, [agent]: nodeFromStatus(event.status) },
        log,
        benchmarkCost:
          state.benchmarkCost + (isStreaming ? event.benchmarkCost ?? 0 : 0),
        customerCharge:
          state.customerCharge + (isStreaming ? event.customerCharge ?? 0 : 0),
      };
    }

    default:
      return state;
  }
}

/** Dollar rendering for the live meter and cost tables. */
export function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

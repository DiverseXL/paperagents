import { Fragment } from "react";
import type { AgentRole } from "@/lib/agents/types";
import {
  AGENTS,
  AGENT_LABELS,
  type NodeState,
} from "@/lib/pipeline-reducer";

interface AgentPaneProps {
  nodes: Record<AgentRole, NodeState>;
}

type ConnectorState = "idle" | "flowing" | "solid";

/**
 * A connector marches while its upstream agent is producing output and the
 * downstream agent has not started yet (data in transit). Once the next agent
 * has picked it up, the line goes solid.
 */
function connectorState(left: NodeState, right: NodeState): ConnectorState {
  if (left === "done") return right === "pending" ? "flowing" : "solid";
  if (left === "active" && right === "pending") return "flowing";
  return "idle";
}

const NODE_GLYPH: Record<AgentRole, string> = {
  retriever: "R",
  extractor: "E",
  verifier: "V",
  synthesizer: "S",
};

const NODE_STATUS: Record<NodeState, string> = {
  pending: "Standing by",
  active: "On the desk",
  done: "Complete",
  error: "Failed",
};

const CIRCLE_CLASS: Record<NodeState, string> = {
  pending: "border-hairline bg-paper text-muted-ink",
  active: "node--active border-ink bg-paper text-ink",
  done: "border-ink bg-ink text-paper",
  error: "border-accent-red bg-accent-red text-paper",
};

function CheckMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

function CrossMark() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function NodeCircle({ agent, state }: { agent: AgentRole; state: NodeState }) {
  return (
    <div
      role="img"
      aria-label={`${AGENT_LABELS[agent]}: ${NODE_STATUS[state]}`}
      className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 transition-colors duration-300 ${CIRCLE_CLASS[state]}`}
    >
      {state === "done" ? (
        <CheckMark />
      ) : state === "error" ? (
        <CrossMark />
      ) : (
        <span className="font-display text-xl font-black">{NODE_GLYPH[agent]}</span>
      )}
    </div>
  );
}

function Connector({ state }: { state: ConnectorState }) {
  const className =
    state === "solid"
      ? "connector-solid"
      : state === "flowing"
        ? "connector-flow connector-flow--moving"
        : "connector-idle";

  /*
   * Vertical on mobile (the stacked pipeline), horizontal from sm up.
   * The connector-v modifier flips the dash direction in globals.css.
   */
  return (
    <div
      aria-hidden="true"
      className={`connector-v mx-auto my-1 h-7 w-[2px] shrink-0 sm:mx-2 sm:my-0 sm:mt-[39px] sm:h-[2px] sm:w-auto sm:min-w-6 sm:flex-1 ${className}`}
    />
  );
}

export default function AgentPane({ nodes }: AgentPaneProps) {
  return (
    <div
      aria-label="Pipeline progress"
      className="flex w-full flex-col items-center overflow-x-auto pb-2 pt-1 sm:flex-row sm:items-start sm:overflow-x-auto sm:pb-2 sm:pt-3"
    >
      {AGENTS.map((agent, i) => (
        <Fragment key={agent}>
          <div className="flex shrink-0 flex-col items-center gap-2.5">
            <NodeCircle agent={agent} state={nodes[agent]} />
            <div className="text-center">
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.18em] text-ink">
                {AGENT_LABELS[agent]}
              </p>
              <p className="mt-1 font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-muted-ink">
                {NODE_STATUS[nodes[agent]]}
              </p>
            </div>
          </div>
          {i < AGENTS.length - 1 ? (
            <Connector state={connectorState(nodes[agent], nodes[AGENTS[i + 1]])} />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

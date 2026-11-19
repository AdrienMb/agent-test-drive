import type { AgentId, NormalizedEvent, RunEvent, RunStatus } from "@atd/shared";

export type ToolCallEvent = Extract<NormalizedEvent, { kind: "tool_call" }>;
type UsageEvent = Extract<NormalizedEvent, { kind: "usage" }>;

export type TimelineItem =
  | { type: "message"; key: string; text: string }
  | { type: "reasoning"; key: string; text: string }
  | { type: "tool_call"; key: string; call: ToolCallEvent }
  | { type: "error"; key: string; message: string };

export interface AgentState {
  status: RunStatus | "idle";
  startedAt?: number;
  endedAt?: number;
  items: TimelineItem[];
  usage?: UsageEvent;
}

export interface State {
  runId?: string;
  prompt?: string;
  /** Highest seq applied; guards against replays when EventSource reconnects. */
  lastSeq: number;
  agents: Record<AgentId, AgentState>;
}

export type Action =
  | { type: "start"; runId: string; prompt: string }
  | { type: "event"; event: RunEvent }
  /** The event stream died for good (e.g. the server restarted and forgot the run). */
  | { type: "disconnected"; message: string };

const emptyAgents = (): Record<AgentId, AgentState> => ({
  claude: { status: "idle", items: [] },
  codex: { status: "idle", items: [] },
});

export const initialState: State = { lastSeq: 0, agents: emptyAgents() };

export const isFinished = (s: AgentState["status"]) => s === "done" || s === "failed" || s === "cancelled";

/** Tool calls still running when the agent stops will never complete, so stop their spinners. */
function settle(agent: AgentState, status: RunStatus, ts: number): AgentState {
  const items = agent.items.map((i) =>
    i.type === "tool_call" && i.call.status === "started" ? { ...i, call: { ...i.call, status: "failed" as const } } : i,
  );
  return { ...agent, status, endedAt: ts, items };
}

function applyEvent(agent: AgentState, { event, seq, ts }: RunEvent): AgentState {
  const key = String(seq);
  switch (event.kind) {
    case "status":
      return event.status === "running"
        ? { ...agent, status: "running", startedAt: agent.startedAt ?? ts }
        : settle(agent, event.status, ts);
    case "message":
      return { ...agent, items: [...agent.items, { type: "message", key, text: event.text }] };
    case "reasoning":
      return { ...agent, items: [...agent.items, { type: "reasoning", key, text: event.text }] };
    case "error":
      return { ...agent, items: [...agent.items, { type: "error", key, message: event.message }] };
    case "usage":
      return { ...agent, usage: event };
    case "tool_call": {
      // One card per tool call id: later events update the existing card in place.
      const index = agent.items.findIndex((i) => i.type === "tool_call" && i.key === event.id);
      if (index === -1) {
        return { ...agent, items: [...agent.items, { type: "tool_call", key: event.id, call: event }] };
      }
      const items = agent.items.slice();
      const previous = items[index] as Extract<TimelineItem, { type: "tool_call" }>;
      items[index] = { ...previous, call: { ...previous.call, ...event } };
      return { ...agent, items };
    }
    default:
      return agent;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "start":
      return { runId: action.runId, prompt: action.prompt, lastSeq: 0, agents: emptyAgents() };
    case "event": {
      const { event } = action;
      if (event.runId !== state.runId || event.seq <= state.lastSeq) return state;
      return {
        ...state,
        lastSeq: event.seq,
        agents: { ...state.agents, [event.agent]: applyEvent(state.agents[event.agent], event) },
      };
    }
    case "disconnected": {
      const now = Date.now();
      const agents = { ...state.agents };
      for (const [id, agent] of Object.entries(agents) as [AgentId, AgentState][]) {
        if (isFinished(agent.status)) continue;
        const withError = { ...agent, items: [...agent.items, { type: "error" as const, key: "disconnected", message: action.message }] };
        agents[id] = settle(withError, "failed", now);
      }
      return { ...state, agents };
    }
  }
}

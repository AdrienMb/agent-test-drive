import { isSafeWorkspacePath, type AgentId, type NormalizedEvent, type RunEvent, type RunStatus, type WorkspaceFile } from "@atd/shared";

export type ToolCallEvent = Extract<NormalizedEvent, { kind: "tool_call" }>;
type UsageEvent = Extract<NormalizedEvent, { kind: "usage" }>;
export type FilesEvent = Extract<NormalizedEvent, { kind: "files" }>;

/** Skipped folders are listed but are not files the agent made. */
export const countWorkspaceFiles = (files: WorkspaceFile[]) => files.filter((f) => f.skipped !== "dir").length;

export type TimelineItem =
  | { type: "prompt"; key: string; text: string }
  | { type: "message"; key: string; text: string }
  | { type: "reasoning"; key: string; text: string }
  | { type: "tool_call"; key: string; call: ToolCallEvent }
  | { type: "error"; key: string; message: string };

export interface AgentState {
  /** Of the current (or last) turn. */
  status: RunStatus | "idle";
  startedAt?: number;
  endedAt?: number;
  /** Summed over finished turns. */
  wallMs: number;
  /** Counts turns started, to scope tool call ids: Codex restarts them at item_0 every turn. */
  turn: number;
  items: TimelineItem[];
  /** Summed over turns. */
  usage?: UsageEvent;
  /** The latest turn's snapshot. */
  files?: Pick<FilesEvent, "files" | "truncated">;
  /** Why the session ended; set once the agent takes no more prompts. */
  closed?: string;
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
  claude: { status: "idle", wallMs: 0, turn: 0, items: [] },
  codex: { status: "idle", wallMs: 0, turn: 0, items: [] },
});

export const initialState: State = { lastSeq: 0, agents: emptyAgents() };

export const isFinished = (s: AgentState["status"]) => s === "done" || s === "failed" || s === "cancelled";

/** Tool calls still running when the agent stops will never complete, so stop their spinners. */
function settle(agent: AgentState, status: RunStatus, ts: number): AgentState {
  const items = agent.items.map((i) =>
    i.type === "tool_call" && i.call.status === "started" ? { ...i, call: { ...i.call, status: "failed" as const } } : i,
  );
  return { ...agent, status, endedAt: ts, wallMs: agent.wallMs + ts - (agent.startedAt ?? ts), items };
}

const add = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));

function addUsage(total: UsageEvent | undefined, turn: UsageEvent): UsageEvent {
  if (!total) return turn;
  return {
    kind: "usage",
    inputTokens: add(total.inputTokens, turn.inputTokens),
    outputTokens: add(total.outputTokens, turn.outputTokens),
    costUsd: add(total.costUsd, turn.costUsd),
    durationMs: add(total.durationMs, turn.durationMs),
  };
}

function applyEvent(agent: AgentState, { event, seq, ts }: RunEvent): AgentState {
  const key = String(seq);
  switch (event.kind) {
    case "status":
      if (event.status !== "running") return settle(agent, event.status, ts);
      return agent.status === "running" ? agent : { ...agent, status: "running", turn: agent.turn + 1, startedAt: ts, endedAt: undefined };
    case "prompt":
      return { ...agent, items: [...agent.items, { type: "prompt", key, text: event.text }] };
    case "closed":
      return { ...agent, closed: event.reason };
    case "message":
      return { ...agent, items: [...agent.items, { type: "message", key, text: event.text }] };
    case "reasoning":
      return { ...agent, items: [...agent.items, { type: "reasoning", key, text: event.text }] };
    case "error":
      return { ...agent, items: [...agent.items, { type: "error", key, message: event.message }] };
    case "usage":
      return { ...agent, usage: addUsage(agent.usage, event) };
    case "files": {
      // The server already rejects unsafe paths; this keeps the UI safe if that check ever regresses.
      const files = event.files.filter((f) => isSafeWorkspacePath(f.path));
      return { ...agent, files: { files, truncated: event.truncated || files.length !== event.files.length } };
    }
    case "tool_call": {
      // One card per tool call id and turn: later events update the existing card in place.
      const callKey = `${agent.turn}:${event.id}`;
      const index = agent.items.findIndex((i) => i.type === "tool_call" && i.key === callKey);
      if (index === -1) {
        return { ...agent, items: [...agent.items, { type: "tool_call", key: callKey, call: event }] };
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
        if (agent.closed) continue;
        if (isFinished(agent.status)) {
          agents[id] = { ...agent, closed: action.message };
          continue;
        }
        const withError = { ...agent, items: [...agent.items, { type: "error" as const, key: "disconnected", message: action.message }] };
        agents[id] = { ...settle(withError, "failed", now), closed: action.message };
      }
      return { ...state, agents };
    }
  }
}

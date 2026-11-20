import { isSafeWorkspacePath, type AgentId, type NormalizedEvent, type RunEvent, type RunStatus, type WorkspaceFile } from "@atd/shared";

export type ToolCallEvent = Extract<NormalizedEvent, { kind: "tool_call" }>;
type UsageEvent = Extract<NormalizedEvent, { kind: "usage" }>;
export type FilesEvent = Extract<NormalizedEvent, { kind: "files" }>;

/** Skipped folders are listed but are not files the agent made. */
export const countWorkspaceFiles = (files: WorkspaceFile[]) => files.filter((f) => f.skipped !== "dir").length;

export type TimelineItem =
  | { type: "message"; key: string; text: string }
  | { type: "reasoning"; key: string; text: string }
  | { type: "tool_call"; key: string; call: ToolCallEvent }
  | { type: "error"; key: string; message: string };

/** One agent's answer to one prompt. */
export interface Turn {
  status: RunStatus | "idle";
  startedAt?: number;
  endedAt?: number;
  items: TimelineItem[];
  /** The workspace at the end of this turn. */
  files?: Pick<FilesEvent, "files" | "truncated">;
}

export interface AgentState {
  /** turns[i] answers State.prompts[i]. Never empty; the last one is the current turn. */
  turns: Turn[];
  /** Summed over finished turns. */
  wallMs: number;
  /** Summed over turns. */
  usage?: UsageEvent;
  /** Why the session ended; set once the agent takes no more prompts. */
  closed?: string;
}

export interface State {
  runId?: string;
  /** The first prompt, then each follow-up. An agent whose session ended early has fewer turns than this. */
  prompts: string[];
  /** Highest seq applied; guards against replays when EventSource reconnects. */
  lastSeq: number;
  agents: Record<AgentId, AgentState>;
}

export type Action =
  | { type: "start"; runId: string; prompt: string }
  | { type: "event"; event: RunEvent }
  /** The event stream died for good (e.g. the server restarted and forgot the run). */
  | { type: "disconnected"; message: string };

const emptyTurn = (): Turn => ({ status: "idle", items: [] });

const emptyAgents = (): Record<AgentId, AgentState> => ({
  claude: { turns: [emptyTurn()], wallMs: 0 },
  codex: { turns: [emptyTurn()], wallMs: 0 },
});

export const initialState: State = { prompts: [], lastSeq: 0, agents: emptyAgents() };

export const isFinished = (s: Turn["status"]) => s === "done" || s === "failed" || s === "cancelled";

export const currentTurn = (agent: AgentState): Turn => agent.turns[agent.turns.length - 1];

const withCurrentTurn = (agent: AgentState, update: (turn: Turn) => Turn): AgentState => ({
  ...agent,
  turns: [...agent.turns.slice(0, -1), update(currentTurn(agent))],
});

const addItem = (agent: AgentState, item: TimelineItem) => withCurrentTurn(agent, (t) => ({ ...t, items: [...t.items, item] }));

/** Tool calls still running when the agent stops will never complete, so stop their spinners. */
function settle(agent: AgentState, status: RunStatus, ts: number): AgentState {
  const turn = currentTurn(agent);
  return {
    ...withCurrentTurn(agent, (t) => ({
      ...t,
      status,
      endedAt: ts,
      items: t.items.map((i) =>
        i.type === "tool_call" && i.call.status === "started" ? { ...i, call: { ...i.call, status: "failed" as const } } : i,
      ),
    })),
    wallMs: agent.wallMs + ts - (turn.startedAt ?? ts),
  };
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
      return currentTurn(agent).status === "running" ? agent : withCurrentTurn(agent, (t) => ({ ...t, status: "running", startedAt: ts, endedAt: undefined }));
    case "prompt":
      return { ...agent, turns: [...agent.turns, emptyTurn()] };
    case "closed":
      return { ...agent, closed: event.reason };
    case "message":
      return addItem(agent, { type: "message", key, text: event.text });
    case "reasoning":
      return addItem(agent, { type: "reasoning", key, text: event.text });
    case "error":
      return addItem(agent, { type: "error", key, message: event.message });
    case "usage":
      return { ...agent, usage: addUsage(agent.usage, event) };
    case "files": {
      // The server already rejects unsafe paths; this keeps the UI safe if that check ever regresses.
      const files = event.files.filter((f) => isSafeWorkspacePath(f.path));
      return withCurrentTurn(agent, (t) => ({ ...t, files: { files, truncated: event.truncated || files.length !== event.files.length } }));
    }
    case "tool_call":
      // One card per tool call id within a turn: later events update the existing card in place.
      return withCurrentTurn(agent, (t) => {
        const index = t.items.findIndex((i) => i.type === "tool_call" && i.key === event.id);
        if (index === -1) return { ...t, items: [...t.items, { type: "tool_call", key: event.id, call: event }] };
        const items = t.items.slice();
        const previous = items[index] as Extract<TimelineItem, { type: "tool_call" }>;
        items[index] = { ...previous, call: { ...previous.call, ...event } };
        return { ...t, items };
      });
    default:
      return agent;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "start":
      return { runId: action.runId, prompts: [action.prompt], lastSeq: 0, agents: emptyAgents() };
    case "event": {
      const { event } = action;
      if (event.runId !== state.runId || event.seq <= state.lastSeq) return state;
      const agent = applyEvent(state.agents[event.agent], event);
      // Both agents get the same follow-up; whichever event arrives first records it.
      const prompts =
        event.event.kind === "prompt" && state.prompts.length < agent.turns.length ? [...state.prompts, event.event.text] : state.prompts;
      return { ...state, lastSeq: event.seq, prompts, agents: { ...state.agents, [event.agent]: agent } };
    }
    case "disconnected": {
      const now = Date.now();
      const agents = { ...state.agents };
      for (const [id, agent] of Object.entries(agents) as [AgentId, AgentState][]) {
        if (agent.closed) continue;
        if (isFinished(currentTurn(agent).status)) {
          agents[id] = { ...agent, closed: action.message };
          continue;
        }
        const withError = addItem(agent, { type: "error", key: "disconnected", message: action.message });
        agents[id] = { ...settle(withError, "failed", now), closed: action.message };
      }
      return { ...state, agents };
    }
  }
}

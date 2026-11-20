import type { WorkspaceFile } from "./files.js";

export * from "./files.js";

export const PASSPHRASE_COOKIE = "atd_passphrase";

export type AgentId = "claude" | "codex";

/** `model` and `effort` are display labels; the runner adapters hold the real settings. */
export const AGENTS: readonly { id: AgentId; label: string; model: string; effort: string }[] = [
  { id: "claude", label: "Claude Code", model: "Haiku 5.5", effort: "Low" },
  { id: "codex", label: "Codex", model: "GPT-6 Luna", effort: "Low" },
];

export type ToolKind =
  | "shell"
  | "file_edit"
  | "web_search"
  | "mcp"
  | "todo"
  | "read"
  | "other";

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export type NormalizedEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "message"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool_call";
      id: string;
      tool: ToolKind;
      /** Short human label, e.g. "npm test", "edit src/a.ts". */
      title: string;
      status: "started" | "completed" | "failed";
      input?: unknown;
      output?: string;
      files?: string[];
    }
  | {
      kind: "usage";
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      durationMs?: number;
    }
  /** Sent at the end of each turn. `truncated` means some files were left out of the list. */
  | { kind: "files"; files: WorkspaceFile[]; truncated: boolean }
  | { kind: "error"; message: string }
  /** Server only (the runner protocol rejects it): a follow-up prompt sent to the agent. */
  | { kind: "prompt"; text: string }
  /** Server only: the sandbox is gone, so the agent takes no more prompts. */
  | { kind: "closed"; reason: string };

/** The first line of JSON written to the runner's stdin. */
export interface RunnerJob {
  agent: AgentId;
  prompt: string;
  /** Random per turn. The runner tags each event line with it, so the server can drop lines that don't belong to the current turn. */
  turn: string;
}

/** Each later line: one follow-up prompt in the same agent session, sent once the previous turn has ended. */
export interface RunnerFollowUp {
  prompt: string;
  turn: string;
}

/** What the server streams to the browser over SSE. */
export interface RunEvent {
  runId: string;
  agent: AgentId;
  seq: number;
  ts: number;
  event: NormalizedEvent;
}

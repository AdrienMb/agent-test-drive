import type { NormalizedEvent } from "@atd/shared";

export type Emit = (event: NormalizedEvent) => void;

/** Runs one prompt to completion in the agent's session. Resolves to true on success, false on failure. */
export type Turn = (prompt: string) => Promise<boolean>;

/** Starts an agent session; every prompt given to the returned turn continues the same conversation. */
export type Adapter = (emit: Emit) => Turn;

export const WORKSPACE = "/workspace";

/** Shortens absolute paths inside the workspace for display. */
export function rel(path: string): string {
  return path.startsWith(`${WORKSPACE}/`) ? path.slice(WORKSPACE.length + 1) : path;
}

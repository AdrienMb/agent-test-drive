import type { NormalizedEvent } from "@atd/shared";

type Emit = (event: NormalizedEvent) => void;

/** Runs one prompt to completion. Resolves to true on success, false on failure. */
export type Adapter = (prompt: string, emit: Emit) => Promise<boolean>;

export const WORKSPACE = "/workspace";

/** Shortens absolute paths inside the workspace for display. */
export function rel(path: string): string {
  return path.startsWith(`${WORKSPACE}/`) ? path.slice(WORKSPACE.length + 1) : path;
}

import { redactEvent, type NormalizedEvent } from "@atd/shared";

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

export const MAX_TITLE = 200;
export const MAX_OUTPUT = 8_000;

export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) => (value && SECRET_ENV_NAME.test(name) ? [value] : []));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text;
}

/** Writes one JSON line per event, with secrets redacted and tagged with the current turn id. The server redacts again. */
export function createEmitter(
  secrets: readonly string[],
  write: (line: string) => void,
  currentTurn: () => string | undefined = () => undefined,
): (event: NormalizedEvent) => void {
  let lastError: string | undefined;
  return (event) => {
    // Redact before truncating: a key cut in half at the limit would no longer match.
    let safe = redactEvent(event, secrets);
    if (safe.kind === "tool_call") {
      safe = { ...safe, title: truncate(safe.title, MAX_TITLE), output: safe.output === undefined ? undefined : truncate(safe.output, MAX_OUTPUT) };
    }
    // SDKs often report one failure through several channels; show it once.
    if (safe.kind === "error") {
      if (safe.message === lastError) return;
      lastError = safe.message;
    }
    // Every turn ends with a final status, so the next turn's first error is always shown.
    if (safe.kind === "status" && safe.status !== "running") lastError = undefined;
    const turn = currentTurn();
    write(`${JSON.stringify(turn === undefined ? safe : { ...safe, turn })}\n`);
  };
}

import { createInterface } from "node:readline";
import { once } from "node:events";
import type { NormalizedEvent, RunnerJob } from "@atd/shared";
import type { Adapter } from "./types.js";

// Loaded lazily: each agent has its own image, which only ships that agent's SDK.
const adapters: Record<RunnerJob["agent"], () => Promise<Adapter>> = {
  claude: () => import("./adapters/claude.js").then((m) => m.runClaude),
  codex: () => import("./adapters/codex.js").then((m) => m.runCodex),
};

// stdout is reserved for the JSONL event stream; everything else goes to stderr.
let lastError: string | undefined;
function emit(event: NormalizedEvent): void {
  // SDKs often report one failure through several channels; show it once.
  if (event.kind === "error") {
    if (event.message === lastError) return;
    lastError = event.message;
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readJob(): Promise<RunnerJob> {
  const rl = createInterface({ input: process.stdin });
  const [line] = (await once(rl, "line")) as [string];
  rl.close();
  const job = JSON.parse(line) as RunnerJob;
  if (!(job.agent in adapters) || typeof job.prompt !== "string") {
    throw new Error(`Invalid job: ${line}`);
  }
  return job;
}

async function main(): Promise<void> {
  emit({ kind: "status", status: "running" });
  let ok = false;
  try {
    const job = await readJob();
    console.error(`[runner] starting ${job.agent}`);
    const adapter = await adapters[job.agent]();
    ok = await adapter(job.prompt, emit);
  } catch (err) {
    console.error("[runner] fatal:", err);
    emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }
  emit({ kind: "status", status: ok ? "done" : "failed" });
  // Exit explicitly in case an SDK left a handle open; pipe writes are synchronous on Linux, so no output is lost.
  process.exit(ok ? 0 : 1);
}

void main();

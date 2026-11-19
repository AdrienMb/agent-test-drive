import { createInterface } from "node:readline";
import { once } from "node:events";
import type { RunnerJob } from "@atd/shared";
import { WORKSPACE, type Adapter } from "./types.js";
import { createEmitter, secretsFromEnv } from "./emit.js";
import { scanWorkspace } from "./files.js";

// Loaded lazily: each agent has its own image, which only ships that agent's SDK.
const adapters: Record<RunnerJob["agent"], () => Promise<Adapter>> = {
  claude: () => import("./adapters/claude.js").then((m) => m.runClaude),
  codex: () => import("./adapters/codex.js").then((m) => m.runCodex),
};

const secrets = secretsFromEnv(process.env);
// stdout is reserved for the JSONL event stream; everything else goes to stderr.
const emit = createEmitter(secrets, (line) => process.stdout.write(line));

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
  try {
    emit(await scanWorkspace(WORKSPACE));
  } catch (err) {
    console.error("[runner] workspace scan failed:", err);
  }
  emit({ kind: "status", status: ok ? "done" : "failed" });
  // Exit explicitly in case an SDK left a handle open; pipe writes are synchronous on Linux, so no output is lost.
  process.exit(ok ? 0 : 1);
}

void main();

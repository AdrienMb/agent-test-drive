import { createInterface } from "node:readline";
import type { RunnerFollowUp, RunnerJob } from "@atd/shared";
import { WORKSPACE, type Adapter, type Turn } from "./types.js";
import { createEmitter, secretsFromEnv } from "./emit.js";
import { scanWorkspace } from "./files.js";

// Loaded lazily: each agent has its own image, which only ships that agent's SDK.
const adapters: Record<RunnerJob["agent"], () => Promise<Adapter>> = {
  claude: () => import("./adapters/claude.js").then((m) => m.runClaude),
  codex: () => import("./adapters/codex.js").then((m) => m.runCodex),
};

const secrets = secretsFromEnv(process.env);
let turnId: string | undefined;
// stdout is reserved for the JSONL event stream; everything else goes to stderr.
const emit = createEmitter(secrets, (line) => process.stdout.write(line), () => turnId);

function parseLine(line: string, first: boolean): RunnerJob | RunnerFollowUp {
  const msg = JSON.parse(line) as Partial<RunnerJob>;
  // Taken before validating, so the server can still match the failure to its turn.
  turnId = typeof msg.turn === "string" ? msg.turn : undefined;
  if (typeof msg.prompt !== "string" || !turnId || (first && !(typeof msg.agent === "string" && msg.agent in adapters))) {
    throw new Error(`Invalid job: ${line}`);
  }
  return msg as RunnerJob | RunnerFollowUp;
}

/** One prompt per stdin line, each ending with a files event and a final status. EOF ends the session. */
async function main(): Promise<void> {
  emit({ kind: "status", status: "running" });
  let turn: Turn | undefined;
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let ok = false;
    try {
      const msg = parseLine(line, !turn);
      if (!turn) {
        const { agent } = msg as RunnerJob;
        console.error(`[runner] starting ${agent}`);
        turn = (await adapters[agent]())(emit);
      }
      ok = await turn(msg.prompt);
    } catch (err) {
      console.error("[runner] turn failed:", err);
      emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
    try {
      emit(await scanWorkspace(WORKSPACE));
    } catch (err) {
      console.error("[runner] workspace scan failed:", err);
    }
    emit({ kind: "status", status: ok ? "done" : "failed" });
    // Without an agent session no follow-up can succeed, so end the sandbox instead of waiting for one.
    if (!turn) break;
  }
  // Exit explicitly in case an SDK left a handle open; pipe writes are synchronous on Linux, so no output is lost.
  process.exit(turn ? 0 : 1);
}

void main();

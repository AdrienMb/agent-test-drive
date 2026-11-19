import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import type { NormalizedEvent } from "@atd/shared";
import { MAX_OUTPUT, WORKSPACE, rel, truncate, type Adapter } from "../types.js";

type Phase = "started" | "updated" | "completed";

function mapItem(item: ThreadItem, phase: Phase): NormalizedEvent | null {
  const done = phase === "completed";
  switch (item.type) {
    case "agent_message":
      return done && item.text.trim() ? { kind: "message", text: item.text } : null;
    case "reasoning":
      return done && item.text.trim() ? { kind: "reasoning", text: item.text } : null;
    case "command_execution":
      return {
        kind: "tool_call",
        id: item.id,
        tool: "shell",
        title: truncate(item.command, 200),
        status: !done ? "started" : item.status === "failed" || (item.exit_code ?? 0) !== 0 ? "failed" : "completed",
        input: { command: item.command },
        output: item.aggregated_output ? truncate(item.aggregated_output, MAX_OUTPUT) : undefined,
      };
    case "file_change": {
      const files = item.changes.map((c) => rel(c.path));
      return {
        kind: "tool_call",
        id: item.id,
        tool: "file_edit",
        title: item.changes.map((c) => `${c.kind} ${rel(c.path)}`).join(", "),
        status: !done ? "started" : item.status === "failed" ? "failed" : "completed",
        files,
      };
    }
    case "web_search":
      return { kind: "tool_call", id: item.id, tool: "web_search", title: item.query, status: done ? "completed" : "started" };
    case "mcp_tool_call": {
      const text = item.result?.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      return {
        kind: "tool_call",
        id: item.id,
        tool: "mcp",
        title: `${item.server}.${item.tool}`,
        status: !done ? "started" : item.status === "failed" ? "failed" : "completed",
        input: item.arguments,
        output: item.error?.message ?? (text ? truncate(text, MAX_OUTPUT) : undefined),
      };
    }
    case "todo_list": {
      const finished = item.items.filter((t) => t.completed).length;
      return {
        kind: "tool_call",
        id: item.id,
        tool: "todo",
        title: `todo list (${finished}/${item.items.length} done)`,
        status: done ? "completed" : "started",
        output: item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n"),
      };
    }
    case "error":
      // Non-fatal: the turn keeps going. Show it but don't fail the run.
      return { kind: "reasoning", text: `Warning: ${item.message}` };
    default:
      return null;
  }
}

export const runCodex: Adapter = async (prompt, emit) => {
  const startedAt = Date.now();
  const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
  const thread = codex.startThread({
    // Efficient tier for the MVP; paired with claude-haiku-5-5 on the Claude side.
    model: "gpt-6-luna",
    modelReasoningEffort: "low",
    workingDirectory: WORKSPACE,
    skipGitRepoCheck: true,
    // The container is the sandbox, so Codex's own sandbox and approvals are off.
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    webSearchMode: "live",
  });

  let ok = false;
  // Set once the failure has been reported, so the SDK's follow-up exception isn't shown twice.
  let reported = false;

  function handle(event: ThreadEvent): void {
    switch (event.type) {
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const mapped = mapItem(event.item, event.type.slice("item.".length) as Phase);
        if (mapped) emit(mapped);
        break;
      }
      case "turn.completed":
        ok = true;
        emit({
          kind: "usage",
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          durationMs: Date.now() - startedAt,
        });
        break;
      case "turn.failed":
        reported = true;
        emit({ kind: "error", message: event.error.message });
        break;
      case "error":
        // Codex reports transient retries ("Reconnecting... 2/5") as error events.
        if (event.message.startsWith("Reconnecting")) console.error(`[codex] ${event.message}`);
        else emit({ kind: "error", message: event.message });
        break;
      default:
        break;
    }
  }

  try {
    const { events } = await thread.runStreamed(prompt);
    for await (const event of events) handle(event);
  } catch (err) {
    if (!reported) throw err;
    console.error("[codex] SDK error after failure:", err);
  }
  return ok;
};

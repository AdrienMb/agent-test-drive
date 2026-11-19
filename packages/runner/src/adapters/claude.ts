import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedEvent, ToolKind } from "@atd/shared";
import { MAX_OUTPUT, WORKSPACE, rel, truncate, type Adapter } from "../types.js";

type ToolCall = Extract<NormalizedEvent, { kind: "tool_call" }>;
type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function describeTool(name: string, input: Input): Pick<ToolCall, "tool" | "title" | "files"> {
  const filePath = str(input.file_path) || str(input.notebook_path);
  switch (name) {
    case "Bash":
      return { tool: "shell", title: truncate(str(input.command), 200) };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { tool: "file_edit", title: `${name.toLowerCase()} ${rel(filePath)}`, files: [rel(filePath)] };
    case "Read":
      return { tool: "read", title: `read ${rel(filePath)}` };
    case "Glob":
    case "Grep":
      return { tool: "read", title: `${name.toLowerCase()} ${str(input.pattern)}` };
    case "WebSearch":
      return { tool: "web_search", title: str(input.query) };
    case "WebFetch":
      return { tool: "web_search", title: `fetch ${str(input.url)}` };
    case "TodoWrite":
      return { tool: "todo", title: "update todo list" };
    default: {
      const kind: ToolKind = name.startsWith("mcp__") ? "mcp" : "other";
      return { tool: kind, title: name };
    }
  }
}

/** tool_result content is either a string or a list of content blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
}

export const runClaude: Adapter = async (prompt, emit) => {
  // Remember each tool_use so its tool_result can be emitted as the same card.
  const started = new Map<string, ToolCall>();
  let ok = false;
  // Set once a result has been reported, so the SDK's follow-up exception isn't shown twice.
  let reported = false;

  function handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "assistant": {
        // API errors come back as a synthetic assistant message, then again in the result.
        if (msg.error) break;
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            emit({ kind: "message", text: block.text });
          } else if (block.type === "thinking" && block.thinking.trim()) {
            emit({ kind: "reasoning", text: block.thinking });
          } else if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Input;
            const call: ToolCall = { kind: "tool_call", id: block.id, status: "started", input, ...describeTool(block.name, input) };
            started.set(block.id, call);
            emit(call);
          }
        }
        break;
      }
      case "user": {
        const content = msg.message.content;
        if (typeof content === "string") break;
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const call = started.get(block.tool_use_id);
          if (!call) continue;
          emit({
            ...call,
            status: block.is_error ? "failed" : "completed",
            output: truncate(resultText(block.content), MAX_OUTPUT),
          });
        }
        break;
      }
      case "result": {
        const u = msg.usage;
        emit({
          kind: "usage",
          // Claude reports cached input separately; sum it so totals compare with Codex.
          inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        });
        reported = true;
        if (msg.subtype === "success" && !msg.is_error) {
          ok = true;
        } else {
          const detail = msg.subtype === "success" ? msg.result : msg.errors.join("\n");
          emit({ kind: "error", message: detail || `Claude run ended with ${msg.subtype}` });
        }
        break;
      }
      default:
        break;
    }
  }

  const messages = query({
    prompt,
    options: {
      // Efficient tier for the MVP; paired with gpt-6-luna on the Codex side.
      model: "claude-haiku-5-5",
      effort: "low",
      cwd: WORKSPACE,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"],
      // Don't load settings from the image; the run should be reproducible.
      settingSources: [],
      stderr: (data) => process.stderr.write(data),
    },
  });

  try {
    for await (const msg of messages as AsyncIterable<SDKMessage>) handle(msg);
  } catch (err) {
    if (!reported) throw err;
    console.error("[claude] SDK error after result:", err);
  }
  return ok;
};

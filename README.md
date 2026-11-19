# Agent Test Drive

Send one prompt to **Claude Code** and **Codex** at the same time, each in its own
Docker container, and watch what they do side by side.

## Architecture

```
React (Vite, Mantine) --POST /api/runs--> NestJS (runs on the host)
        ^                                   | for each agent: start a sandbox via the SandboxProvider
        |                                   | (Docker locally: `docker run --rm -i agent-runner-<agent> ...`)
        |                                   | read stdout line by line (JSONL of NormalizedEvent)
        +------- SSE /api/runs/:id/events --+
```

| Workspace         | What it is                                                                      |
| ----------------- | ------------------------------------------------------------------------------- |
| `packages/shared` | The normalized event schema (`NormalizedEvent`, `RunEvent`) used everywhere     |
| `packages/runner` | Node script that runs **inside** the container and drives one agent via its SDK |
| `apps/server`     | NestJS API: starts sandboxes, buffers events, streams them over SSE             |
| `apps/web`        | React + Mantine chat UI with one column per agent                               |

How a run goes:

1. `POST /api/runs { prompt }` creates a run and, for each agent, starts a sandbox through
   the active `SandboxProvider` (see [Sandbox providers](#sandbox-providers)). With Docker
   that is `docker run --rm -i --init --name cmp-<runId>-<agent> --memory 2g --cpus 2 -e <ONE_API_KEY> agent-runner-<agent>:latest`.
   Each agent has its own image, and each container only gets the key its agent needs.
2. The server writes `{"agent":"claude"|"codex","prompt":"..."}` to the container's stdin.
3. The runner (`packages/runner/src/main.ts`) dispatches to an adapter
   (`adapters/claude.ts` or `adapters/codex.ts`), which maps SDK events to
   `NormalizedEvent` and prints one JSON object per line on stdout. Logs go to stderr,
   which the server only writes to its own log.
4. The server stamps each event with `runId`, `agent`, `seq` and `ts`, stores it in an
   in-memory replay buffer, and streams it over SSE. Late subscribers get the full
   history first.
5. The browser merges `tool_call` events by `id`, so a call shows as one card that goes
   from started to completed.

Each agent emits `status: running` first and exactly one final status (`done`, `failed`
or `cancelled`). If a container exits without one, the server emits `failed`. Each
container has a 10-minute timeout.

## Setup

Requirements: Node 22+ (with corepack), Docker running locally.

```sh
corepack enable
cp .env.example .env        # then fill in ANTHROPIC_API_KEY and OPENAI_API_KEY
yarn install
yarn docker:build           # builds agent-runner-claude:latest and agent-runner-codex:latest
yarn dev                    # API on :3000, web on http://localhost:5173
```

Other scripts:

- `yarn typecheck`: typechecks every workspace.
- `yarn build:shared`: builds `packages/shared` (`dev` and `typecheck` run it first).

After changing anything in `packages/runner` or `packages/shared`, run
`yarn docker:build` again (or `docker:build:claude` / `docker:build:codex` for one agent):
the runner only runs inside the images.

### Try it

Send _"Write a Python script that prints the first 20 Fibonacci numbers, then run it"_.
Both columns stream live; shell commands and file edits get highlighted cards, and a
comparison table (time, tool calls by kind, files edited, tokens, cost) appears once both
agents are finished. **Cancel** runs `docker kill` on both containers.
`docker ps` should show nothing left after a run.

## Configuration

| Variable              | Default                      | Used by                    |
| --------------------- | ---------------------------- | -------------------------- |
| `ANTHROPIC_API_KEY`   |                              | Claude container           |
| `OPENAI_API_KEY`      |                              | Codex container            |
| `PORT`                | `3000`                       | API server                 |
| `API_PORT`            | `3000`                       | Vite dev proxy target      |
| `RUNNER_IMAGE_CLAUDE` | `agent-runner-claude:latest` | Image for the Claude agent |
| `RUNNER_IMAGE_CODEX`  | `agent-runner-codex:latest`  | Image for the Codex agent  |
| `SANDBOX_PROVIDER`    | `docker`                     | Where runners execute      |

The server loads `.env` from the repo root with `node --env-file-if-exists`.

## Sandbox providers

`RunsService` never talks to Docker directly. It uses a `SandboxProvider`
(`apps/server/src/sandbox/sandbox.types.ts`): `start(spec, listener)` takes the job, the
one API key and the resource limits, and reports runner events, log lines and exactly
one exit through the listener. The returned handle can `kill()` the sandbox, and
`shutdown()` kills everything still running when the server stops. Timeouts, limits
and event bookkeeping stay in `RunsService`, so every provider behaves the same.

`SANDBOX_PROVIDER` picks the provider at boot; an unknown value stops the server:

- `docker` (default, local): `DockerSandboxProvider` in `sandbox/docker.provider.ts`.
- `railway` (production): not implemented yet.

To add a provider, implement `SandboxProvider` in `apps/server/src/sandbox/` (reuse
`parseRunnerLine` from `runner-protocol.ts` if the runner's stdout comes back as text
lines) and register it in `createSandboxProvider` in `sandbox.module.ts`.

## Agent settings

- **Claude**: `@anthropic-ai/claude-agent-sdk` `query()` with `cwd: /workspace`,
  `permissionMode: "bypassPermissions"` (plus the required
  `allowDangerouslySkipPermissions: true`), the tool allowlist from the brief, and
  `settingSources: []` so no settings are loaded from the image.
- **Codex**: `@openai/codex-sdk` `startThread()` with `sandboxMode: "danger-full-access"`,
  `approvalPolicy: "never"`, `skipGitRepoCheck`, and `webSearchMode: "live"`. The
  container is the sandbox, so Codex's own sandbox is off.

Tool mapping to `ToolKind`: Bash / command_execution → `shell`; Write, Edit /
file_change → `file_edit`; WebSearch, WebFetch / web_search → `web_search`;
Read, Glob, Grep → `read`; TodoWrite / todo_list → `todo`; MCP tools → `mcp`;
anything else → `other`.

## Known limitations

- **In-memory only.** Runs live in the server process (finished runs are dropped after
  30 minutes). Restarting the server loses them and kills running containers.
- **Single turn.** No follow-ups, no file upload, no diffs or downloads; `/workspace`
  starts empty and goes away with the container.
- **Costs are not equal.** The Claude SDK reports a USD cost; the Codex SDK only reports
  tokens, so its cost shows as "—". Claude input tokens include cache reads and writes,
  so both columns count all input.
- **Timing.** "Wall time" includes container startup; "Agent time" is what the agent
  reported (Claude) or measured in the runner (Codex).
- **Streaming granularity.** Messages appear once complete (no token-by-token streaming).
  Tool output is capped at 8,000 characters in the runner.
- **Network.** Containers have normal outbound network access (the agents need their
  APIs and web search). Only memory and CPU are limited.
- **Big images (~1.15 GB each).** Each SDK ships a native CLI binary (~350 MB). Both images
  are built from one Dockerfile with a shared runtime stage, so the environment is identical;
  only a prune step removes the other agents' SDKs.
- **Images are built for the host architecture.** Build on the machine that runs them.
- **Yarn age gate.** Yarn 4 refuses versions published less than a day ago, so
  dependencies use caret ranges and resolve to the newest version older than that.

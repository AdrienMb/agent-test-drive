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
- `yarn test`: runs the Vitest suites of every workspace (no Docker or API keys needed).
- `yarn build:shared`: builds `packages/shared` (`dev` and `typecheck` run it first).

After changing anything in `packages/runner` or `packages/shared`, run
`yarn docker:build` again (or `docker:build:claude` / `docker:build:codex` for one agent):
the runner only runs inside the images.

### Try it

Send _"Write a Python script that prints the first 20 Fibonacci numbers, then run it"_.
Both columns stream live; shell commands and file edits get highlighted cards, and a
comparison table (time, tool calls by kind, files edited, files in the workspace, tokens, cost) appears once both
agents are finished. **Cancel** runs `docker kill` on both containers.
`docker ps` should show nothing left after a run.

## Configuration

| Variable              | Default                      | Used by                    |
| --------------------- | ---------------------------- | -------------------------- |
| `ANTHROPIC_API_KEY`   |                              | Claude container           |
| `OPENAI_API_KEY`      |                              | Codex container            |
| `PORT`                | `3000`                       | API server                 |
| `APP_PASSWORD`        |                              | Password gate (required in production) |
| `API_PORT`            | `3000`                       | Vite dev proxy target      |
| `RUNNER_IMAGE_CLAUDE` | `agent-runner-claude:latest` | Image for the Claude agent |
| `RUNNER_IMAGE_CODEX`  | `agent-runner-codex:latest`  | Image for the Codex agent  |
| `SANDBOX_PROVIDER`    | `docker`                     | Where runners execute      |
| `RAILWAY_TOKEN`       |                              | Railway provider (project token) |
| `RAILWAY_API_TOKEN`   |                              | Railway provider, instead of `RAILWAY_TOKEN` (needs `RAILWAY_ENVIRONMENT_ID`) |
| `RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES` | `5`         | Railway provider           |

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
- `railway` (production): `RailwaySandboxProvider` in `sandbox/railway.provider.ts`, see
  [Railway sandboxes](#railway-sandboxes).

To add a provider, implement `SandboxProvider` in `apps/server/src/sandbox/` (reuse
`parseRunnerLine` from `runner-protocol.ts` if the runner's stdout comes back as text
lines) and register it in `createSandboxProvider` in `sandbox.module.ts`.

### Railway sandboxes

Each agent of each run gets a fresh [Railway sandbox](https://docs.railway.com/sandboxes)
(an isolated VM), created with the `railway` SDK and destroyed when the agent exits.
Sandboxes can't boot a Docker image, so `runnerTemplate()` rebuilds
`agent-runner.Dockerfile` as a sandbox template per agent: node, npm and python3 exposed to
an `agent` user (the base image keeps them under `/root` with mise; git and ripgrep are already
there, and apt only runs if something is missing, since its Ubuntu mirrors can be slow enough
to hit Railway's 5-minute build limit), `/workspace` as a git repo, and the agent's SDKs installed with npm in
`/opt/atd` at the exact versions in `packages/runner/dist/sandbox-deps.json` (written by
the runner build from what Yarn installed). Templates are cached by recipe, so they only
rebuild when an SDK version changes; the server builds both at boot to warm the cache.

For each agent the provider then:

1. creates the sandbox from the template (`2 vCPU / 2 GB`, idle timeout 5 minutes),
2. uploads the compiled runner, `@atd/shared` (a few small JS files) and the job as
   `/opt/atd/job.json`,
3. runs `node /opt/atd/runner/dist/main.js < /opt/atd/job.json` as `agent` in `/workspace`
   with an ephemeral exec: the API key goes in the exec's env (never the sandbox's), and
   stdout goes through the same `splitLines` + `parseRunnerLine` as Docker,
4. heartbeats every minute while it runs, then destroys the sandbox.

Cancel and the 10-minute timeout destroy the sandbox. The idle timeout only matters if
the server dies mid-run: the sandbox is gone at most 5 minutes later.

## Deploy on Railway

`.railway/railway.ts` ([Infrastructure as Code](https://docs.railway.com/infrastructure-as-code))
defines one service built from `docker/server.Dockerfile`: the NestJS API also serves the
built web app, and `SANDBOX_PROVIDER=railway` is set in the image. The image doesn't contain
the agent SDKs (~380 MB instead of ~1.15 GB per runner image).

Railway doesn't read `.railway/` on deploy: service settings change only when you apply
them with the Railway CLI (5.42.1 or newer).

1. Create a project, then from the repo root: `railway login`, `railway link`,
   `railway config plan` (review it), `railway config apply`. This creates the
   `agent-test-drive` service from the GitHub repo, or updates the service with that name.
   Don't let Railway's GitHub import split the monorepo into one service per workspace.
2. In the project settings, create a **project token** for the environment, then set the
   service variables `RAILWAY_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `APP_PASSWORD`.
   The config marks them `preserve()`: it keeps their values on Railway and never holds them.
3. Generate a public domain for the service. The deploy healthcheck is `GET /api/health`.

`APP_PASSWORD` keeps strangers from spending your API credits. The web app asks for it once
and keeps it in a cookie; every API route except `/api/health` refuses requests without it,
and the server refuses to start in production without it. Locally it is optional: leave it
unset and there is no prompt.

After editing `.railway/railway.ts`, run `railway config plan` and `railway config apply`
again; pushing the file changes nothing on Railway.

Sandboxes run in the token's environment and count toward its plan limits (10 at a time
on Trial and Free, i.e. 5 concurrent runs). `numReplicas` is 1 and `overlapSeconds` is 0
on purpose: runs live in memory, so a second replica would get SSE requests for runs it
doesn't know. `drainingSeconds: 30` gives the old deploy time to destroy its sandboxes.

To try the production image locally: `docker build -f docker/server.Dockerfile -t agent-test-drive .`
then `docker run -p 3000:3000 --env-file .env -e RAILWAY_TOKEN=... agent-test-drive`.

## Workspace files

When the agent is done (or has failed), the runner scans `/workspace`
(`packages/runner/src/files.ts`) and emits one `files` event before the final status. The
filesystem is the source of truth: files created by shell commands count too, not only
those from `file_edit` tool calls. Each agent column then shows a **Workspace files** panel.

Everything that comes out of a container is treated as hostile, because the agent can
write to the runner's stdout directly and bypass the runner:

- **Runner.** The scan never follows symlinks (it opens files with `O_NOFOLLOW` and checks
  with `fstat`), doesn't block on FIFOs, skips `.git`, `node_modules` and similar folders,
  sends no content for binary files, files over 64 KB, anything past a 512 KB total,
  or likely credential files (`.env`, `id_rsa`, `*.pem`, `.npmrc`…), and stops at 200 files.
  Names with control or bidi characters (e.g. U+202E) are left out.
- **Secrets.** The runner redacts the values of `*KEY*`/`*TOKEN*`/`*SECRET*`/`*PASSWORD*`
  env vars from every event. The server redacts every API key it knows from every event
  it streams and from its logs, which is the layer that can't be bypassed.
- **Server.** `parseRunnerLine` checks every field of a `files` event (safe relative paths,
  no duplicates, byte limits, known skip reasons), rebuilds it without unknown fields, and
  only the first `files` event per agent is kept.
- **Browser.** File content and names are only ever rendered as React text, never as
  HTML, SVG or Markdown, and nothing is previewed in an iframe. Downloads are
  `application/octet-stream` blobs with a sanitized basename and are never opened in a tab.
  A test fails if any web source uses `dangerouslySetInnerHTML`, `innerHTML`, `srcdoc` or `eval`.

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
  30 minutes). Restarting the server loses them and kills running containers or sandboxes.
  On Railway, every redeploy does that.
- **Single turn.** No follow-ups, no file upload, no diffs; `/workspace`
  starts empty and goes away with the container.
- **Costs are not equal.** The Claude SDK reports a USD cost; the Codex SDK only reports
  tokens, so its cost shows as "—". Claude input tokens include cache reads and writes,
  so both columns count all input.
- **Timing.** "Wall time" includes container startup; "Agent time" is what the agent
  reported (Claude) or measured in the runner (Codex).
- **Workspace files are a final snapshot.** They appear when the agent finishes, not live,
  and not at all on cancel or timeout (the container is killed). Only small UTF-8 text files
  can be viewed or downloaded.
- **Redaction is literal.** It catches a key that was printed or written as is (e.g.
  `env > dump.txt`), not one the agent deliberately encodes. Files the scan reads are ones the
  agent could already print in a shell command, so the panel doesn't widen that exposure.
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

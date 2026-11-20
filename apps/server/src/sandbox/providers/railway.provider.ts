import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { Sandbox, type CreateOptions, type ExecOptions, type ExecStdin, type SandboxTemplate } from "railway";
import { AGENTS, type AgentId } from "@atd/shared";
import { splitLines } from "../line-splitter.js";
import { MAX_LINE_BYTES, parseRunnerLine } from "../runner-protocol.js";
import type { SandboxHandle, SandboxListener, SandboxProvider, SandboxSpec } from "../sandbox.types.js";

const MAX_STDERR_LINE_BYTES = 64 * 1024;
const HEARTBEAT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Where the runner lives inside the sandbox; the SDKs are installed here by the template. */
const APP_DIR = "/opt/atd";
const WORKSPACE = "/workspace";
const AGENT_USER = "agent";

/** Mirrors the prune stages of docker/agent-runner.Dockerfile. */
const EXCLUDED_SCOPES: Record<AgentId, string[]> = {
  claude: ["@openai/"],
  codex: ["@anthropic-ai/", "@modelcontextprotocol/"],
};

/** runuser keeps root's PATH, whose mise entries under /root (mode 700) the agent user can't use. */
const AGENT_ENV = `PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/${AGENT_USER}`;

// Claude Code refuses bypassPermissions as root, and the Docker image runs as `node` too.
// Jobs and follow-ups arrive on the exec's stdin, which runuser passes through.
const RUN_COMMAND = [
  `if [ "$(id -u)" = 0 ]; then exec runuser -u ${AGENT_USER} -- env ${AGENT_ENV} node ${APP_DIR}/runner/dist/main.js;`,
  `else exec node ${APP_DIR}/runner/dist/main.js; fi`,
].join(" ");

/**
 * The base image ships node and python3 through mise under /root, so copy each install to /opt and link it
 * into /usr/local/bin. Each interpreter reports its own prefix, which works whether PATH holds mise shims or not.
 */
const EXPOSE_TOOLS = [
  "expose() {",
  '  prefix="$1"; dest="$2"; shift 2',
  '  case "$prefix" in ""|/usr|/usr/local) return 0 ;; esac',
  '  rm -rf "$dest" && cp -a "$prefix" "$dest"',
  '  for bin in "$@"; do if [ -e "$dest/bin/$bin" ]; then ln -sf "$dest/bin/$bin" "/usr/local/bin/$bin"; fi; done',
  "}",
  `expose "$(node -p 'require("path").resolve(process.execPath, "../..")' 2>/dev/null)" /opt/node node npm npx`,
  `expose "$(python3 -c 'import sys; print(sys.base_prefix)' 2>/dev/null)" /opt/python python3 pip3`,
].join("\n");

/**
 * The base image already has these, and apt is a last resort: a full `apt-get update` against the Ubuntu
 * mirrors has taken over 5 minutes, Railway's limit for a template build.
 */
const INSTALL_MISSING = [
  'missing=""',
  "for pair in git:git rg:ripgrep python3:python3; do",
  '  PATH=/usr/local/bin:/usr/bin:/bin command -v "${pair%%:*}" >/dev/null || missing="$missing ${pair#*:}"',
  "done",
  '[ -e /etc/ssl/certs/ca-certificates.crt ] || missing="$missing ca-certificates"',
  '[ -z "$missing" ] || { apt-get update && apt-get install -y --no-install-recommends $missing; }',
].join("\n");

const RUNNER_ENV = { NODE_ENV: "production", DISABLE_AUTOUPDATER: "1" };

/** The subset of the SDK's Sandbox this provider uses, so tests can fake it. */
export interface RemoteSandbox {
  readonly id: string;
  exec(command: string, options: ExecOptions): PromiseLike<{ exitCode: number | null }> & { readonly stdin: Pick<ExecStdin, "write"> };
  readonly files: { write(path: string, data: string | Uint8Array): Promise<void> };
  heartbeat(): Promise<unknown>;
  destroy(): Promise<void>;
}

type CreateSandbox = (agent: AgentId, options: CreateOptions) => Promise<RemoteSandbox>;

interface BundleFile {
  path: string;
  content: string | Uint8Array;
}

export interface RailwayProviderOptions {
  /** Defaults to Sandbox.create from a per-agent template. */
  createSandbox?: CreateSandbox;
  /** Defaults to the built runner and shared packages of this repo. */
  bundle?: BundleFile[];
  idleTimeoutMinutes?: number;
}

interface LiveSandbox {
  killed: boolean;
  /** Set once the runner's exec has started. */
  write?: (line: string) => void;
  booting?: Promise<RemoteSandbox>;
  destroyed?: Promise<void>;
}

const packageDir = (name: string) => fileURLToPath(new URL(`../../../../../packages/${name}/`, import.meta.url));

function listJsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js"))
    .map((e) => join(e.parentPath, e.name));
}

/** The compiled runner, laid out so `@atd/shared` resolves from APP_DIR/node_modules next to the SDKs. */
function loadRunnerBundle(): BundleFile[] {
  const runner = join(packageDir("runner"), "dist");
  const shared = packageDir("shared");
  return [
    { path: `${APP_DIR}/runner/package.json`, content: '{"type":"module"}\n' },
    ...listJsFiles(runner).map((file) => ({ path: `${APP_DIR}/runner/dist/${relative(runner, file)}`, content: readFileSync(file) })),
    { path: `${APP_DIR}/node_modules/@atd/shared/package.json`, content: readFileSync(join(shared, "package.json")) },
    ...listJsFiles(join(shared, "dist")).map((file) => ({
      path: `${APP_DIR}/node_modules/@atd/shared/${relative(shared, file)}`,
      content: readFileSync(file),
    })),
  ];
}

function loadSandboxDeps(): Record<string, string> {
  const file = join(packageDir("runner"), "dist", "sandbox-deps.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  } catch (err) {
    throw new Error(`Cannot read ${file}; run \`yarn workspace @atd/runner build\` (${(err as Error).message})`);
  }
}

/** The Railway equivalent of docker/agent-runner.Dockerfile. Templates are cached by recipe, so a new SDK version builds a new one. */
function runnerTemplate(agent: AgentId, deps: Record<string, string>): SandboxTemplate {
  const packages = Object.entries(deps)
    .filter(([name]) => !EXCLUDED_SCOPES[agent].some((scope) => name.startsWith(scope)))
    .map(([name, version]) => `${name}@${version}`);
  return (
    Sandbox.template()
      .run(`node -e 'if (+process.versions.node.split(".")[0] < 22) { console.error("Node 22+ required, found " + process.version); process.exit(1); }'`)
      .run(EXPOSE_TOOLS)
      .run(INSTALL_MISSING)
      .run(`id -u ${AGENT_USER} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${AGENT_USER}`)
      .run(`mkdir -p ${APP_DIR} && cd ${APP_DIR} && echo '{"private":true}' > package.json && npm install --omit=dev --no-audit --no-fund ${packages.join(" ")}`)
      .run(`mkdir -p ${WORKSPACE} && chown ${AGENT_USER}:${AGENT_USER} ${WORKSPACE}`)
      .run(
        `runuser -u ${AGENT_USER} -- env ${AGENT_ENV} sh -c 'git config --global user.name agent && git config --global user.email agent@localhost` +
          ` && git config --global init.defaultBranch main && cd ${WORKSPACE} && git init -q'`,
      )
  );
}

function templateSandboxCreator(logger: Logger): CreateSandbox {
  const deps = loadSandboxDeps();
  const templates = new Map<AgentId, Promise<SandboxTemplate>>();
  for (const { id: agent } of AGENTS) {
    const recipe = runnerTemplate(agent, deps);
    // Warm the cache at boot so the first run doesn't wait for npm. On failure, create() builds again and reports the error.
    const built = recipe.build().catch((err: unknown) => {
      logger.warn(`Template build for ${agent} failed, will retry on first run: ${(err as Error).message}`);
      return recipe;
    });
    templates.set(agent, built);
  }
  return async (agent, options) => Sandbox.create(await templates.get(agent)!, options);
}

export class RailwaySandboxProvider implements SandboxProvider {
  readonly kind = "railway" as const;
  private readonly logger = new Logger(RailwaySandboxProvider.name);
  private readonly live = new Map<string, LiveSandbox>();
  private readonly createSandbox: CreateSandbox;
  private readonly bundle: BundleFile[];
  private readonly idleTimeoutMinutes: number;

  constructor(options: RailwayProviderOptions = {}) {
    this.bundle = options.bundle ?? loadRunnerBundle();
    this.createSandbox = options.createSandbox ?? templateSandboxCreator(this.logger);
    // 5 minutes is the most Trial and Free plans allow. The heartbeat keeps a long run alive;
    // this only bounds how long a sandbox outlives a crashed server.
    this.idleTimeoutMinutes = options.idleTimeoutMinutes ?? 5;
  }

  start(spec: SandboxSpec, listener: SandboxListener): SandboxHandle {
    const live: LiveSandbox = { killed: false };
    this.live.set(spec.name, live);
    void this.run(spec, listener, live)
      .catch((err: unknown) => this.logger.error(`railway run ${spec.name} failed: ${(err as Error).message}`))
      .finally(() => this.live.delete(spec.name));
    return {
      name: spec.name,
      send: (message) => live.write?.(`${JSON.stringify(message)}\n`),
      kill: () => {
        live.killed = true;
        // Destroying the sandbox ends the exec, which makes run() report the exit.
        void this.destroy(live);
      },
    };
  }

  async shutdown(): Promise<void> {
    const pending = [...this.live.values()].map((live) => {
      live.killed = true;
      return this.destroy(live);
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
    await Promise.race([Promise.allSettled(pending), timeout]);
  }

  private async run(spec: SandboxSpec, listener: SandboxListener, live: LiveSandbox): Promise<void> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    splitLines(
      stdout,
      MAX_LINE_BYTES,
      (line) => {
        if (!line.trim()) return;
        const parsed = parseRunnerLine(line);
        if (parsed) listener.onEvent(parsed.event, parsed.turn);
        else listener.onLog(`unrecognized stdout: ${line}`);
      },
      () => listener.onLog(`dropped a stdout line over ${MAX_LINE_BYTES} bytes`),
    );
    splitLines(
      stderr,
      MAX_STDERR_LINE_BYTES,
      (line) => listener.onLog(line),
      () => listener.onLog(`dropped a stderr line over ${MAX_STDERR_LINE_BYTES} bytes`),
    );

    let exit: { code: number | null; error?: Error } = { code: null };
    let execStarted = false;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      live.booting = this.createSandbox(spec.agent, {
        idleTimeoutMinutes: this.idleTimeoutMinutes,
        // Railway counts decimal GB, so 2048 MiB becomes 2 GB: the most Trial and Free plans allow.
        resources: { cpu: spec.limits.cpus, memoryGB: spec.limits.memoryMb / 1024 },
      });
      const sandbox = await live.booting;
      listener.onLog(`railway sandbox ${sandbox.id} is running`);
      if (live.killed) return;
      heartbeat = setInterval(() => void sandbox.heartbeat().catch(() => {}), HEARTBEAT_MS).unref();

      await Promise.all(this.bundle.map((f) => sandbox.files.write(f.path, f.content)));
      if (live.killed) return;

      execStarted = true;
      const exec = sandbox.exec(RUN_COMMAND, {
        cwd: WORKSPACE,
        env: { ...RUNNER_ENV, ...spec.env },
        ephemeral: true,
        stdin: true,
        captureOutput: false,
        // A rejected exec gives no guarantee its callbacks have stopped, and writing to an ended stream throws.
        onStdout: (chunk) => void (stdout.writableEnded || stdout.write(chunk)),
        onStderr: (chunk) => void (stderr.writableEnded || stderr.write(chunk)),
      });
      // Chained so lines reach the runner in order.
      let writes = Promise.resolve();
      live.write = (line) => {
        writes = writes.then(() => exec.stdin.write(line)).catch((err: unknown) => listener.onLog(`railway stdin write failed: ${(err as Error).message}`));
      };
      live.write(`${JSON.stringify(spec.job)}\n`);
      exit = { code: (await exec).exitCode };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (execStarted) listener.onLog(`railway exec failed: ${error.message}`);
      else exit = { code: null, error };
    } finally {
      clearInterval(heartbeat);
      live.write = undefined;
      stdout.end();
      stderr.end();
      await Promise.allSettled([finished(stdout), finished(stderr)]);
      listener.onExit(exit);
      await this.destroy(live);
    }
  }

  /** Waits for a sandbox that is still booting, so shutdown doesn't exit before it can be destroyed. */
  private destroy(live: LiveSandbox): Promise<void> {
    if (!live.booting) return Promise.resolve();
    live.destroyed ??= live.booting.then(
      (sandbox) =>
        sandbox.destroy().catch((err: unknown) => {
          this.logger.warn(`Could not destroy railway sandbox ${sandbox.id}: ${(err as Error).message}`);
        }),
      () => {}, // create failed, so there is nothing to destroy
    );
    return live.destroyed;
  }
}

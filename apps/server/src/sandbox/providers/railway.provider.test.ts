import { describe, expect, it, vi } from "vitest";
import type { ExecOptions } from "railway";
import type { NormalizedEvent } from "@atd/shared";
import { RailwaySandboxProvider, type RemoteSandbox } from "./railway.provider.js";
import type { SandboxSpec } from "../sandbox.types.js";

const spec: SandboxSpec = {
  name: "cmp-abc-claude",
  agent: "claude",
  job: { agent: "claude", prompt: "hi", turn: "t1" },
  env: { ANTHROPIC_API_KEY: "sk-test" },
  limits: { memoryMb: 2048, cpus: 2 },
};

function fakeSandbox() {
  let finish!: (code: number | null) => void;
  let fail!: (err: Error) => void;
  const execs: { command: string; options: ExecOptions }[] = [];
  const stdin: string[] = [];
  const result = new Promise<{ exitCode: number | null }>((resolve, reject) => {
    finish = (exitCode) => resolve({ exitCode });
    fail = reject;
  });
  result.catch(() => {}); // destroyed before any exec
  const sandbox: RemoteSandbox = {
    id: "sbx-1",
    exec: (command, options) => {
      execs.push({ command, options });
      return Object.assign(result.then((r) => r), { stdin: { write: async (line: string | Uint8Array) => void stdin.push(String(line)) } });
    },
    files: { write: vi.fn(async () => {}) },
    heartbeat: async () => sandbox,
    destroy: vi.fn(async () => fail(new Error("sandbox destroyed"))),
  };
  return { sandbox, execs, stdin, finish, fail, out: (s: string) => execs[0]!.options.onStdout!(s) };
}

function listener() {
  const events: NormalizedEvent[] = [];
  let resolveExit!: (info: { code: number | null; error?: Error }) => void;
  const exited = new Promise<{ code: number | null; error?: Error }>((r) => (resolveExit = r));
  return { events, exited, onEvent: (e: NormalizedEvent) => events.push(e), onLog: () => {}, onExit: vi.fn((info) => resolveExit(info)) };
}

const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true));

describe("RailwaySandboxProvider", () => {
  it("uploads the runner, sends the job on stdin, streams events and destroys the sandbox", async () => {
    const fake = fakeSandbox();
    const create = vi.fn(async () => fake.sandbox);
    const provider = new RailwaySandboxProvider({ createSandbox: create, bundle: [{ path: "/opt/atd/runner/dist/main.js", content: "x" }] });
    const l = listener();
    const handle = provider.start(spec, l);

    await until(() => fake.execs.length === 1);
    expect(create).toHaveBeenCalledWith("claude", expect.objectContaining({ resources: { cpu: 2, memoryGB: 2 } }));
    expect(fake.sandbox.files.write).toHaveBeenCalledWith("/opt/atd/runner/dist/main.js", "x");
    expect(fake.execs[0]!.options).toMatchObject({ cwd: "/workspace", env: { ANTHROPIC_API_KEY: "sk-test" }, stdin: true });
    handle.send({ prompt: "add tests", turn: "t2" });
    await until(() => fake.stdin.length === 2);
    expect(fake.stdin.map((line) => JSON.parse(line))).toEqual([spec.job, { prompt: "add tests", turn: "t2" }]);

    fake.out('{"kind":"message","text":"hel');
    fake.out('lo"}\n{"kind":"status","status":"done"}');
    fake.finish(0);

    expect(await l.exited).toEqual({ code: 0 });
    expect(l.events).toEqual([
      { kind: "message", text: "hello" },
      { kind: "status", status: "done" },
    ]);
    await until(() => vi.mocked(fake.sandbox.destroy).mock.calls.length === 1);
    expect(l.onExit).toHaveBeenCalledTimes(1);
  });

  it("reports a create failure as a start error", async () => {
    const provider = new RailwaySandboxProvider({ createSandbox: async () => Promise.reject(new Error("quota")), bundle: [] });
    const l = listener();
    provider.start(spec, l);
    const { code, error } = await l.exited;
    expect(code).toBeNull();
    expect(error?.message).toBe("quota");
  });

  it("kill destroys the sandbox and still reports one exit", async () => {
    const fake = fakeSandbox();
    const provider = new RailwaySandboxProvider({ createSandbox: async () => fake.sandbox, bundle: [] });
    const l = listener();
    const handle = provider.start(spec, l);
    await until(() => fake.execs.length === 1);

    handle.kill();
    expect(await l.exited).toEqual({ code: null });
    expect(fake.sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(l.onExit).toHaveBeenCalledTimes(1);
  });

  it("destroys a sandbox that finishes booting after kill, without running the job", async () => {
    const fake = fakeSandbox();
    let boot!: () => void;
    const booted = new Promise<void>((r) => (boot = r));
    const provider = new RailwaySandboxProvider({ createSandbox: () => booted.then(() => fake.sandbox), bundle: [] });
    const l = listener();
    provider.start(spec, l).kill();
    boot();

    await l.exited;
    await until(() => vi.mocked(fake.sandbox.destroy).mock.calls.length === 1);
    expect(fake.execs).toHaveLength(0);
  });

  it("ignores output that arrives after the exec fails", async () => {
    const fake = fakeSandbox();
    const provider = new RailwaySandboxProvider({ createSandbox: async () => fake.sandbox, bundle: [] });
    const l = listener();
    provider.start(spec, l);
    await until(() => fake.execs.length === 1);
    fake.fail(new Error("connection lost"));

    expect(await l.exited).toEqual({ code: null });
    expect(() => fake.out('{"kind":"status","status":"done"}\n')).not.toThrow();
    await until(() => vi.mocked(fake.sandbox.destroy).mock.calls.length === 1);
    expect(l.events).toEqual([]);
  });

  it("shutdown waits for a booting sandbox and destroys it", async () => {
    const fake = fakeSandbox();
    let boot!: () => void;
    const booted = new Promise<void>((r) => (boot = r));
    const provider = new RailwaySandboxProvider({ createSandbox: () => booted.then(() => fake.sandbox), bundle: [] });
    provider.start(spec, listener());

    const shutdown = provider.shutdown();
    setTimeout(boot, 10);
    await shutdown;
    expect(fake.sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(fake.execs).toHaveLength(0);
  });

  it("shutdown destroys every live sandbox", async () => {
    const fakes = [fakeSandbox(), fakeSandbox()];
    let i = 0;
    const provider = new RailwaySandboxProvider({ createSandbox: async () => fakes[i++]!.sandbox, bundle: [] });
    provider.start(spec, listener());
    provider.start({ ...spec, name: "cmp-abc-codex", agent: "codex" }, listener());
    await until(() => fakes.every((f) => f.execs.length === 1));

    await provider.shutdown();
    for (const f of fakes) expect(f.sandbox.destroy).toHaveBeenCalled();
  });
});

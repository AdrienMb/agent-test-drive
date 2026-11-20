import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { passphraseGate, resolvePassphrase } from "./passphrase-gate.js";

function call(url: string, cookie?: string) {
  const req = { url, headers: { cookie } } as IncomingMessage;
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  passphraseGate("s3cret phrase")(req, res as unknown as ServerResponse, next);
  return { res, next };
}

const passphrase = (value: string) => `theme=dark; atd_passphrase=${encodeURIComponent(value)}`;

describe("passphraseGate", () => {
  it("lets the right passphrase through", () => {
    expect(call("/api/runs", passphrase("s3cret phrase")).next).toHaveBeenCalled();
    expect(call("/api/runs/1/events?x=1", "atd_passphrase=s3cret%20phrase").next).toHaveBeenCalled();
  });

  it.each([
    ["no cookie", undefined],
    ["other cookies only", "theme=dark"],
    ["a wrong passphrase", passphrase("nope")],
    ["a malformed value", "atd_passphrase=%E0%A4%A"],
  ])("refuses %s, without asking the browser for Basic credentials", (_, cookie) => {
    const { res, next } = call("/api/runs", cookie);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.setHeader).not.toHaveBeenCalledWith("WWW-Authenticate", expect.anything());
  });

  it.each(["/API/runs", "/Api/runs/1/events", "/aPi/runs/1/cancel", "/API"])(
    "guards %s too, since Express routes case-insensitively",
    (url) => {
      const { res, next } = call(url);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    },
  );

  it("leaves the healthcheck and the web app open", () => {
    expect(call("/api/health").next).toHaveBeenCalled();
    expect(call("/api/health?probe=1").next).toHaveBeenCalled();
    expect(call("/").next).toHaveBeenCalled();
    expect(call("/assets/index.js").next).toHaveBeenCalled();
    expect(call("/api/healthz").next).not.toHaveBeenCalled();
    expect(call("/apix").next).toHaveBeenCalled();
  });
});

describe("resolvePassphrase", () => {
  it("is optional outside production", () => {
    expect(resolvePassphrase({})).toBeUndefined();
    expect(resolvePassphrase({ APP_PASSWORD: " pw " })).toBe("pw");
  });

  it("is required in production", () => {
    expect(() => resolvePassphrase({ NODE_ENV: "production", APP_PASSWORD: " " })).toThrow(/APP_PASSWORD/);
    expect(resolvePassphrase({ NODE_ENV: "production", APP_PASSWORD: "pw" })).toBe("pw");
  });
});

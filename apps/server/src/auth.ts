import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PASSPHRASE_COOKIE } from "@atd/shared";

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const HEALTH_PATH = "/api/health";

/**
 * Checks the passphrase cookie on every API route but the healthcheck, so Railway can still probe it.
 * The web app itself stays public: it holds no secrets and has to load to show the passphrase form.
 * A cookie rather than a header because EventSource cannot send headers.
 */
export function passphraseGate(passphrase: string): Middleware {
  const expected = digest(passphrase);
  return (req, res, next) => {
    // Express routes case-insensitively, so /API/runs reaches the same controller as /api/runs.
    const path = (req.url?.split("?")[0] ?? "").toLowerCase();
    if (!isApi(path) || path === HEALTH_PATH) return next();
    const given = readCookie(req.headers.cookie, PASSPHRASE_COOKIE);
    // Comparing digests keeps the comparison constant-time whatever the length of the input.
    if (given !== undefined && timingSafeEqual(digest(given), expected)) return next();
    // No WWW-Authenticate header: it would make the browser show its own login dialog.
    res.statusCode = 401;
    res.end("Passphrase required");
  };
}

/** The gate's passphrase, or undefined to run without one. Production refuses to start without one. */
export function resolvePassphrase(env: NodeJS.ProcessEnv): string | undefined {
  const passphrase = env.APP_PASSWORD?.trim() || undefined;
  if (!passphrase && env.NODE_ENV === "production") {
    throw new Error("APP_PASSWORD must be set in production");
  }
  return passphrase;
}

const isApi = (path: string) => path === "/api" || path.startsWith("/api/");

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

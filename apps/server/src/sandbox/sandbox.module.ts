import { Logger, Module } from "@nestjs/common";
import { DockerSandboxProvider } from "./docker.provider.js";
import { RailwaySandboxProvider } from "./railway.provider.js";
import { SANDBOX_PROVIDER, type SandboxProvider } from "./sandbox.types.js";

// 0 would mean "never idle out", so a crashed server could leak sandboxes indefinitely.
export function parseIdleTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES must be a positive whole number of minutes, got "${raw}"`);
  }
  return minutes;
}

function createSandboxProvider(): SandboxProvider {
  const kind = (process.env.SANDBOX_PROVIDER ?? "docker").trim().toLowerCase();
  switch (kind) {
    case "docker":
      Logger.log("Using the docker sandbox provider", "SandboxModule");
      return new DockerSandboxProvider();
    case "railway": {
      if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN) {
        throw new Error("SANDBOX_PROVIDER=railway needs RAILWAY_TOKEN (a project token) or RAILWAY_API_TOKEN");
      }
      // The SDK prefers RAILWAY_TOKEN; only a bearer token lacks an implied environment.
      if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_ENVIRONMENT_ID) {
        throw new Error("RAILWAY_API_TOKEN needs RAILWAY_ENVIRONMENT_ID (or use a project token in RAILWAY_TOKEN)");
      }
      Logger.log("Using the railway sandbox provider", "SandboxModule");
      return new RailwaySandboxProvider({ idleTimeoutMinutes: parseIdleTimeout(process.env.RAILWAY_SANDBOX_IDLE_TIMEOUT_MINUTES) });
    }
    default:
      throw new Error(`Unknown SANDBOX_PROVIDER "${kind}" (expected docker|railway)`);
  }
}

@Module({
  providers: [{ provide: SANDBOX_PROVIDER, useFactory: createSandboxProvider }],
  exports: [SANDBOX_PROVIDER],
})
export class SandboxModule {}

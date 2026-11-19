import { Logger, Module } from "@nestjs/common";
import { DockerSandboxProvider } from "./docker.provider.js";
import { SANDBOX_PROVIDER, type SandboxProvider } from "./sandbox.types.js";

function createSandboxProvider(): SandboxProvider {
  const kind = (process.env.SANDBOX_PROVIDER ?? "docker").trim().toLowerCase();
  switch (kind) {
    case "docker":
      Logger.log("Using the docker sandbox provider", "SandboxModule");
      return new DockerSandboxProvider();
    case "railway":
      throw new Error("Railway sandbox provider is not implemented yet");
    default:
      throw new Error(`Unknown SANDBOX_PROVIDER "${kind}" (expected docker|railway)`);
  }
}

@Module({
  providers: [{ provide: SANDBOX_PROVIDER, useFactory: createSandboxProvider }],
  exports: [SANDBOX_PROVIDER],
})
export class SandboxModule {}

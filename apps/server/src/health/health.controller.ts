import { Controller, Get, Inject } from "@nestjs/common";
import { SANDBOX_PROVIDER, type SandboxProvider } from "../sandbox/sandbox.types.js";

/** Railway's deploy healthcheck. */
@Controller("health")
export class HealthController {
  constructor(@Inject(SANDBOX_PROVIDER) private readonly sandbox: SandboxProvider) {}

  @Get()
  health(): { ok: true; sandbox: string } {
    return { ok: true, sandbox: this.sandbox.kind };
  }
}

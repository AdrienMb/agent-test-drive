import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { RunsController } from "./runs/runs.controller.js";
import { RunsService } from "./runs/runs.service.js";
import { SandboxModule } from "./sandbox/sandbox.module.js";
import { SessionController } from "./auth/session.controller.js";

@Module({
  imports: [SandboxModule],
  controllers: [RunsController, HealthController, SessionController],
  providers: [RunsService],
})
export class AppModule {}

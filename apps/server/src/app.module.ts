import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { RunsController } from "./runs/runs.controller.js";
import { RunsService } from "./runs/runs.service.js";
import { SandboxModule } from "./sandbox/sandbox.module.js";

@Module({
  imports: [SandboxModule],
  controllers: [RunsController, HealthController],
  providers: [RunsService],
})
export class AppModule {}

import "reflect-metadata";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { passphraseGate, resolvePassphrase } from "./auth.js";

async function bootstrap(): Promise<void> {
  const passphrase = resolvePassphrase(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (passphrase) app.use(passphraseGate(passphrase));
  app.setGlobalPrefix("api");
  // In production one service serves both the API and the built web app; in dev Vite serves the web app.
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (process.env.NODE_ENV === "production" && existsSync(webDist)) app.useStaticAssets(webDist);
  // Lets RunsService kill running containers on Ctrl+C / restart.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api`, "Bootstrap");
}

void bootstrap();

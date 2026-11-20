import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { passphraseGate, resolvePassphrase } from "./auth/passphrase-gate.js";

async function bootstrap(): Promise<void> {
  const passphrase = resolvePassphrase(process.env);
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (passphrase) app.use(passphraseGate(passphrase));
  app.setGlobalPrefix("api");
  // In production one service serves both the API and the built web app; in dev Vite serves the web app.
  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (process.env.NODE_ENV === "production" && existsSync(webDist)) {
    app.useStaticAssets(webDist);
    // Client-side routes like /runs/:id must load the app on a reload too.
    const indexHtml = readFileSync(join(webDist, "index.html"));
    app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
      const path = (req.url?.split("?")[0] ?? "/").toLowerCase();
      if (req.method !== "GET" || path === "/api" || path.startsWith("/api/") || extname(path)) return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(indexHtml);
    });
  }
  // Lets RunsService kill running containers on Ctrl+C / restart.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API listening on http://localhost:${port}/api`, "Bootstrap");
}

void bootstrap();

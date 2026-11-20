import { defineRailway, github, preserve, service } from "railway/iac";

export default defineRailway((_ctx, project) => {
  const app = service("agent-test-drive", {
    source: github("AdrienMb/agent-test-drive", { branch: "main" }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "docker/server.Dockerfile",
      watchPatterns: ["apps/**", "packages/**", "docker/server.Dockerfile", "package.json", "yarn.lock"],
    },
    deploy: {
      startCommand: "node --enable-source-maps apps/server/dist/main.js",
      healthcheckPath: "/api/health",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 3,
      // Runs live in memory: a second replica, or an overlapping deploy, would get SSE
      // requests for runs it doesn't know. Draining gives the old deploy time to destroy its sandboxes.
      numReplicas: 1,
      overlapSeconds: 0,
      drainingSeconds: 30,
    },
    env: {
      RAILWAY_TOKEN: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      OPENAI_API_KEY: preserve(),
      APP_PASSWORD: preserve(),
    },
  });

  return project("agent-test-drive", { resources: [app] });
});

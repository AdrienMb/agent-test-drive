import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run against the shared sources, so they never see a stale dist.
const alias = { "@atd/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "shared", include: ["packages/shared/src/**/*.test.ts"] } },
      { resolve: { alias }, test: { name: "runner", include: ["packages/runner/src/**/*.test.ts"] } },
      { resolve: { alias }, test: { name: "server", include: ["apps/server/src/**/*.test.ts"] } },
      {
        resolve: { alias },
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["apps/web/src/test-setup.ts"],
        },
      },
    ],
  },
});

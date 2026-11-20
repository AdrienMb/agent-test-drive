import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Older targets make Lightning CSS lower light-dark() into --lightningcss-* vars that
    // nothing defines (Mantine's color-scheme is a var), so those declarations go invalid.
    cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${process.env.API_PORT ?? 3000}`, changeOrigin: true },
    },
  },
});

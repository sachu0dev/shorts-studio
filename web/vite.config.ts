import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The Node/Express control plane owns /api and /files (server/index.ts).
// The dev server proxies both so relative fetch() calls work unchanged
// whether served by Vite (dev) or by Express from web/dist (prod).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(dirname, "./src") } },
  server: {
    proxy: {
      "/api": "http://localhost:5177",
      "/files": "http://localhost:5177",
    },
  },
});

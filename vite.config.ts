import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  // Never inline assets as data: URIs; the CSP only allows same-origin fonts and scripts.
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/fixtures": "http://localhost:8080" },
  },
});

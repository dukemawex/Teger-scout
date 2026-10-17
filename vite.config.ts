import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/fixtures": "http://localhost:8080" },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "production" ? "/noty/" : "/",
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: [".e2b.app"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  css: { postcss: { plugins: [] } },
}));

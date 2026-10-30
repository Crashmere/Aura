import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "/aura/",
  server: {
    proxy: {
      // Preserve the browser Host for the backend's same-origin write check.
      "/aura/api": { target: "http://127.0.0.1:18087", changeOrigin: false },
      "/aura/media": "http://127.0.0.1:18087",
      "/aura/healthz": "http://127.0.0.1:18087",
    },
  },
});

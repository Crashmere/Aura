import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: "/aura/",
  server: {
    proxy: {
      "/aura/api": "http://127.0.0.1:18087",
      "/aura/media": "http://127.0.0.1:18087",
      "/aura/healthz": "http://127.0.0.1:18087",
    },
  },
});

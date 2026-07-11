import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import process from "node:process";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "DG Chat",
        short_name: "DG Chat",
        description: "A private, self-hosted AI workspace",
        theme_color: "#f7f7f5",
        background_color: "#f7f7f5",
        display: "standalone",
        icons: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/v1": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
    },
  },
});

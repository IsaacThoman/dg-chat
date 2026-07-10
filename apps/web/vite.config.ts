import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

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
    proxy: { "/api": "http://localhost:8000", "/v1": "http://localhost:8000" },
  },
});

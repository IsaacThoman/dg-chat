import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { pwaNavigationDenylist } from "./src/pwaNavigation.ts";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Keep the current worker (and its lazy chunks) alive until every client closes. An
      // auto-updating worker can delete version N's precache while a long-lived version N tab is
      // still streaming or has not loaded a route chunk yet. The app renders an explicit update
      // notice; the browser activates the waiting worker naturally once no old clients remain.
      registerType: "prompt",
      workbox: {
        clientsClaim: false,
        skipWaiting: false,
        // KaTeX loads fonts from split CSS at render time. Keep version N's complete font graph in
        // its precache while N+1 waits, and make mathematical output genuinely offline-capable.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2,ttf}"],
        navigateFallbackDenylist: pwaNavigationDenylist,
      },
      manifest: {
        id: "/",
        name: "DG Chat",
        short_name: "DG Chat",
        description: "A private, self-hosted AI workspace",
        start_url: "/",
        scope: "/",
        theme_color: "#f7f7f5",
        background_color: "#f7f7f5",
        display: "standalone",
        categories: ["productivity", "utilities"],
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[/\\](?:react|react-dom|scheduler)@/.test(id)) return "react-vendor";
          if (id.includes("@tanstack")) return "tanstack-vendor";
          if (
            id.includes("react-markdown") || id.includes("remark-gfm") ||
            id.includes("rehype-highlight")
          ) {
            return "markdown-vendor";
          }
          if (id.includes("katex") || id.includes("rehype-katex") || id.includes("remark-math")) {
            return "math-renderer";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    // Deno's npm linker stores KaTeX fonts in the workspace-level node_modules/.deno tree. Limit
    // development file serving to this repository root rather than opening arbitrary host paths.
    fs: { allow: [workspaceRoot] },
    proxy: {
      "/api": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
      "/v1": process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000",
    },
  },
});

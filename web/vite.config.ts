import path from "path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // SW in `npm run dev` too, so the /_download streaming-save path
      // (PLAN.md §10.4 strategy 2) is exercisable without a prod build.
      devOptions: { enabled: true, type: "module" },
      manifest: {
        name: "Pontje",
        short_name: "Pontje",
        description:
          "Self-hosted P2P file, link & clipboard relay between your devices",
        display: "standalone",
        background_color: "#0e1216",
        theme_color: "#0e1216",
        // Android share-target (PLAN.md §16, §22 Phase 7). `files` lets the OS
        // share sheet hand us attachments too; the SW reads them off the
        // multipart POST and stages them on Devices (see sw.ts).
        share_target: {
          action: "/share",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [{ name: "files", accept: ["*/*"] }],
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
})

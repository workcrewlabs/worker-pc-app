import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser build of WorkCrew: the same renderer React app, entered through
// src/renderer/src/main-web.tsx which installs the REST web bridge instead of
// the Electron preload. Build output is a static site (dist-web) served at the
// web app origin; VITE_WORKCREW_API points it at the backend.
export default defineConfig({
  root: resolve(__dirname, "web"),
  plugins: [react()],
  define: {
    "import.meta.env.VITE_WORKCREW_WEB": JSON.stringify("1")
  },
  build: {
    outDir: resolve(__dirname, "dist-web"),
    emptyOutDir: true
  },
  server: {
    port: 5190,
    fs: { allow: [resolve(__dirname)] }
  }
});

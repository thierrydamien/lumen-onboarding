import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the client chat bundle. The Sales and Dashboard pages are plain static
// HTML in public/ and are copied through untouched. Output goes to dist/, which
// netlify.toml publishes.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: { "chat-main": "src/chat-main.jsx" },
      output: {
        entryFileNames: "chat-main.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});

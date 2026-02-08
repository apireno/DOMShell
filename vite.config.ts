import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, mkdirSync } from "fs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "chrome-extension-post-build",
      closeBundle() {
        // Copy manifest.json and options.html into dist
        copyFileSync(
          resolve(__dirname, "public/manifest.json"),
          resolve(__dirname, "dist/manifest.json")
        );
        copyFileSync(
          resolve(__dirname, "public/options.html"),
          resolve(__dirname, "dist/options.html")
        );
        copyFileSync(
          resolve(__dirname, "public/options.js"),
          resolve(__dirname, "dist/options.js")
        );
      },
    },
  ],
  // Use relative paths so Chrome Extension can resolve assets
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "src/sidepanel/index.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
    target: "esnext",
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});

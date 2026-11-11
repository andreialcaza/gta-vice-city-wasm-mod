import { defineConfig } from "vite";

export default defineConfig({
  base: "/gta-vice-city-wasm-mod/",
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});

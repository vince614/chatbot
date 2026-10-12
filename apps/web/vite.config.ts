import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Tout appel à /api/* est relayé vers Fastify. Le front ne connaît
    // ni l'URL du fournisseur LLM ni sa clé.
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});

/**
 * Vite — apps/web (Etapa 9).
 * O pacote @biblioteca-global/ui aponta para src/ em dev e dist/ no build;
 * aqui forçamos o alias para o src para consumir o TypeScript direto
 * (mesma postura dos demais workspaces). Consumo via workspace npm.
 */
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Consumo direto do fonte da UI (evita depender de build prévio).
      "@biblioteca-global/ui": fileURLToPath(
        new URL("../../packages/ui/src/index.ts", import.meta.url),
      ),
      // Garante zod 4 único (raiz do monorepo).
      zod: fileURLToPath(new URL("../../node_modules/zod", import.meta.url)),
    },
  },
  server: {
    // Proxy das chamadas /api para o NestJS local (baseUrl do cliente).
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
})

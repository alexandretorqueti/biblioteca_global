import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@biblioteca-global/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@biblioteca-global/api-client": path.resolve(__dirname, "../../packages/api-client/src"),
      "@biblioteca-global/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5175,
  },
})

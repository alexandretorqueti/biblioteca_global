import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the UI package to its **source** during development inside the monorepo.
      // The UI package.json uses "exports" pointing exclusively to ./dist (correct for published packages).
      // Without this alias, Vite fails with "Failed to resolve entry for package" because dist/ has not been built yet.
      // Production / published usage: always run `npm run build --workspace @alexandretorqueti/biblioteca-global-ui` first.
      "@alexandretorqueti/biblioteca-global-ui": resolve(__dirname, "../../packages/ui/src"),
    },
    // Prevent Vite from trying to pre-bundle / resolve the linked package entry via its exports map.
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    // Critical: exclude the local linked package so Vite does not attempt to resolve its "exports" -> dist during dep scanning.
    exclude: ["@alexandretorqueti/biblioteca-global-ui"],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
})

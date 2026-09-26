import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

/** Build lib do pacote UI — gera dist/ (ESM) consumido pelo apps/web. */
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "BibliotecaGlobalUi",
      fileName: "index",
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@mui/material",
        "@mui/icons-material",
        "@mui/x-date-pickers",
        "@emotion/react",
        "@emotion/styled",
        "dayjs",
        "@biblioteca-global/shared",
      ],
    },
  },
})

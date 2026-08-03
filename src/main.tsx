import React from "react"
import ReactDOM from "react-dom/client"
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material"
import App from "./App"

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#6366f1",
    },
    background: {
      default: "#f8fafc",
    },
  },
  shape: {
    borderRadius: 12,
  },
  typography: {
    fontFamily: "Inter, system-ui, sans-serif",
  },
})

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)

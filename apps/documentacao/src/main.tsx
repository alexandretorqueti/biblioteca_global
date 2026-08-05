import React from "react"
import ReactDOM from "react-dom/client"
import {
  BibliotecaThemeProvider,
} from "@alexandretorqueti/biblioteca-global-ui"
import App from "./App"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BibliotecaThemeProvider>
      <App />
    </BibliotecaThemeProvider>
  </React.StrictMode>,
)

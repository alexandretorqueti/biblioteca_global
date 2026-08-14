import { createTheme, type Theme } from "@mui/material/styles"

export type BibliotecaThemeName = "claro" | "escuro"

export interface BibliotecaThemeOption {
  name: BibliotecaThemeName
  label: string
  theme: Theme
}

const baseTheme = {
  shape: {
    borderRadius: 12,
  },
  typography: {
    fontFamily: "Inter, system-ui, sans-serif",
  },
}

export const bibliotecaThemes: Record<BibliotecaThemeName, Theme> = {
  claro: createTheme({
    ...baseTheme,
    palette: {
      mode: "light",
      primary: {
        main: "#6366f1",
      },
      background: {
        default: "#f8fafc",
        paper: "#ffffff",
      },
    },
  }),
  escuro: createTheme({
    ...baseTheme,
    palette: {
      mode: "dark",
      primary: {
        main: "#818cf8",
      },
      background: {
        default: "#0f172a",
        paper: "#172033",
      },
    },
  }),
}

export const bibliotecaThemeOptions: BibliotecaThemeOption[] = [
  {
    name: "claro",
    label: "Claro",
    theme: bibliotecaThemes.claro,
  },
  {
    name: "escuro",
    label: "Escuro",
    theme: bibliotecaThemes.escuro,
  },
]

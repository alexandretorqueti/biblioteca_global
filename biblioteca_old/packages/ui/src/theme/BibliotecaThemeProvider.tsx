import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  CssBaseline,
  ThemeProvider,
} from "@mui/material"
import {
  bibliotecaThemes,
  type BibliotecaThemeName,
} from "./themes"

interface BibliotecaThemeContextValue {
  themeName: BibliotecaThemeName
  setThemeName: (themeName: BibliotecaThemeName) => void
}

const BibliotecaThemeContext =
  createContext<BibliotecaThemeContextValue | null>(null)

export interface BibliotecaThemeProviderProps {
  children: ReactNode
  initialTheme?: BibliotecaThemeName
}

export function BibliotecaThemeProvider({
  children,
  initialTheme = "claro",
}: BibliotecaThemeProviderProps) {
  const [themeName, setThemeName] =
    useState<BibliotecaThemeName>(initialTheme)

  const contextValue = useMemo(
    () => ({
      themeName,
      setThemeName,
    }),
    [themeName],
  )

  return (
    <BibliotecaThemeContext.Provider value={contextValue}>
      <ThemeProvider theme={bibliotecaThemes[themeName]}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </BibliotecaThemeContext.Provider>
  )
}

export function useBibliotecaTheme() {
  const context = useContext(BibliotecaThemeContext)

  if (!context) {
    throw new Error(
      "useBibliotecaTheme deve ser usado dentro de BibliotecaThemeProvider.",
    )
  }

  return context
}

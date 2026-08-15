import {
  createContext,
  useContext,
  useEffect,
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

  // `initialTheme` também representa a preferência controlada pelo host.
  // Sem esta sincronização, mudanças no contexto externo/localStorage
  // eram ignoradas depois da primeira renderização do provider.
  useEffect(() => {
    setThemeName(initialTheme)
  }, [initialTheme])

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

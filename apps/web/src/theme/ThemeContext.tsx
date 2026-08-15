/**
 * Tema claro/escuro persistido (Etapa 9).
 *
 * Reutiliza o `BibliotecaThemeProvider`/`useBibliotecaTheme` da UI (fonte
 * das cores) e adiciona a persistência da preferência do usuário.
 *
 * Persistência: por padrão em localStorage (preferência de apresentação do
 * cliente). Quando o back expuser preferências de perfil (perfil do
 * usuário), basta trocar o storage por uma chamada api-client preservando
 * a API deste provider — as telas continuam usando `useTheme()` sem saber
 * onde a preferência mora.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import {
  BibliotecaThemeProvider,
  useBibliotecaTheme,
} from "@biblioteca-global/ui"
import type { BibliotecaThemeName } from "@biblioteca-global/ui"

const PREFERENCE_KEY = "bg.themePreference"

// Tema padrão a ser usado quando não houver preferência armazenada ou
// ocorrer qualquer erro ao ler o `localStorage`. Mantemos como constante
// para facilitar futuras mudanças de padrão.
const DEFAULT_THEME: BibliotecaThemeName = "escuro"

function readPersisted(): BibliotecaThemeName {
  try {
    // Busca a preferência salva no `localStorage`. Se houver um
    // valor válido (`"claro"` ou `"escuro"`) ele será retornado.
    // Caso contrário — ausência de chave, valor inesperado ou erro —
    // o tema padrão definido por `DEFAULT_THEME` será usado. Isso garante que
    // novos usuários vejam o modo escuro inicialmente, mas ainda respeita
    // escolhas já armazenadas.
    const valor = localStorage.getItem(PREFERENCE_KEY)
    if (valor === "claro" || valor === "escuro") {
      return valor as BibliotecaThemeName
    }
    // Valor não reconhecido ou inexistente → tema padrão.
    return DEFAULT_THEME
  } catch {
    // Qualquer falha ao acessar o storage (por exemplo, modo privado)
    // também resulta no tema padrão como fallback seguro.
    return DEFAULT_THEME
  }
}

export interface ThemeContextValue {
  themeName: BibliotecaThemeName
  toggle: () => void
  setThemeName: (name: BibliotecaThemeName) => void
}

const ThemeSettingContext = createContext<ThemeContextValue | null>(null)

export function ThemeSettingProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeNameState] =
    useState<BibliotecaThemeName>(() => readPersisted())

  // Sincroniza a preferência no storage a cada mudança.
  useEffect(() => {
    try {
      localStorage.setItem(PREFERENCE_KEY, themeName)
    } catch {
      /* storage indisponível — segue sem persistir */
    }
  }, [themeName])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeName,
      toggle: () =>
        setThemeNameState((atual) =>
          atual === "claro" ? "escuro" : "claro",
        ),
      setThemeName: (name) => setThemeNameState(name),
    }),
    [themeName],
  )

  return (
    <ThemeSettingContext.Provider value={value}>
      <BibliotecaThemeProvider initialTheme={themeName}>
        {children}
      </BibliotecaThemeProvider>
    </ThemeSettingContext.Provider>
  )
}

export function useThemeSetting(): ThemeContextValue {
  const ctx = useContext(ThemeSettingContext)
  if (!ctx) {
    throw new Error(
      "useThemeSetting deve ser usado dentro de <ThemeSettingProvider>.",
    )
  }
  return ctx
}

/** Acesso direto ao tema atual (wrapper do hook da UI). */
export { useBibliotecaTheme }

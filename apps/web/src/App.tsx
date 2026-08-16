/**
 * App — composição do apps/web.
 *
 * Empilha providers: Auth (sessão) → Project (config+runtime do projeto
 * selecionado) → Tema (claro/escuro persistido). As telas custom dos
 * projetos são registradas uma única vez no boot.
 */
import { useEffect, type ReactNode } from "react"
import { BrowserRouter } from "react-router-dom"
import { AuthProvider, useAuth } from "./auth/AuthContext"
import { ProjectProvider } from "./project/ProjectContext"
import { registrarTelasCustom } from "./project/registry/customScreens"
import { ThemeSettingProvider } from "./theme/ThemeContext"
import { AppRoutes } from "./routes/AppRoutes"

function ProjectHost({ children }: { children: ReactNode }): ReactNode {
  const auth = useAuth()

  // Registra as telas custom assim que o primeiro projeto for resolvido
  // (slug é estável por sessão — o registro é idempotente).
  useEffect(() => {
    registrarTelasCustom()
  }, [])

  return (
    <ProjectProvider>
      {children}
    </ProjectProvider>
  )
}

export default function App(): ReactNode {
  return (
    <ThemeSettingProvider>
      <BrowserRouter>
        <AuthProvider>
          <ProjectHost>
            <AppRoutes />
          </ProjectHost>
        </AuthProvider>
      </BrowserRouter>
    </ThemeSettingProvider>
  )
}

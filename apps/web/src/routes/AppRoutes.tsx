/**
 * AppRoutes — rotas do apps/web (React Router v6).
 *
 * Fluxo: /login → (autenticado) → /select (quando >1 projeto) → /app
 * (sistema do projeto). Rotas protegidas com fallback para login.
 */
import type { ReactNode } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { useAuth } from "../auth/AuthContext"
import LoginScreen from "../screens/LoginScreen"
import ProjectSelectScreen from "../screens/ProjectSelectScreen"
import SystemScreen from "../screens/SystemScreen"
import { RequireAuth, RequireProject } from "./RequireAuth"

/** Raiz: autenticado + sem projeto → seleção; com projeto → sistema. */
function RootRedirect(): ReactNode {
  const { status, projeto } = useAuth()
  if (status !== "authenticated") return <Navigate to="/login" replace />
  return projeto ? <Navigate to="/app" replace /> : <Navigate to="/select" replace />
}

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      {/* Público */}
      <Route
        path="/login"
        element={
          <LoginRedirectLogic>
            <LoginScreen />
          </LoginRedirectLogic>
        }
      />

      {/* Raiz */}
      <Route path="/" element={<RootRedirect />} />

      {/* Autenticado — seleção de projeto */}
      <Route
        path="/select"
        element={
          <RequireAuth>
            <ProjectSelectScreen />
          </RequireAuth>
        }
      />

      {/* Sistema do projeto (exige projeto selecionado) */}
      <Route
        path="/app/*"
        element={
          <RequireProject>
            <SystemScreen />
          </RequireProject>
        }
      />

      {/* Fallback */}
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  )
}

/**
 * Quem já está autenticado e navega para /login é enviado para a raiz
 * (que resolve para /select ou /app).
 */
function LoginRedirectLogic({ children }: { children: ReactNode }): ReactNode {
  const { status } = useAuth()
  if (status === "authenticated") {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}

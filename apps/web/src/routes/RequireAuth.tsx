/**
 * Rotas protegidas (Etapa 9).
 *
 * `RequireAuth` redireciona usuários não autenticados para /login.
 * `RequireProject` (usado para o sistema) redireciona autenticados sem
 * projeto selecionado para a tela de seleção de projeto.
 */
import type { ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { useAuth } from "../auth/AuthContext"

export function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { status } = useAuth()
  const location = useLocation()

  if (status === "unknown") {
    // Hydratação de sessão em curso (lembrar de mim) — sem flash de login.
    return <div data-testid="auth-restoring">Restaurando sessão…</div>
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return <>{children}</>
}

export function RequireProject({ children }: { children: ReactNode }): ReactNode {
  const { status, projeto } = useAuth()

  if (status === "unknown") {
    return <div data-testid="auth-restoring">Restaurando sessão…</div>
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace />
  }

  if (!projeto) {
    return <Navigate to="/select" replace />
  }

  return <>{children}</>
}

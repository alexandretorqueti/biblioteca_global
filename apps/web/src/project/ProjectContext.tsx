/**
 * ProjectContext (Etapa 9) — config + runtime do projeto selecionado.
 *
 * Ao selecionar um projeto (via AuthContext), este contexto:
 *   - resolve a config serializável (registry/projects.ts)
 *   - valida a config com o schema Zod do shared (defesa estrutural)
 *   - monta o runtime do GeradorSistema (getDataSource via api-client,
 *     resolveIcon por mapa) e registra as telas custom.
 *
 * O dataSource usa a sessão autenticada (access token do projeto) — a UI
 * nunca fala HTTP direto; tudo passa pela api-client (regra do projeto).
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type {
  CadastroDataSource,
  CustomAction,
  EntityRecord,
  GeradorSistemaConfig,
  PaginatedResult,
} from "@biblioteca-global/shared"
import { geradorSistemaConfigSchema } from "@biblioteca-global/shared"
import type { GeradorSistemaRuntime, ExecuteAction } from "@biblioteca-global/ui"
import { createDataSource } from "@biblioteca-global/api-client"
import { getProjectConfig } from "./registry/projects"
import { useAuth } from "../auth/AuthContext"
import type { ApiClientBundle } from "../api/client"

export interface ProjectContextValue {
  /** Config validada do projeto selecionado (undefined enquanto não houver). */
  config: GeradorSistemaConfig | undefined
  /** Runtime do GeradorSistema, pronto para injetar na UI. */
  runtime: GeradorSistemaRuntime | undefined
  /** Bundle HTTP autenticado (para telas custom que precisam fazer requisições). */
  bundle: ApiClientBundle | undefined
  /** Recarrega a config do projeto (após edição do admin, ex.). */
  reload: () => void
}

export const ProjectContext = createContext<ProjectContextValue | null>(null)

// O provider obtém o slug do projeto e o bundle de API diretamente do AuthContext.
function parseConfig(candidato: unknown): GeradorSistemaConfig | undefined {
  if (!candidato) return undefined
  const resultado = geradorSistemaConfigSchema.safeParse(candidato)
  return resultado.success ? resultado.data : undefined
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const projectSlug = auth.projeto?.slug ?? null
  const bundle = auth.bundle

  const [reloadTick, setReloadTick] = useState(0)

  // Resolve a config usando o slug do projeto autenticado.
  const config = useMemo(
    () => (projectSlug ? parseConfig(getProjectConfig(projectSlug)) : undefined),
    [projectSlug, reloadTick],
  )

  // Executa uma ação customizada (iniciar tarefa, pausar, retomar, etc.)
  const executeAction = useCallback<ExecuteAction>(
    async (action: CustomAction, context?: { row?: EntityRecord }) => {
      if (!bundle || !projectSlug) throw new Error("Bundle HTTP ou projeto não disponível")
      
      // Interpola :id no path com o ID do registro
      let path = action.path
      if (context?.row?.id !== undefined) {
        path = path.replace(/:id/g, String(context.row.id))
      }
      
      // Remove prefixo /api se presente (o bundle já tem baseUrl com /api)
      if (path.startsWith("/api")) {
        path = path.substring(4)
      }
      
      // Remove prefixo /:slug se presente (vamos adicionar o slug correto)
      if (path.startsWith("/")) {
        path = path.substring(1)
      }
      
      const result = await bundle.http.request<{ message?: string }>(
        action.method,
        `/${projectSlug}/${path}`,
        { auth: "access" }
      )
      
      return {
        message: result.message || `Ação "${action.label}" executada com sucesso.`,
      }
    },
    [bundle, projectSlug]
  )

  const runtime = useMemo<GeradorSistemaRuntime | undefined>(() => {
    if (!config) return undefined
    return {
      getDataSource<T extends EntityRecord>(resource: string): CadastroDataSource<T> {
        // bundle pode ser undefined se ainda não houver auth; protegemos.
        if (!bundle || !projectSlug) return undefined as any
        return createDataSource<T>(bundle.http, projectSlug, resource)
      },
      getLoadOptions(resource: string) {
        if (!bundle || !projectSlug) return async () => []
        return async (search: string) => {
          try {
            const result = await bundle.http.request<PaginatedResult<EntityRecord>>(
              "GET",
              `/${projectSlug}/${resource}`,
              {
                query: search
                  ? { search, pageSize: 50 }
                  : { pageSize: 100 },
                auth: "access",
              },
            )
            return result.items ?? []
          } catch {
            return []
          }
        }
      },
      executeAction,
    }
  }, [config, bundle, executeAction])

  const reload = useCallback(() => setReloadTick((t) => t + 1), [])

  const value = useMemo<ProjectContextValue>(() => ({ config, runtime, bundle, reload }), [config, runtime, bundle, reload])

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) {
    throw new Error("useProject deve ser usado dentro de <ProjectProvider>.")
  }
  return ctx
}

// Re-export de conveniência: o efeito dispara o registro das telas custom
// uma única vez quando o primeiro projeto é carregado (ver main.tsx).
export { registrarTelasCustom } from "./registry/customScreens"

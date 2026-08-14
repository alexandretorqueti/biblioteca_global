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
  EntityRecord,
  GeradorSistemaConfig,
} from "@biblioteca-global/shared"
import { geradorSistemaConfigSchema } from "@biblioteca-global/shared"
import type { GeradorSistemaRuntime } from "@biblioteca-global/ui"
import { createDataSource } from "@biblioteca-global/api-client"
import type { ApiClientBundle } from "../api/client"
import { getProjectConfig } from "./registry/projects"

export interface ProjectContextValue {
  /** Config validada do projeto selecionado (undefined enquanto não houver). */
  config: GeradorSistemaConfig | undefined
  /** Runtime do GeradorSistema, pronto para injetar na UI. */
  runtime: GeradorSistemaRuntime | undefined
  /** Recarrega a config do projeto (após edição do admin, ex.). */
  reload: () => void
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export interface ProjectProviderProps {
  /** slug do projeto selecionado (de AuthContext.projeto.slug). */
  projectSlug: string | null
  bundle: ApiClientBundle
  children: ReactNode
}

function parseConfig(candidato: unknown): GeradorSistemaConfig | undefined {
  if (!candidato) return undefined
  const resultado = geradorSistemaConfigSchema.safeParse(candidato)
  return resultado.success ? resultado.data : undefined
}

export function ProjectProvider({
  projectSlug,
  bundle,
  children,
}: ProjectProviderProps) {
  const [reloadTick, setReloadTick] = useState(0)

  // Fonte: registry estático + possível reload remoto no futuro.
  // O tick força a releitura após `reload()` (nova config do admin).
  const config = useMemo(
    () =>
      projectSlug
        ? parseConfig(getProjectConfig(projectSlug))
        : undefined,
    [projectSlug, reloadTick],
  )

  const runtime = useMemo<GeradorSistemaRuntime | undefined>(() => {
    if (!config) return undefined
    return {
      // Resource → CRUD via api-client (o token do projeto define o escopo).
      getDataSource<T extends EntityRecord>(
        resource: string,
      ): CadastroDataSource<T> {
        return createDataSource<T>(bundle.http, resource)
      },
    }
  }, [config, bundle])

  const reload = useCallback(() => {
    setReloadTick((t) => t + 1)
  }, [])

  const value = useMemo<ProjectContextValue>(
    () => ({ config, runtime, reload }),
    [config, runtime, reload],
  )

  return (
    <ProjectContext.Provider value={value}>
      {children}
    </ProjectContext.Provider>
  )
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

/**
 * registry/projects.ts — autodescoberta de configs dos projetos (Etapa 9).
 *
 * A UI resolve a config do GeradorSistema a partir da config versionada em
 * `projects/<slug>/config.ts` (mesma fonte do provisionamento — PoC §7).
 *
 * Autodescoberta em build time via `import.meta.glob` do Vite: varre todos
 * os arquivos `config.ts` em `projects/<slug>/` e monta o mapa slug → config.
 * O slug é derivado do nome da pasta. Novos projetos funcionam apenas por
 * existir em `projects/<slug>/` com `config.ts` — sem edição manual deste arquivo.
 *
 * Nota arquitetural: atualmente não existe endpoint público de "GET config
 * do projeto" na API — a config vive no core (JSON) e é espelhada na pasta
 * versionada. Este mapa é a porta limpa: se um dia o back expuser a config
 * corrente (após admin editar via editor de config), basta trocar a fonte
 * por uma chamada api-client sem tocar nas telas.
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export type ProjectConfigSource = (slug: string) => GeradorSistemaConfig | undefined

interface ConfigModule {
  config: GeradorSistemaConfig
}

/**
 * Autodescoberta de configs em build time.
 *
 * `import.meta.glob` com `eager: true` importa todos os módulos no bundle
 * final (sem fetch runtime). O Vite resolve os paths em tempo de build.
 * A chave do objeto é o path relativo; extraímos o slug do nome da pasta.
 */
const configModules = import.meta.glob<ConfigModule>(
  "../../../../../projects/*/config.ts",
  { eager: true },
)

/**
 * Monta o mapa slug → config a partir dos módulos descobertos.
 *
 * O path tem o formato `../../../../../projects/<slug>/config.ts`; o slug
 * é o segmento imediatamente antes de `/config.ts`.
 */
function montarMapaConfigs(): Record<string, GeradorSistemaConfig> {
  const mapa: Record<string, GeradorSistemaConfig> = {}
  for (const [path, mod] of Object.entries(configModules)) {
    // Extrai o slug do path: ".../projects/<slug>/config.ts"
    const match = path.match(/\/projects\/([^/]+)\/config\.ts$/)
    if (!match) {
      console.warn(`[registry/projects] path inesperado: ${path}`)
      continue
    }
    const slug = match[1]
    if (!slug) {
      console.warn(`[registry/projects] não foi possível extrair slug de: ${path}`)
      continue
    }
    if (!mod?.config) {
      console.warn(`[registry/projects] config.ts de "${slug}" não exporta "config"`)
      continue
    }
    mapa[slug] = mod.config
  }
  return mapa
}

export const projectConfigs: Record<string, GeradorSistemaConfig> = montarMapaConfigs()

/** Resolve a config de um projeto pelo slug; undefined se não conhecido. */
export function getProjectConfig(slug: string): GeradorSistemaConfig | undefined {
  return projectConfigs[slug]
}

/** Fonte trocável (curto-circuito para testes/injeção). */
export const sourceProjetoConfig: ProjectConfigSource = getProjectConfig

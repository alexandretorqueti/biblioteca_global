/**
 * registry/projects.ts — configurações versionadas dos projetos (Etapa 9).
 *
 * A UI resolve a config do GeradorSistema a partir da config versionada em
 * `projects/<slug>/config.ts` (mesma fonte do provisionamento — PoC §7).
 * O objeto `projectConfigs` é o mapa slug → config; novas telas custom do
 * projeto são registradas em `registerCustomScreens` (registry da UI).
 *
 * Nota arquitetural: atualmente não existe endpoint público de "GET config
 * do projeto" na API — a config vive no core (JSON) e é espelhada na pasta
 * versionada. Este mapa é a porta limpa: se um dia o back expuser a config
 * corrente (após admin editar via editor de config), basta trocar a fonte
 * por uma chamada api-client sem tocar nas telas.
 */
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"
import { config as bibliotecaGlobalConfig } from "../../../../../projects/biblioteca-global/config"
import { config as documentacaoConfig } from "../../../../../projects/documentacao/config"

export type ProjectConfigSource = (slug: string) => GeradorSistemaConfig | undefined

export const projectConfigs: Record<string, GeradorSistemaConfig> = {
  "biblioteca-global": bibliotecaGlobalConfig,
  documentacao: documentacaoConfig,
}

/** Resolve a config de um projeto pelo slug; undefined se não conhecido. */
export function getProjectConfig(slug: string): GeradorSistemaConfig | undefined {
  return projectConfigs[slug]
}

/** Fonte trocável (curto-circuito para testes/injeção). */
export const sourceProjetoConfig: ProjectConfigSource = getProjectConfig

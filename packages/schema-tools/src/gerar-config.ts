/**
 * Gerador da config JSON do GeradorSistema a partir do schema (PoC §7.2):
 * telas cadastro por tabela + fields gerados. A config base versionada vive
 * em projects/<slug>/config.ts; o gerador acrescenta as telas das tabelas de
 * negócio ainda não referenciadas.
 */
import { is, Table } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type {
  GeradorSistemaConfig,
  GeradorSistemaRoute,
} from "@biblioteca-global/shared"
import {
  humanizarNome,
  type FormAnnotationsPorTabela,
} from "./form"
import { gerarFields } from "./gerar-fields"

/** Extrai as tabelas Drizzle exportadas por um módulo de schema. */
export function coletarTabelas(
  modulo: Record<string, unknown>,
): Record<string, MySqlTable> {
  const tabelas: Record<string, MySqlTable> = {}
  for (const [nome, valor] of Object.entries(modulo)) {
    if (valor instanceof Object && is(valor, Table)) {
      tabelas[nome] = valor as unknown as MySqlTable
    }
  }
  return tabelas
}

/** Extrai o mapa `annotations` exportado por um módulo de schema. */
export function coletarAnnotations(
  modulo: Record<string, unknown>,
): FormAnnotationsPorTabela {
  const bruto = modulo.annotations
  if (
    bruto &&
    typeof bruto === "object" &&
    !Array.isArray(bruto) &&
    !(bruto instanceof Date)
  ) {
    return bruto as FormAnnotationsPorTabela
  }
  return {}
}

/** Tela cadastro gerada para uma tabela do projeto. */
export function telaCadastroDaTabela(
  nomeTabela: string,
  tabela: MySqlTable,
  anotacoes: Record<string, import("./form").FormAnnotation> = {},
): GeradorSistemaRoute {
  const label = humanizarNome(nomeTabela)
  return {
    id: nomeTabela,
    label,
    path: nomeTabela,
    icon: "table_chart",
    screen: {
      kind: "cadastro",
      resource: nomeTabela,
      title: label,
      fields: gerarFields(tabela, nomeTabela, anotacoes),
    },
  }
}

/**
 * Config inicial do projeto: base versionada (config.ts) + telas geradas
 * das tabelas do schema que a base ainda não referencia.
 */
export function montarConfigInicial(
  base: GeradorSistemaConfig,
  tabelas: Record<string, MySqlTable>,
  annotations: FormAnnotationsPorTabela = {},
): GeradorSistemaConfig {
  const referenciados = new Set<string>()
  for (const grupo of base.groups) {
    for (const item of grupo.items) {
      if (item.screen.kind === "cadastro") {
        referenciados.add(item.screen.resource)
      }
    }
  }

  const telasGeradas = Object.entries(tabelas)
    .filter(([nome]) => !referenciados.has(nome))
    .map(([nome, tabela]) =>
      telaCadastroDaTabela(nome, tabela, annotations[nome] ?? {}),
    )

  if (telasGeradas.length === 0) {
    return base
  }

  return {
    ...base,
    groups: [
      ...base.groups,
      { id: "cadastros", label: "Cadastros", items: telasGeradas },
    ],
  }
}

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

/** Símbolo interno do drizzle que guarda o nome REAL da tabela (mysqlTable("nome")). */
const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name")

/** Nome real da tabela no banco (snake_case do mysqlTable), não o da variável exportada. */
function nomeDaTabela(tabela: MySqlTable): string {
  const nome = (tabela as unknown as Record<symbol, string>)[DRIZZLE_TABLE_NAME]
  if (!nome) {
    throw new Error(`tabela drizzle sem nome real (${DRIZZLE_TABLE_NAME.toString()})`)
  }
  return nome
}

/**
 * Extrai as tabelas Drizzle exportadas por um módulo de schema, indexadas
 * pelo nome REAL da tabela (mysqlTable("nome_tabela")).
 *
 * O nome da variável exportada pode divergir do nome da tabela
 * (ex.: `projetosCaptados` vs `projetos_captados`); resources, annotations e
 * o validar-config usam o snake_case do banco, então a chave precisa ser a
 * mesma.
 */
export function coletarTabelas(
  modulo: Record<string, unknown>,
): Record<string, MySqlTable> {
  const tabelas: Record<string, MySqlTable> = {}
  for (const valor of Object.values(modulo)) {
    if (valor instanceof Object && is(valor, Table)) {
      const tabela = valor as unknown as MySqlTable
      tabelas[nomeDaTabela(tabela)] = tabela
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
  tabelas?: Record<string, MySqlTable>,
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
      fields: gerarFields(tabela, nomeTabela, anotacoes, tabelas),
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
      telaCadastroDaTabela(nome, tabela, annotations[nome] ?? {}, tabelas),
    )

  // PoC §8: todo projeto recebe a tela sistêmica de usuários. Ela usa o
  // módulo /api/usuarios (core + pivot), portanto não pertence ao schema de
  // negócio do projeto e precisa ser injetada explicitamente.
  if (!referenciados.has("usuarios")) {
    telasGeradas.unshift({
      id: "usuarios",
      label: "Usuários",
      path: "usuarios",
      icon: "people",
      screen: {
        kind: "cadastro",
        resource: "usuarios",
        title: "Usuários",
        description: "Usuários vinculados ao projeto atual",
        fields: [
          { name: "nome", label: "Nome", type: "text", required: true, fullWidth: true },
          { name: "username", label: "Usuário", type: "text" },
          { name: "email", label: "E-mail", type: "email" },
          { name: "telefone", label: "Telefone", type: "text" },
          { name: "cpf", label: "CPF", type: "text" },
          { name: "senhaInicial", label: "Senha inicial", type: "text", required: true },
          {
            name: "perfil",
            label: "Perfil",
            type: "select",
            options: [
              { label: "Administrador", value: "admin" },
              { label: "Gerente", value: "gerente" },
              { label: "Operador", value: "operador" },
              { label: "Visualizador", value: "visualizador" },
            ],
          },
        ],
        overrides: {
          columns: 2,
          hiddenColumns: ["passwordHash", "createdAt", "updatedAt"],
          newLabel: "Novo usuário",
        },
      },
    })
  }

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

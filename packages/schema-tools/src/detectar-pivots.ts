/**
 * Detecção de tabelas pivot N:N (subtarefa config — macro gestao-de-tarefas).
 *
 * Convenção: tabela cujo conjunto de colunas é exatamente { id PK
 * autoincrement, fkA, fkB } — duas FKs para tabelas DIFERENTES do projeto —
 * é um pivot puro. Cada lado ganha um campo VIRTUAL no CRUD genérico com o
 * nome do resource do outro lado (ex.: pivot tarefa_tags → em "tarefas" o
 * campo virtual "tags"; em "tags" o campo virtual "tarefas"). O CrudService
 * sincroniza o pivot ao criar/atualizar e anexa os ids ao listar/detalhar;
 * a config declara o campo como multipleChoice multiple (pivot sem tela).
 *
 * Regras conservadoras (evitam mudar comportamento de projetos existentes):
 * - colunas de auditoria (createdAt/updatedAt/timestamps) desqualificam;
 * - FKs para a MESMA tabela (auto-referência, ex.: tarefa_dependencias do
 *   Motor) são excluídas — o campo virtual colidiria com o próprio resource;
 * - a tabela referenciada precisa existir no mapa de tabelas do projeto.
 */
import { getTableColumns, type Column } from "drizzle-orm"
import { getTableConfig, type MySqlTable } from "drizzle-orm/mysql-core"

/** Símbolo interno do drizzle que guarda o nome REAL da tabela. */
const DRIZZLE_TABLE_NAME = Symbol.for("drizzle:Name")

function nomeReal(tabela: MySqlTable): string | undefined {
  return (tabela as unknown as Record<symbol, string>)[DRIZZLE_TABLE_NAME]
}

/** Um lado do pivot: FK local + resource referenciado. */
export interface PivotLado {
  /** Resource (nome real da tabela) referenciada por esta FK. */
  resource: string
  /** Propriedade TS da coluna FK na tabela pivot (ex.: "tarefaId"). */
  fkProp: string
  /** Nome real da coluna FK na tabela pivot (ex.: "tarefa_id"). */
  fkColuna: string
  /** Tabela referenciada. */
  tabela: MySqlTable
}

/** Pivot detectado com os dois lados. */
export interface PivotDetectado {
  /** Nome real da tabela pivot (ex.: "tarefa_tags"). */
  pivot: string
  /** Tabela pivot. */
  tabelaPivot: MySqlTable
  lados: [PivotLado, PivotLado]
}

/** Campo virtual exposto no CRUD de um resource pai. */
export interface CampoPivot {
  /** Nome do campo virtual (= resource do outro lado, ex.: "tags"). */
  campo: string
  /** Nome real da tabela pivot. */
  pivot: string
  /** Tabela pivot. */
  tabelaPivot: MySqlTable
  /** Propriedade TS da FK do pai no pivot. */
  fkPaiProp: string
  /** Propriedade TS da FK do outro lado no pivot. */
  fkOpostoProp: string
  /** Resource do outro lado (alvo dos ids). */
  resourceOposto: string
  /** Tabela do outro lado. */
  tabelaOposta: MySqlTable
}

function ehPkAutoincrement(coluna: Column): boolean {
  const meta = coluna as unknown as { primary?: boolean; autoIncrement?: boolean }
  return Boolean(meta.primary && meta.autoIncrement)
}

/**
 * Detecta os pivots puros de um projeto. `tabelas` = mapa
 * nome-real → MySqlTable (saída de coletarTabelas).
 */
export function detectarPivots(
  tabelas: Record<string, MySqlTable>,
): PivotDetectado[] {
  const porNomeReal = new Map<string, MySqlTable>()
  for (const [nome, tabela] of Object.entries(tabelas)) {
    porNomeReal.set(nomeReal(tabela) ?? nome, tabela)
  }

  const pivots: PivotDetectado[] = []
  for (const [nome, tabela] of porNomeReal) {
    const colunas = Object.entries(getTableColumns(tabela))
    if (colunas.length !== 3) continue
    const [pk, ...restante] = colunas as [
      [string, Column],
      [string, Column],
      [string, Column],
    ]
    if (!pk || !ehPkAutoincrement(pk[1])) continue

    const config = getTableConfig(tabela)
    const fks = config.foreignKeys ?? []
    const lados: PivotLado[] = []
    for (const [prop, coluna] of restante) {
      const fk = fks.find((f) =>
        f.reference().columns.some((c) => c.name === coluna.name),
      )
      if (!fk) break
      const ref = fk.reference()
      const tabelaDestino = ref.foreignTable as MySqlTable | undefined
      const nomeDestino = tabelaDestino ? nomeReal(tabelaDestino) : undefined
      if (!tabelaDestino || !nomeDestino) break
      lados.push({ resource: nomeDestino, fkProp: prop, fkColuna: coluna.name, tabela: tabelaDestino })
    }
    if (lados.length !== 2) continue
    // Auto-referência excluída (ex.: tarefa_dependencias do Motor).
    if (lados[0].resource === lados[1].resource) continue
    // Ambos os lados precisam existir no projeto.
    if (!porNomeReal.has(lados[0].resource) || !porNomeReal.has(lados[1].resource)) continue
    pivots.push({
      pivot: nome,
      tabelaPivot: tabela,
      lados: [lados[0], lados[1]] as [PivotLado, PivotLado],
    })
  }
  return pivots
}

/**
 * Campos virtuais de pivot expostos no CRUD do resource informado
 * (lista vazia quando o resource não participa de nenhum pivot puro).
 */
export function camposPivotDoResource(
  tabelas: Record<string, MySqlTable>,
  resource: string,
): CampoPivot[] {
  const campos: CampoPivot[] = []
  for (const pivot of detectarPivots(tabelas)) {
    for (const lado of pivot.lados) {
      if (lado.resource !== resource) continue
      const oposto = pivot.lados.find((l) => l !== lado)
      if (!oposto) continue
      campos.push({
        campo: oposto.resource,
        pivot: pivot.pivot,
        tabelaPivot: pivot.tabelaPivot,
        fkPaiProp: lado.fkProp,
        fkOpostoProp: oposto.fkProp,
        resourceOposto: oposto.resource,
        tabelaOposta: oposto.tabela,
      })
    }
  }
  return campos
}

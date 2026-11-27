/**
 * Extensão de escopo do CRUD genérico para o projeto
 * `vitrine-ia-loja-de-atendentes-virtuais` (macro #10, subtarefa 3).
 *
 * Diferente do gestao-de-tarefas-global, a Vitrine NÃO tem tenancy
 * organizacional intra-projeto — o guard de escopo não injeta
 * `req.escopoOrganizacao` para este slug e `condicaoLeitura` fica livre.
 * As regras desta extensão são de CAMPO, independentes de perfil:
 *
 * - `credenciaisCifradas` de `integracoes_externas` é WRITE-ONLY
 *   (REQ-F-008/025): aceita gravação no create/update, mas a chave é
 *   removida de TODA resposta serializada (listar/detalhar — e, por
 *   consequência, de criar/atualizar, que releem via detalhar, e do evento
 *   realtime publicado). `hiddenColumns` do config é conveniência do front;
 *   a barreira de verdade é aqui, no backend.
 * - Campos de fluxo são INGRAVÁVEIS pelo CRUD (REQ-F-005/006/007): corpo com
 *   a chave (create OU update) → 400 claro, antes do Zod e antes de abrir
 *   conexão. As transições pertencem ao backend (pagamento →
 *   provisionamento → pareamento) nas tarefas futuras do plano; o painel só
 *   lê. Mesma regra de `status` do gestao-de-tarefas-global (REQ-F-019),
 *   generalizada por tabela. Campos vetados:
 *     · pedidos: status, pagamento_id, link_agente, script_embed
 *     · documentos: caminho_armazenamento, texto_extraido
 *     · agentes_provisionados: openclaw_agente_id, status, personalidade,
 *       link_acesso, script_embed, tentativas, ultimo_erro
 *     · configuracoes_whatsapp: status_pareamento, ultimo_qr_gerado_em
 * - RBAC de perfil é a regra nativa da plataforma (visualizador só lê):
 *   criação exige admin/gerente/operador no CrudService
 *   (PERFIS_PODEM_CRIAR) e PUT/DELETE têm @Roles no CrudController. A
 *   extensão NÃO libera perfis adicionais (sem `perfilPodeCriar`) — nada é
 *   alterado na plataforma; o aceite é provado por teste.
 *
 * Registrada em crud.module no token CRUD_ESCOPO_EXTENSIONS — o CrudService
 * só a consulta quando o slug da sessão é
 * `vitrine-ia-loja-de-atendentes-virtuais`; os demais projetos (incluindo o
 * gestao-de-tarefas-global) permanecem intocados.
 */
import { BadRequestException } from "@nestjs/common"
import { getTableColumns, getTableName, type Column, type SQL } from "drizzle-orm"
import type { MySqlTable } from "drizzle-orm/mysql-core"
import type { CampoPivot } from "@biblioteca-global/schema-tools"
import * as schemaVitrine from "../../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import type { ProjetoDb } from "../project-db.factory"
import type {
  ContextoEscopoCrud,
  ExtensaoEscopoCrud,
  OperacaoEscopoCrud,
} from "./escopo-crud.extension"

/** Slug do projeto atendido por esta extensão. */
export const SLUG_VITRINE_IA = "vitrine-ia-loja-de-atendentes-virtuais"

/**
 * Colunas de fluxo por tabela (nomes de COLUNA = snake_case, contrato do
 * corpo pré-Zod após `normalizarChaves`). Presença da chave no corpo —
 * create ou update — é recusada, qualquer que seja o valor: o painel nunca
 * move a máquina de estados (mesma semântica de `status` no
 * gestao-de-tarefas-global).
 */
export const CAMPOS_DE_FLUXO_POR_TABELA: Readonly<Record<string, readonly string[]>> = {
  [getTableName(schemaVitrine.pedidos)]: [
    "status",
    "pagamento_id",
    "link_agente",
    "script_embed",
  ],
  [getTableName(schemaVitrine.documentos)]: [
    "caminho_armazenamento",
    "texto_extraido",
  ],
  [getTableName(schemaVitrine.agentesProvisionados)]: [
    "openclaw_agente_id",
    "status",
    "personalidade",
    "link_acesso",
    "script_embed",
    "tentativas",
    "ultimo_erro",
  ],
  [getTableName(schemaVitrine.configuracoesWhatsapp)]: [
    "status_pareamento",
    "ultimo_qr_gerado_em",
  ],
}

/**
 * Propriedades Drizzle (chaves da linha serializada) write-only por tabela:
 * aceitas na escrita, removidas de toda resposta de leitura para QUALQUER
 * perfil.
 */
export const CAMPOS_WRITE_ONLY_POR_TABELA: Readonly<Record<string, readonly string[]>> = {
  [getTableName(schemaVitrine.integracoesExternas)]: ["credenciaisCifradas"],
}

function colunas(tabela: MySqlTable): Record<string, Column> {
  return getTableColumns(tabela) as Record<string, Column>
}

/**
 * Garantias server-side do CRUD genérico da Vitrine IA.
 * Sem estado e sem DI: instanciada diretamente no crud.module.
 */
export class VitrineIaEscopo implements ExtensaoEscopoCrud {
  readonly slug = SLUG_VITRINE_IA

  /**
   * A Vitrine não resolve tenancy organizacional: `escopoOrganizacao` chega
   * indefinido e nenhuma regra desta extensão depende de perfil de
   * colaborador (barreiras de campo valem para todos; o RBAC de escrita é a
   * regra nativa da plataforma, avaliada no CrudService/CrudController).
   * O contexto devolvido é neutro — os hooks abaixo não o consultam.
   */
  contextoDaSessao(escopoOrganizacao: unknown): ContextoEscopoCrud {
    void escopoOrganizacao
    return { organizacaoId: 0, colaboradorId: 0, perfil: "sessao" }
  }

  /** Sem restrição row-level (projeto single-tenant). */
  condicaoLeitura(
    resource: string,
    tabela: MySqlTable,
    ctx: ContextoEscopoCrud,
  ): SQL | undefined {
    void resource
    void tabela
    void ctx
    return undefined
  }

  /**
   * Barreira de ESCRITA dos campos de fluxo (antes do Zod, chaves = nome de
   * coluna): create/update com a chave no corpo → 400 claro nomeando o
   * campo. Ausência da chave = escrita normal (update parcial intacto).
   */
  prepararCorpo(
    tabela: MySqlTable,
    corpo: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): void {
    void ctx
    const vetados = CAMPOS_DE_FLUXO_POR_TABELA[getTableName(tabela)]
    if (!vetados) return
    const nomes = new Set(
      Object.values(colunas(tabela)).map((coluna) => coluna.name),
    )
    const enviados = vetados.filter((campo) => nomes.has(campo) && campo in corpo)
    if (enviados.length === 0) return
    throw new BadRequestException(
      `Os campos (${enviados.join(", ")}) de "${getTableName(tabela)}" são de fluxo ` +
        `e não podem ser ${operacao === "create" ? "cadastrados" : "alterados"} pelo CRUD — ` +
        `as transições pertencem ao backend (pagamento/provisionamento/pareamento). ` +
        `Envie o registro sem esses campos.`,
    )
  }

  /** Sem regras de FK por escopo (projeto single-tenant). */
  async validarEscrita(
    db: ProjetoDb,
    tabela: MySqlTable,
    valores: Record<string, unknown>,
    ctx: ContextoEscopoCrud,
    operacao: "create" | "update",
  ): Promise<void> {
    void db
    void tabela
    void valores
    void ctx
    void operacao
  }

  /** Nenhuma operação vetada por resource — RBAC segue a regra nativa. */
  operacaoBloqueada(
    resource: string,
    operacao: OperacaoEscopoCrud,
  ): string | undefined {
    void resource
    void operacao
    return undefined
  }

  /** Sem N:N neste projeto; sem lado oposto para escopar. */
  condicaoPivotOposto(
    campo: CampoPivot,
    ctx: ContextoEscopoCrud,
  ): SQL | undefined {
    void campo
    void ctx
    return undefined
  }

  /**
   * Barreira de LEITURA (write-only): `credenciaisCifradas` sai da linha
   * serializada em listar/detalhar — e, por consequência, nas respostas de
   * criar/atualizar e no evento realtime — para QUALQUER perfil. A escrita
   * do campo segue aceita (a gravação é validada em `prepararCorpo`, que
   * NÃO veta credenciais).
   */
  camposSensiveisNaLeitura(
    resource: string,
    tabela: MySqlTable,
    ctx: ContextoEscopoCrud,
  ): string[] {
    void resource
    void ctx
    const writeOnly = CAMPOS_WRITE_ONLY_POR_TABELA[getTableName(tabela)]
    if (!writeOnly) return []
    const props = new Set(Object.keys(colunas(tabela)))
    return writeOnly.filter((prop) => props.has(prop))
  }
}

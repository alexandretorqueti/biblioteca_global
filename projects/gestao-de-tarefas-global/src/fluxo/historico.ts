/**
 * Tipos e trilha de eventos de histórico da tarefa (ciclo de vida —
 * delegação em cadeia, devolução em 3 estados, histórico e chat).
 *
 * Módulo puro de domínio: sem Nest, sem Drizzle, sem I/O — mesmo padrão
 * dos resolvers de tenancy (`src/tenancy/resolvers.ts`). `historico.ts`
 * define os contratos (estados, ações, efeitos, eventos) e a trilha
 * append-only; `maquina-estados.ts` implementa as transições.
 *
 * Trilha de `historico_tarefas` (schema.ts):
 * - APPEND-ONLY por construção: registrarEvento só ADICIONA; não existe
 *   função de editar/excluir registro (a config do CRUD mantém a grid
 *   somente leitura — sem create/edit/delete);
 * - ordenação cronológica determinística: `(criadoEm, id)` — `id` quebra
 *   empate de registros com o mesmo instante (insert autoincrement);
 * - o chamador é quem insere o evento retornado por `transicionar` no
 *   banco (um evento por transição, atômico com a atualização da tarefa).
 */
import type { StatusTarefa } from "./maquina-estados"

/**
 * Estados do ciclo de vida (reexport — espelha `tarefas.status` de
 * schema.ts; a canônica `STATUS_TAREFA` mora em maquina-estados.ts para
 * evitar ciclo de imports de valores).
 */
export type { StatusTarefa }

/** Ações do fluxo custom (endpoints delegar/devolver/concluir/cancelar). */
export type AcaoFluxo =
  | "delegar"
  | "cancelar"
  | "devolver_concluida"
  | "devolver_precisa_informacoes"
  | "devolver_aguardando_terceiro"

/** Sabores da devolução (3 estados pós-delegação). */
export type FlavDevolucao = "concluida" | "precisa_informacoes" | "aguardando_terceiro"

/**
 * TipoEvento de `historico_tarefas` produzido pelas transições do fluxo.
 * (O enum completo da tabela tem mais eventos — `criacao`, `mudanca_prazo`
 * etc. — produzidos por outros fluxos.)
 */
export type TipoEventoFluxo =
  | "delegacao"
  | "devolucao_concluida"
  | "devolucao_precisa_info"
  | "devolucao_aguardando_terceiro"
  | "reatribuicao"
  | "mudanca_status"

/** Eventos de delegação/reatribuição (1ª delegação vs. cadeia). */
export type TipoEventoDelegacao = "delegacao" | "reatribuicao"
/** Eventos de devolução (1 por sabor). */
export type TipoEventoDevolucao =
  | "devolucao_concluida"
  | "devolucao_precisa_info"
  | "devolucao_aguardando_terceiro"

/** Linha mínima de `tarefas` consumida pela máquina de estados. */
export interface TarefaFluxo {
  id: number
  organizacaoId: number
  /** Responsável único ativo da tarefa. */
  responsavelId: number
  status: StatusTarefa
}

/** Colaborador-alvo da delegação (validação: ativo + mesma organização). */
export interface ColaboradorDestino {
  id: number
  organizacaoId: number
  ativo: boolean
}

/**
 * Efeito da transição em `tarefas` — o chamador aplica:
 * - `delegar`: `responsavelId` = efeito.responsavelId e `status` = efeito.status;
 * - `devolver_concluida`: `status` + `concluidaEm` (único sabor que preenche);
 * - demais: apenas `status`.
 * `agora` é o instante canônico da transição (mesmo valor usado no evento).
 */
export interface EfeitoTransicao {
  status: StatusTarefa
  responsavelId: number
  /** Preenchido apenas na devolução sabor concluída; null = não tocar. */
  concluidaEm: string | Date | null
  agora: string | Date
}

/** Evento de `historico_tarefas` derivado da transição (insert do chamador). */
export interface EventoHistorico {
  tipoEvento: TipoEventoFluxo
  deColaboradorId: number | null
  paraColaboradorId: number | null
  mensagem: string | null
}

/**
 * Registro de `historico_tarefas` como persistido (linha da tabela).
 * Append-only: nenhum campo é mutável após o insert.
 */
export interface RegistroHistorico extends EventoHistorico {
  id: number
  tarefaId: number
  criadoEm: string | Date
}

/** Resultado de `transicionar`: efeito + evento, ou erro de domínio. */
export type TransicaoResultado =
  | { ok: true; efeito: EfeitoTransicao; evento: EventoHistorico }
  | { ok: false; erro: ErroTransicaoInvalida }

/**
 * Erro de domínio de transição inválida / pré-condição violada.
 * A mensagem cita SEMPRE o status atual e a ação (requisito de aceite).
 */
export interface ErroTransicaoInvalida {
  /** Mensagem clara: "status atual + ação" + motivo. */
  motivo: string
  statusAtual: StatusTarefa
  acao: AcaoFluxo
}

// ============================================================================
// Trilha append-only
// ============================================================================

/**
 * Adiciona um evento à trilha — a ÚNICA forma de mutação. Sem edição nem
 * exclusão: registros anteriores nunca mudam (append-only).
 *
 * `novoId` é fornecido pelo chamador (autoincrement do banco) para
 * manter a ordenação cronológica determinística; `agora` deve ser o
 * mesmo instante do efeito da transição.
 */
export function registrarEvento(
  trilha: readonly RegistroHistorico[],
  evento: EventoHistorico,
  opts: { tarefaId: number; novoId: number; agora: string | Date },
): RegistroHistorico[] {
  return [
    ...trilha,
    { ...evento, id: opts.novoId, tarefaId: opts.tarefaId, criadoEm: opts.agora },
  ]
}

function ordenavel(criadoEm: string | Date): number {
  return criadoEm instanceof Date ? criadoEm.getTime() : new Date(criadoEm).getTime()
}

/**
 * Histórico cronológico (antigo → novo): ordena por `(criadoEm, id)` —
 * `id` (autoincrement) é a chave de desempate de instantes iguais, então a
 * trilha é determinística e preserva a ordem real de append.
 */
export function historicoCronologico(
  registros: readonly RegistroHistorico[],
): readonly RegistroHistorico[] {
  return [...registros].sort(
    (a, b) => ordenavel(a.criadoEm) - ordenavel(b.criadoEm) || a.id - b.id,
  )
}

/**
 * Eventos de uma tarefa na trilha (filtro para a tela de histórico da
 * tarefa — `tarefaId` é o escopo natural: organização é derivada da
 * tarefa e o isolamento row-level é dos endpoints de listagem).
 */
export function eventosDaTarefa(
  registros: readonly RegistroHistorico[],
  tarefaId: number,
): readonly RegistroHistorico[] {
  return historicoCronologico(registros.filter((r) => r.tarefaId === tarefaId))
}

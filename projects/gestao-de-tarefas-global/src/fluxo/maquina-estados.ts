/**
 * Máquina de estados da tarefa (ciclo de vida — delegação em cadeia,
 * devolução em 3 estados, histórico e chat).
 *
 * Módulo puro de domínio: sem Nest, sem Drizzle, sem I/O — mesmo padrão
 * dos resolvers de tenancy (`src/tenancy/resolvers.ts`). Os endpoints
 * custom de fluxo recebem a linha de `tarefas` + o colaborador de destino,
 * chamam `transicionar` e aplicam o efeito retornado + o registro de
 * histórico no banco.
 *
 * Estados (enum `status` de schema.ts — sem migration nova):
 * aberta → delegada → concluida | precisa_informacoes | aguardando_terceiro
 *          (devolução nos 3 sabores, sempre com mensagem)
 * aberta / delegada / precisa_informacoes / aguardando_terceiro → cancelada
 * delegada / precisa_informacoes / aguardando_terceiro → delegada
 *          (re-delegação em cadeia)
 * `concluida` e `cancelada` são TERMINAIS: sem transição de saída.
 *
 * Regras de pré-condição (erro de domínio claro — status atual + ação):
 * - devolução (os 3 sabores) exige `mensagem` não vazia;
 * - delegar exige responsável-alvo ≠ responsável atual, ativo e da mesma
 *   organização da tarefa;
 * - responsável único: toda transição valida exatamente um responsável.
 */
import type {
  AcaoFluxo,
  ColaboradorDestino,
  ErroTransicaoInvalida,
  FlavDevolucao,
  TarefaFluxo,
  TipoEventoDelegacao,
  TipoEventoDevolucao,
  TransicaoResultado,
} from "./historico"

/** Estados do ciclo de vida — espelha `tarefas.status` de schema.ts. */
export const STATUS_TAREFA = [
  "aberta",
  "delegada",
  "concluida",
  "precisa_informacoes",
  "aguardando_terceiro",
  "cancelada",
] as const
export type StatusTarefa = (typeof STATUS_TAREFA)[number]

/** Estados terminais: sem transição de saída. */
export const STATUS_TERMINAIS: readonly StatusTarefa[] = ["concluida", "cancelada"]

/** Sabor da devolução → tipoEvento de `historico_tarefas` (1:1). */
export const FLAV_DEVOLUCAO_TIPO_EVENTO: Record<
  FlavDevolucao,
  TipoEventoDevolucao
> = {
  concluida: "devolucao_concluida",
  precisa_informacoes: "devolucao_precisa_info",
  aguardando_terceiro: "devolucao_aguardando_terceiro",
}

/** Sabor da devolução → novo status de `tarefas`. */
export const FLAV_DEVOLUCAO_STATUS: Record<FlavDevolucao, StatusTarefa> = {
  concluida: "concluida",
  precisa_informacoes: "precisa_informacoes",
  aguardando_terceiro: "aguardando_terceiro",
}

/** Ações aceitas por estado (tabela canônica da máquina). */
const TRANSICOES_VALIDAS: Record<StatusTarefa, readonly AcaoFluxo[]> = {
  aberta: ["delegar", "cancelar"],
  delegada: ["delegar", "cancelar", "devolver_concluida", "devolver_precisa_informacoes", "devolver_aguardando_terceiro"],
  precisa_informacoes: ["delegar", "cancelar", "devolver_concluida", "devolver_precisa_informacoes", "devolver_aguardando_terceiro"],
  aguardando_terceiro: ["delegar", "cancelar", "devolver_concluida", "devolver_precisa_informacoes", "devolver_aguardando_terceiro"],
  concluida: [],
  cancelada: [],
}

/** Ações de devolução — todas exigem mensagem não vazia. */
const ACOES_DEVOLUCAO: ReadonlySet<AcaoFluxo> = new Set<AcaoFluxo>([
  "devolver_concluida",
  "devolver_precisa_informacoes",
  "devolver_aguardando_terceiro",
])

/** Ações de devolução → sabor (para mapear tipoEvento/status). */
const DEVOLUCAO_SABOR: Record<
  "devolver_concluida" | "devolver_precisa_informacoes" | "devolver_aguardando_terceiro",
  FlavDevolucao
> = {
  devolver_concluida: "concluida",
  devolver_precisa_informacoes: "precisa_informacoes",
  devolver_aguardando_terceiro: "aguardando_terceiro",
}

/**
 * Valida o responsável-alvo da delegação.
 *
 * Pré-condições (toda violação = erro de domínio com status atual + ação):
 * - ≠ responsável atual (delegar para o mesmo não é transição);
 * - ativo (`colaboradores.ativo = true`);
 * - mesma organização da tarefa (isolamento inegociável).
 */
export function validarResponsavelAlvo(
  tarefa: TarefaFluxo,
  alvo: ColaboradorDestino,
  acao: "delegar",
): { ok: true } | { ok: false; erro: ErroTransicaoInvalida } {
  const erro = (motivo: string): { ok: false; erro: ErroTransicaoInvalida } => ({
    ok: false,
    erro: { motivo, statusAtual: tarefa.status, acao },
  })

  if (alvo.id === tarefa.responsavelId) {
    return erro(
      "A delegação precisa ser feita a um colaborador diferente do responsável atual.",
    )
  }
  if (!alvo.ativo) {
    return erro("A delegação precisa ser feita a um colaborador ativo.")
  }
  if (alvo.organizacaoId !== tarefa.organizacaoId) {
    return erro(
      "A delegação precisa ser feita a um colaborador da mesma organização da tarefa.",
    )
  }
  return { ok: true }
}

/**
 * Aplica a ação ao estado atual da tarefa e devolve o resultado —
 * efeito de transição (novo status/responsável/concluidaEm + evento de
 * histórico com de/para) OU erro de domínio claro.
 *
 * Sem escrita: o chamador aplica o `efeito` na tarefa e insere o registro
 * de `historico_tarefas` derivado do `evento`.
 *
 * Mapeamento de tipoEvento (`historico_tarefas`):
 * - delegar: `delegacao` na 1ª (a partir de `aberta`); `reatribuicao` em
 *   cadeia (a partir de `delegada`/`precisa_informacoes`/`aguardando_terceiro`);
 *   de/responsável atual, para/responsável-alvo;
 * - devolver_*: `devolucao_concluida` / `devolucao_precisa_info` /
 *   `devolucao_aguardando_terceiro`; de/responsável atual, para/null;
 * - cancelar: `mudanca_status` (de→para `cancelada`).
 *
 * Efeitos em `tarefas`:
 * - delegar: `responsavelId` = alvo e `status` = `delegada`;
 * - devolver_concluida: `status` = `concluida` e `concluidaEm` = agora
 *   (única transição que preenche `concluidaEm`);
 * - demais sabores: apenas `status`.
 */
export function transicionar(input: {
  tarefa: TarefaFluxo
  acao: AcaoFluxo
  /** Obrigatório em `delegar` (responsável único de destino). */
  responsavelAlvo?: ColaboradorDestino
  /** Obrigatório e não vazia em toda devolução. */
  mensagem?: string
  /** Instante da transição — para `concluidaEm` e ordenação do histórico. */
  agora: string | Date
}): TransicaoResultado {
  const { tarefa, acao, responsavelAlvo, mensagem, agora } = input

  const invalida = (motivo: string): {
    ok: false
    erro: ErroTransicaoInvalida
  } => ({ ok: false, erro: { motivo, statusAtual: tarefa.status, acao } })

  const acoesPermitidas = TRANSICOES_VALIDAS[tarefa.status]
  if (!acoesPermitidas.includes(acao)) {
    if (acoesPermitidas.length === 0) {
      return invalida(
        `A tarefa está no estado terminal '${tarefa.status}' e não aceita a ação '${acao}'.`,
      )
    }
    return invalida(
      `Transição inválida: a tarefa está no estado '${tarefa.status}' e a ação '${acao}' não é permitida. Ações permitidas: ${acoesPermitidas.join(", ")}.`,
    )
  }

  // Pré-condições da ação (independentes da aresta).
  if (ACOES_DEVOLUCAO.has(acao) && (mensagem ?? "").trim() === "") {
    return invalida(
      "A devolução exige uma mensagem não vazia descrevendo o estado da tarefa.",
    )
  }
  if (acao === "delegar" && !responsavelAlvo) {
    return invalida(
      "A delegação exige um responsável único de destino (responsavelAlvo).",
    )
  }
  if (acao === "delegar" && responsavelAlvo) {
    const validacao = validarResponsavelAlvo(tarefa, responsavelAlvo, "delegar")
    if (!validacao.ok) return validacao
  }

  if (acao === "delegar" && responsavelAlvo) {
    return {
      ok: true,
      efeito: {
        status: "delegada",
        responsavelId: responsavelAlvo.id,
        concluidaEm: null,
        agora,
      },
      evento: {
        tipoEvento:
          tarefa.status === "aberta"
            ? "delegacao"
            : ("reatribuicao" as TipoEventoDelegacao),
        deColaboradorId: tarefa.responsavelId,
        paraColaboradorId: responsavelAlvo.id,
        mensagem: mensagem?.trim() || null,
      },
    }
  }

  if (ACOES_DEVOLUCAO.has(acao)) {
    const sabor = DEVOLUCAO_SABOR[
      acao as "devolver_concluida" | "devolver_precisa_informacoes" | "devolver_aguardando_terceiro"
    ]
    return {
      ok: true,
      efeito: {
        status: FLAV_DEVOLUCAO_STATUS[sabor],
        // Responsável único permanece: a devolução não troca responsável.
        responsavelId: tarefa.responsavelId,
        // Só o sabor concluída preenche concluidaEm; demais apenas status.
        concluidaEm: sabor === "concluida" ? agora : null,
        agora,
      },
      evento: {
        tipoEvento: FLAV_DEVOLUCAO_TIPO_EVENTO[sabor],
        // Devolução: de = responsável atual, para = null (ninguém assume).
        deColaboradorId: tarefa.responsavelId,
        paraColaboradorId: null,
        mensagem: mensagem!.trim(),
      },
    }
  }

  // acao === "cancelar" (única ação restante nas arestas válidas).
  return {
    ok: true,
    efeito: {
      status: "cancelada",
      responsavelId: tarefa.responsavelId,
      concluidaEm: null,
      agora,
    },
    evento: {
      tipoEvento: "mudanca_status",
      deColaboradorId: null,
      paraColaboradorId: null,
      // Contexto do evento: de/para de status (cancelar não troca responsável).
      mensagem:
        mensagem?.trim()
          ? `Status: ${tarefa.status} → cancelada. ${mensagem.trim()}`
          : `Status: ${tarefa.status} → cancelada`,
    },
  }
}

/**
 * Consulta pura: a ação é válida no estado atual?
 * (Pré-condições de mensagem/responsável são do `transicionar`.)
 */
export function acaoValida(status: StatusTarefa, acao: AcaoFluxo): boolean {
  return TRANSICOES_VALIDAS[status].includes(acao)
}

/** Ações permitidas a partir do estado (vazio = estado terminal). */
export function acoesPermitidas(status: StatusTarefa): readonly AcaoFluxo[] {
  return TRANSICOES_VALIDAS[status]
}

/**
 * Utilitário para consumidores: extrai o erro de um resultado não-ok
 * (transição inválida ou pré-condição violada); `null` se ok.
 */
export function extrairErroTransicao(
  resultado: TransicaoResultado,
): ErroTransicaoInvalida | null {
  return resultado.ok ? null : resultado.erro
}

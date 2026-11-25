/**
 * FluxoTarefasGlobalService — endpoints custom de fluxo da tarefa
 * (gestao-de-tarefas-global — macro #3, subtarefa 2): delegar / devolver /
 * concluir / cancelar + chat + histórico.
 *
 * Regras (REQ-F-005, REQ-F-010, REQ-F-011, REQ-F-012, REQ-D-006):
 * - Máquina de estados (projects/.../src/fluxo/maquina-estados.ts): a
 *   transição é decidida pelo domínio puro; este service aplica o `efeito`
 *   na tarefa E insere a linha de `historico_tarefas` na MESMA transação
 *   (atômico: nunca tarefa atualizada sem histórico, nem histórico sem
 *   transição);
 * - Histórico append-only: nenhuma rota/operação aqui (nem em outro módulo)
 *   faz PUT/PATCH/DELETE em `historico_tarefas` — só insert;
 * - Escopo row-level idêntico ao CRUD: tarefa fora da organização da sessão
 *   → 404 (o filtro `organizacao_id` entra no WHERE — registro "inexistente");
 * - Autorização: delegar/devolver/concluir exigem responsável atual ou
 *   admin/gerente; cancelar inclui o criador; demais colaboradores → 403;
 * - Ex-responsável segue vendo a tarefa: a visibilidade é puramente
 *   organizacional (escopo vigente em gestao-tarefas-global.escopo.ts) —
 *   delegação não revê acesso de leitura;
 * - Chat: `autorId` é SEMPRE o colaborador da sessão (guard de escopo),
 *   nunca do body;
 * - Realtime (tipos existentes em packages/shared/src/realtime.ts — schema
 *   NÃO alterado): `task.status.changed` em toda transição persistida e
 *   `chat.message.created` no envio de mensagem (eventId uuid, projectId do
 *   token, taskId);
 * - Notificações do sino (macro #5, subtarefa 2): `delegar` → tipo
 *   `delegacao` para o alvo; `devolver` (todos os sabores, incluindo o
 *   atalho `/concluir`) → tipo `devolucao` para o delegador (último evento
 *   de delegação/reatribuição que entregou a tarefa a quem devolve; na
 *   falta dele, o criador). A INSERT acontece na MESMA transação da
 *   transição; o push `notification.created` só após o commit. `cancelar`
 *   não notifica (fora do critério). Destinatário sem `usuario_id` ou igual
 *   ao autor da ação → pulado (nunca quebra a transição).
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import type { Perfil, ProjetoResumo } from "@biblioteca-global/shared"
import {
  colaboradores,
  historicoTarefas,
  mensagensTarefa,
  tarefas,
} from "../../../../../projects/gestao-de-tarefas-global/schema"
import { transicionar, type StatusTarefa } from "../../../../../projects/gestao-de-tarefas-global/src/fluxo/maquina-estados"
import type { AcaoFluxo } from "../../../../../projects/gestao-de-tarefas-global/src/fluxo/historico"
import {
  exigirContextoColaborador,
} from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/resolvers"
import {
  SemColaboradorAtivoError,
  type RequisicaoComEscopoOrganizacao,
} from "../../../../../projects/gestao-de-tarefas-global/src/tenancy/tipos"
import { ehErroDatabaseAusente } from "../../common/erros"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "../crud/project-db.factory"
import { RealtimeService } from "../realtime/realtime.service"
import {
  NotificacoesService,
  type NotificacaoCriada,
  type TipoNotificacao,
} from "../gestao-tarefas-global-notificacoes/notificacoes.service"
import type {
  CancelarBody,
  DelegarBody,
  DevolverBody,
  MensagemChatBody,
} from "./dto/fluxo-tarefas.schemas"

/** Contexto de colaborador da sessão (guard de escopo já validou). */
export interface ContextoSessao {
  organizacaoId: number
  colaboradorId: number
  perfil: Perfil
}

/** Resposta dos endpoints de transição. */
export interface ResultadoTransicao {
  tarefaId: number
  status: StatusTarefa
  responsavelId: number
  /** Preenchida apenas na devolução sabor concluída. */
  concluidaEm: string | null
  evento: {
    tipoEvento: string
    deColaboradorId: number | null
    paraColaboradorId: number | null
    mensagem: string | null
  }
  /** Notificação do sino criada nesta transição (null quando não aplicável). */
  notificacao: NotificacaoCriada | null
}

/** Item do histórico cronológico (append-only). */
export interface ItemHistorico {
  id: number
  tipoEvento: string
  deColaboradorId: number | null
  deColaboradorNome: string | null
  paraColaboradorId: number | null
  paraColaboradorNome: string | null
  mensagem: string | null
  criadoEm: string
}

/** Mensagem do chat da tarefa (autor sempre da sessão; nome resolvido). */
export interface MensagemTarefaItem {
  id: number
  autorId: number
  autorNome: string
  texto: string
  criadoEm: string
}

interface LinhaTarefa {
  id: number
  organizacaoId: number
  responsavelId: number
  criadoPorId: number
  titulo: string
  status: StatusTarefa
}

/** Perfis com autoridade administrativa dentro da organização. */
const PERFIS_ADMIN = new Set<Perfil>(["admin", "gerente"])

@Injectable()
export class FluxoTarefasGlobalService {
  private readonly logger = new Logger(FluxoTarefasGlobalService.name)

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    private readonly realtime: RealtimeService,
    private readonly notificacoes: NotificacoesService,
  ) {}

  // ==========================================================================
  // Contexto / escopo
  // ==========================================================================

  /**
   * Contexto de negócio a partir da request (guard de escopo executado):
   * master da plataforma e usuário sem colaborador ativo → 403.
   */
  contextoDaRequest(
    req: RequisicaoComEscopoOrganizacao,
  ): ContextoSessao {
    if (!req.escopoOrganizacao) {
      throw new ForbiddenException(
        "Contexto de organização não resolvido — EscopoOrganizacaoGuard não executou.",
      )
    }
    try {
      const contexto = exigirContextoColaborador(req.escopoOrganizacao)
      return {
        organizacaoId: contexto.organizacaoId,
        colaboradorId: contexto.colaboradorId,
        perfil: contexto.perfil,
      }
    } catch (erro) {
      if (erro instanceof SemColaboradorAtivoError) {
        throw new ForbiddenException(erro.message)
      }
      throw erro
    }
  }

  private async dbDoProjeto(projeto: ProjetoResumo) {
    try {
      return await this.factory.obter({ id: projeto.id })
    } catch (erro: unknown) {
      if (ehErroDatabaseAusente(erro)) {
        throw new NotFoundException("Database do projeto indisponível")
      }
      throw erro
    }
  }

  /**
   * Tarefa pelo id DENTRO da organização da sessão — fora do escopo → 404
   * (mesma semântica do CRUD row-level: a condição de organização entra no
   * WHERE; nunca vazar existência de tarefa de outra organização).
   */
  private async carregarTarefaNoEscopo(
    db: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    tarefaId: number,
    organizacaoId: number,
  ): Promise<LinhaTarefa> {
    const [linha] = await db
      .select({
        id: tarefas.id,
        organizacaoId: tarefas.organizacaoId,
        responsavelId: tarefas.responsavelId,
        criadoPorId: tarefas.criadoPorId,
        titulo: tarefas.titulo,
        status: tarefas.status,
      })
      .from(tarefas)
      .where(and(eq(tarefas.id, tarefaId), eq(tarefas.organizacaoId, organizacaoId)))
      .limit(1)
    if (!linha) {
      throw new NotFoundException(
        "Tarefa não encontrada nesta organização.",
      )
    }
    return {
      id: Number(linha.id),
      organizacaoId: Number(linha.organizacaoId),
      responsavelId: Number(linha.responsavelId),
      criadoPorId: Number(linha.criadoPorId),
      titulo: linha.titulo,
      status: linha.status as StatusTarefa,
    }
  }

  /** Autorização da ação (403 claro) — antes de qualquer mutação. */
  private autorizarAcao(
    acao: "delegar" | "devolver" | "concluir" | "cancelar",
    tarefa: LinhaTarefa,
    ctx: ContextoSessao,
  ): void {
    const eResponsavelAtual = tarefa.responsavelId === ctx.colaboradorId
    const eCriador = tarefa.criadoPorId === ctx.colaboradorId
    const ehAdmin = PERFIS_ADMIN.has(ctx.perfil)

    let permitido: boolean
    let rotulo: string
    switch (acao) {
      case "cancelar":
        // Cancelar inclui o criador (além do responsável e admin/gerente).
        permitido = eResponsavelAtual || eCriador || ehAdmin
        rotulo = "cancelar uma tarefa"
        break
      case "delegar":
        permitido = eResponsavelAtual || ehAdmin
        rotulo = "delegar uma tarefa"
        break
      case "devolver":
      case "concluir":
        permitido = eResponsavelAtual || ehAdmin
        rotulo = "devolver/concluir uma tarefa"
        break
    }
    if (!permitido) {
      throw new ForbiddenException(
        `Ação não autorizada: para ${rotulo} é preciso ser o responsável atual, ` +
          (acao === "cancelar"
            ? "o criador da tarefa ou um admin/gerente da organização."
            : "um admin/gerente da organização."),
      )
    }
  }

  // ==========================================================================
  // Transições (delegar/devolver/concluir/cancelar)
  // ==========================================================================

  private async executarTransicao(input: {
    projeto: ProjetoResumo
    tarefaId: number
    ctx: ContextoSessao
    acao: AcaoFluxo
    acaoLabel: "delegar" | "devolver" | "concluir" | "cancelar"
    responsavelAlvo?: { id: number }
    mensagem?: string
  }): Promise<ResultadoTransicao> {
    const { projeto, tarefaId, ctx, acao, acaoLabel, responsavelAlvo, mensagem } = input
    const db = await this.dbDoProjeto(projeto)

    // Escopo row-level (404 fora da organização) + autorização (403).
    const tarefa = await this.carregarTarefaNoEscopo(db, tarefaId, ctx.organizacaoId)
    this.autorizarAcao(acaoLabel, tarefa, ctx)

    // Pré-validação do alvo da delegação (400 claro se id inexistente/outra org).
    if (acao === "delegar" && responsavelAlvo) {
      const [alvo] = await db
        .select({
          id: colaboradores.id,
          organizacaoId: colaboradores.organizacaoId,
          ativo: colaboradores.ativo,
        })
        .from(colaboradores)
        .where(eq(colaboradores.id, responsavelAlvo.id))
        .limit(1)
      if (!alvo || Number(alvo.organizacaoId) !== ctx.organizacaoId || !alvo.ativo) {
        // Inativos também são rejeitados aqui: a máquina de estados assume um
        // alvo ativo (pré-condição da delegação).
        throw new BadRequestException(
          "responsavelId inválido: o colaborador informado não existe nesta organização.",
        )
      }
    }

    const agora = new Date()
    // Tarefa + linha de histórico na MESMA transação (atômico).
    const resultado = await (db.transaction as (
      fn: (tx: unknown) => Promise<unknown>,
    ) => Promise<unknown>)(
      async (tx) => {
        const txDb = tx as typeof db
        const [atual] = await txDb
          .select({
            id: tarefas.id,
            responsavelId: tarefas.responsavelId,
            status: tarefas.status,
          })
          .from(tarefas)
          .where(and(eq(tarefas.id, tarefaId), eq(tarefas.organizacaoId, ctx.organizacaoId)))
          .limit(1)
        if (!atual) {
          throw new NotFoundException("Tarefa não encontrada nesta organização.")
        }

        const destino =
          acao === "delegar" && responsavelAlvo
            ? {
                id: Number(responsavelAlvo.id),
                organizacaoId: ctx.organizacaoId,
                ativo: true,
              }
            : undefined

        const resultado = transicionar({
          tarefa: {
            id: Number(atual.id),
            organizacaoId: ctx.organizacaoId,
            responsavelId: Number(atual.responsavelId),
            status: atual.status as StatusTarefa,
          },
          acao,
          responsavelAlvo: destino,
          mensagem,
          agora,
        })
        if (!resultado.ok) {
          throw new ConflictException(
            `Transição rejeitada: ${resultado.erro.motivo}`,
          )
        }

        const set: Record<string, unknown> = {
          status: resultado.efeito.status,
          responsavelId: resultado.efeito.responsavelId,
        }
        // concluidaEm: preenchida apenas pela devolução sabor concluída.
        if (resultado.efeito.status === "concluida") {
          set.concluidaEm = agora.toISOString()
        }
        await txDb
          .update(tarefas)
          .set(set as never)
          .where(eq(tarefas.id, tarefaId))

        const [insercao] = await txDb
          .insert(historicoTarefas)
          .values({
            tarefaId,
            tipoEvento: resultado.evento.tipoEvento,
            deColaboradorId: resultado.evento.deColaboradorId,
            paraColaboradorId: resultado.evento.paraColaboradorId,
            mensagem: resultado.evento.mensagem,
            criadoEm: agora,
          })
        void insercao

        // Notificações do sino (macro #5, subtarefa 2): INSERT na MESMA
        // transação da mudança de estado — sem commit, sem notificação
        // (retry limpo se a transição falhar). O push sai só após o commit.
        const notificacao = await this.criarNotificacaoDeFluxo(txDb, {
          acao,
          acaoLabel,
          tarefaId,
          tarefaTitulo: tarefa.titulo,
          criadoPorId: tarefa.criadoPorId,
          responsavelAnteriorId: Number(atual.responsavelId),
          responsavelAlvoId:
            acao === "delegar" && responsavelAlvo
              ? Number(responsavelAlvo.id)
              : null,
          organizacaoId: ctx.organizacaoId,
          novoStatus: resultado.efeito.status,
          mensagem: resultado.evento.mensagem,
          colaboradorIdAutor: ctx.colaboradorId,
          agora,
        })

        return { resultado, notificacao }
      },
    )

    const txResultado = resultado as {
      resultado: Extract<
        Awaited<ReturnType<typeof transicionar>>,
        { ok: true }
      >
      notificacao: NotificacaoCriada | null
    }
    const ok = txResultado.resultado
    // Evento realtime SÓ após o commit (tipos do schema compartilhado).
    this.realtime.publicar({
      eventId: randomUUID(),
      occurredAt: agora.toISOString(),
      source: "gestao-tarefas-global:fluxo",
      projectId: projeto.id,
      taskId: tarefaId,
      type: "task.status.changed",
      payload: {
        previousStatus: tarefa.status,
        status: ok.efeito.status,
      },
    })
    // Push `notification.created` SÓ após commit — canal `notifications`,
    // escopo (projectId, usuarioId) do DESTINATÁRIO (subtarefa 2).
    if (txResultado.notificacao) {
      this.notificacoes.publicarCriada(projeto.id, txResultado.notificacao)
    }

    return {
      tarefaId,
      status: ok.efeito.status,
      responsavelId: ok.efeito.responsavelId,
      concluidaEm:
        ok.efeito.concluidaEm != null
          ? agora.toISOString()
          : null,
      evento: {
        tipoEvento: ok.evento.tipoEvento,
        deColaboradorId: ok.evento.deColaboradorId,
        paraColaboradorId: ok.evento.paraColaboradorId,
        mensagem: ok.evento.mensagem,
      },
      notificacao: txResultado.notificacao,
    }
  }

  /**
   * Notificação do sino para a transição (macro #5, subtarefa 2) — INSERIDA
   * NA TRANSAÇÃO do chamador (`txDb`), nunca em transação própria:
   * - `delegar` → `delegacao` para o responsável-alvo;
   * - `devolver`/atalho `concluir` (ações `devolver_*` da máquina) →
   *   `devolucao` para o delegador;
   * - `cancelar` → nenhuma (tarefa cancelada não gera sino — fora do
   *   critério).
   * Pula silenciosamente (log debug) quando o destinatário é o próprio
   * autor ou quando o colaborador-destino não tem `usuario_id` (sem usuário
   * global na plataforma = sem sino). Nunca lança: falha aqui quebraria a
   * transição, e notificação é consequência, não pré-requisito.
   */
  private async criarNotificacaoDeFluxo(
    txDb: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    input: {
      acao: AcaoFluxo
      acaoLabel: "delegar" | "devolver" | "concluir" | "cancelar"
      tarefaId: number
      tarefaTitulo: string
      criadoPorId: number
      responsavelAnteriorId: number
      responsavelAlvoId: number | null
      organizacaoId: number
      novoStatus: StatusTarefa
      mensagem: string | null
      colaboradorIdAutor: number
      agora: Date
    },
  ): Promise<NotificacaoCriada | null> {
    const tipo: TipoNotificacao | null =
      input.acaoLabel === "delegar"
        ? "delegacao"
        : input.acao.startsWith("devolver")
          ? "devolucao"
          : null
    if (!tipo) return null

    let destinatarioColaboradorId: number | null
    let titulo: string
    let corpo: string
    if (tipo === "delegacao") {
      destinatarioColaboradorId = input.responsavelAlvoId
      titulo = `Tarefa delegada para você: ${input.tarefaTitulo}`
      corpo = `Você agora é o responsável pela tarefa "${input.tarefaTitulo}" (#${input.tarefaId}).`
    } else {
      destinatarioColaboradorId = await this.resolverDelegadorDaDevolucao(
        txDb,
        input.tarefaId,
        input.responsavelAnteriorId,
        input.criadoPorId,
      )
      titulo = `Tarefa devolvida: ${input.tarefaTitulo}`
      corpo =
        `A tarefa "${input.tarefaTitulo}" (#${input.tarefaId}) foi devolvida ` +
        `para você (status: ${input.novoStatus}). Mensagem: ${input.mensagem ?? "-"}`
    }

    if (
      destinatarioColaboradorId == null ||
      destinatarioColaboradorId === input.colaboradorIdAutor
    ) {
      return null
    }

    const [destinatario] = await txDb
      .select({ usuarioId: colaboradores.usuarioId })
      .from(colaboradores)
      .where(eq(colaboradores.id, destinatarioColaboradorId))
      .limit(1)
    if (destinatario?.usuarioId == null) {
      this.logger.debug(
        `notificação de ${tipo} pulada: colaborador ${destinatarioColaboradorId} sem usuario_id (tarefa ${input.tarefaId})`,
      )
      return null
    }

    return this.notificacoes.inserirEmTransacao(txDb, {
      organizacaoId: input.organizacaoId,
      usuarioId: Number(destinatario.usuarioId),
      titulo,
      corpo,
      tipo,
      tarefaId: input.tarefaId,
      criadoEm: input.agora,
    })
  }

  /**
   * Delegador de uma devolução = autor da ÚLTIMA delegação/reatribuição que
   * colocou a tarefa nas mãos de quem está devolvendo; sem tal evento
   * (tarefa criada já com responsável, histórico antigo), o criador.
   */
  private async resolverDelegadorDaDevolucao(
    txDb: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    tarefaId: number,
    responsavelQueDevolveId: number,
    criadoPorId: number,
  ): Promise<number> {
    const [evento] = await txDb
      .select({ deColaboradorId: historicoTarefas.deColaboradorId })
      .from(historicoTarefas)
      .where(
        and(
          eq(historicoTarefas.tarefaId, tarefaId),
          inArray(historicoTarefas.tipoEvento, ["delegacao", "reatribuicao"]),
          eq(historicoTarefas.paraColaboradorId, responsavelQueDevolveId),
        ),
      )
      .orderBy(desc(historicoTarefas.criadoEm))
      .limit(1)
    return evento?.deColaboradorId != null
      ? Number(evento.deColaboradorId)
      : criadoPorId
  }

  /** POST .../delegar — troca o responsável único (1ª delegação ou reatribuição). */
  async delegar(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
    body: DelegarBody,
  ): Promise<ResultadoTransicao> {
    return this.executarTransicao({
      projeto,
      tarefaId,
      ctx,
      acao: "delegar",
      acaoLabel: "delegar",
      responsavelAlvo: { id: body.responsavelId },
    })
  }

  /** POST .../devolver — 1 dos 3 sabores + mensagem obrigatória. */
  async devolver(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
    body: DevolverBody,
  ): Promise<ResultadoTransicao> {
    const acao: AcaoFluxo =
      body.sabor === "concluida"
        ? "devolver_concluida"
        : body.sabor === "precisa_informacoes"
          ? "devolver_precisa_informacoes"
          : "devolver_aguardando_terceiro"
    return this.executarTransicao({
      projeto,
      tarefaId,
      ctx,
      acao,
      acaoLabel: "devolver",
      mensagem: body.mensagem,
    })
  }

  /** POST .../concluir — atalho da devolução sabor concluída (preenche concluidaEm). */
  async concluir(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
  ): Promise<ResultadoTransicao> {
    return this.executarTransicao({
      projeto,
      tarefaId,
      ctx,
      acao: "devolver_concluida",
      acaoLabel: "concluir",
      // Atalho: o registro de histórico recebe a mensagem padrão do
      // fechamento (o sabor concluída via /concluir não exige texto do usuário;
      // a mensagem obrigatória vale para /devolver).
      mensagem: "Tarefa concluída via atalho /concluir.",
    })
  }

  /** POST .../cancelar — motivo opcional; inclui o criador na autorização. */
  async cancelar(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
    body: CancelarBody,
  ): Promise<ResultadoTransicao> {
    return this.executarTransicao({
      projeto,
      tarefaId,
      ctx,
      acao: "cancelar",
      acaoLabel: "cancelar",
      mensagem: body.motivo,
    })
  }

  // ==========================================================================
  // Histórico (append-only — somente leitura)
  // ==========================================================================

  /**
   * GET .../historico — trilha cronológica (antigo → novo) da tarefa.
   * Sem edição/exclusão: nenhuma rota expõe PUT/PATCH/DELETE desta tabela.
   */
  async historico(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
  ): Promise<ItemHistorico[]> {
    const db = await this.dbDoProjeto(projeto)
    const tarefa = await this.carregarTarefaNoEscopo(db, tarefaId, ctx.organizacaoId)
    void tarefa

    const linhas = await db
      .select({
        id: historicoTarefas.id,
        tipoEvento: historicoTarefas.tipoEvento,
        deColaboradorId: historicoTarefas.deColaboradorId,
        paraColaboradorId: historicoTarefas.paraColaboradorId,
        mensagem: historicoTarefas.mensagem,
        criadoEm: historicoTarefas.criadoEm,
      })
      .from(historicoTarefas)
      .where(eq(historicoTarefas.tarefaId, tarefaId))
      .orderBy(asc(historicoTarefas.criadoEm), asc(historicoTarefas.id))

    const ids = [
      ...new Set(
        linhas.flatMap((l) =>
          [l.deColaboradorId, l.paraColaboradorId]
            .map((v) => (v == null ? null : Number(v)))
            .filter((v): v is number => v != null),
        ),
      ),
    ]
    const nomes = await this.nomesColaboradores(db, ids)

    return linhas.map((l) => {
      const de = l.deColaboradorId == null ? null : Number(l.deColaboradorId)
      const para = l.paraColaboradorId == null ? null : Number(l.paraColaboradorId)
      return {
        id: Number(l.id),
        tipoEvento: l.tipoEvento,
        deColaboradorId: de,
        deColaboradorNome: de == null ? null : (nomes.get(de) ?? null),
        paraColaboradorId: para,
        paraColaboradorNome: para == null ? null : (nomes.get(para) ?? null),
        mensagem: l.mensagem,
        criadoEm: (l.criadoEm as Date).toISOString(),
      }
    })
  }

  // ==========================================================================
  // Chat por tarefa (mensagens_tarefa)
  // ==========================================================================

  /**
   * POST .../mensagens — persiste a mensagem com autorId do COLABORADOR DA
   * SESSÃO (guard de escopo) — o body só carrega o texto. Publica
   * `chat.message.created` após o commit.
   */
  async criarMensagem(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
    body: MensagemChatBody,
  ): Promise<MensagemTarefaItem> {
    const db = await this.dbDoProjeto(projeto)
    const tarefa = await this.carregarTarefaNoEscopo(db, tarefaId, ctx.organizacaoId)
    void tarefa

    const agora = new Date()
    const [insercao] = await db
      .insert(mensagensTarefa)
      .values({
        tarefaId,
        autorId: ctx.colaboradorId,
        texto: body.texto,
        criadoEm: agora,
      })
    const id = Number(insercao.insertId)

    const nomes = await this.nomesColaboradores(db, [ctx.colaboradorId])

    this.realtime.publicar({
      eventId: randomUUID(),
      occurredAt: agora.toISOString(),
      source: "gestao-tarefas-global:fluxo",
      projectId: projeto.id,
      taskId: tarefaId,
      type: "chat.message.created",
      payload: {
        message: {
          id,
          autorId: ctx.colaboradorId,
          autorNome: nomes.get(ctx.colaboradorId) ?? null,
          texto: body.texto,
          criadoEm: agora.toISOString(),
        },
      },
    })

    return {
      id,
      autorId: ctx.colaboradorId,
      autorNome: nomes.get(ctx.colaboradorId) ?? "Colaborador",
      texto: body.texto,
      criadoEm: agora.toISOString(),
    }
  }

  /** GET .../mensagens — mensagens da tarefa com autor (nome) e data. */
  async listarMensagens(
    projeto: ProjetoResumo,
    ctx: ContextoSessao,
    tarefaId: number,
  ): Promise<MensagemTarefaItem[]> {
    const db = await this.dbDoProjeto(projeto)
    const tarefa = await this.carregarTarefaNoEscopo(db, tarefaId, ctx.organizacaoId)
    void tarefa

    const linhas = await db
      .select({
        id: mensagensTarefa.id,
        autorId: mensagensTarefa.autorId,
        texto: mensagensTarefa.texto,
        criadoEm: mensagensTarefa.criadoEm,
      })
      .from(mensagensTarefa)
      .where(eq(mensagensTarefa.tarefaId, tarefaId))
      .orderBy(asc(mensagensTarefa.criadoEm), asc(mensagensTarefa.id))

    const ids = [...new Set(linhas.map((l) => Number(l.autorId)))]
    const nomes = await this.nomesColaboradores(db, ids)

    return linhas.map((l) => {
      const autorId = Number(l.autorId)
      return {
        id: Number(l.id),
        autorId,
        autorNome: nomes.get(autorId) ?? "Colaborador",
        texto: l.texto,
        criadoEm: (l.criadoEm as Date).toISOString(),
      }
    })
  }

  /** Nomes dos colaboradores (mesma organização — FK garante o vínculo). */
  private async nomesColaboradores(
    db: Awaited<ReturnType<ProjectDbFactory["obter"]>>,
    ids: number[],
  ): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map()
    // Consulta por ids: de/para/autor só apontam para colaboradores da
    // organização da tarefa (as transições validam o alvo no escopo).
    const resultados = await db
      .select({ id: colaboradores.id, nome: colaboradores.nome })
      .from(colaboradores)
      .where(inArray(colaboradores.id, ids))
    return new Map(resultados.map((l) => [Number(l.id), l.nome]))
  }
}

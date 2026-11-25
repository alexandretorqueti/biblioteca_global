/**
 * NotificacoesService — criação + queries das notificações in-app do sino
 * (gestao-de-tarefas-global — macro #5, subtarefa 2).
 *
 * Contrato de criação (atômico por construção):
 * - `inserirEmTransacao(tx, ...)` INSERE na transação do CHAMADOR (fluxo de
 *   delegação/devolução, agendador de lembretes) — nunca abre transação
 *   própria e nunca publica: se a transação do chamador falhar, a
 *   notificação desaparece junto com a mudança de estado (retry natural);
 * - `publicarCriada(projetoId, notificacao)` emite o push
 *   `notification.created` (canal `notifications`, escopo
 *   projectId+usuarioId da sessão — schema em
 *   packages/shared/src/realtime.ts) e só deve ser chamada APÓS o commit,
 *   na mesma janela dos pushes de `task.status.changed` do fluxo. Push é
 *   fire-and-forget: falha de socket nunca quebra a request (o sino alcança
 *   o estado via GET);
 * - payloads de push são serializados estáveis (camelCase + ISO) — o
 *   registro enviado é exatamente o da linha criada.
 *
 * Queries do usuário logado (regra de segurança central):
 * - SEMPRE `usuarioId = claims.sub` da sessão (via ProjectScopeGuard →
 *   UsuarioAutenticado.id) — nunca do body/param;
 * - listagem/contagem filtram por usuarioId; `marcarLida` exige id E
 *   usuarioId na mesma condição — notificação de outro usuário é 404
 *   (existência de id alheio nunca vazada, semântica row-level do projeto);
 * - marcar lida NUNCA afeta o estado da tarefa associada;
 * - após marcar (uma/todas), publica `notifications.unread.changed` com a
 *   contagem restante (sino atualiza o badge em tempo real).
 *
 * v1 de contagem/listagem usa `SELECT` + `LIMIT` (índice
 * `notificacoes_usuario_id_lida`, migration 0003) — volume de sino é baixo
 * por usuário; `count(*)` dedicado fica para quando o perfil crescer.
 */
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { and, desc, eq } from "drizzle-orm"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { notificacoes } from "../../../../../projects/gestao-de-tarefas-global/schema"
import { ehErroDatabaseAusente } from "../../common/erros"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
} from "../crud/project-db.factory"
import { RealtimeService } from "../realtime/realtime.service"

/** Banco do projeto (mesmo alias usado pelo fluxo — fake-friendly). */
type ProjetoDbConectado = Awaited<ReturnType<ProjectDbFactory["obter"]>>

/** Tipo da notificação — espelha o enum da coluna `notificacoes.tipo`. */
export type TipoNotificacao = "lembrete" | "delegacao" | "devolucao" | "sistema"

/** Parâmetros de criação (a transação do chamador é quem persiste). */
export interface NovaNotificacaoInput {
  organizacaoId: number
  /** Usuário GLOBAL da plataforma (core.usuarios) — destinatário do sino. */
  usuarioId: number
  titulo: string
  corpo: string | null
  tipo: TipoNotificacao
  tarefaId: number | null
  /** Carimbo da notificação (o fluxo passa o `agora` da transição). */
  criadoEm?: Date
}

/** Notificação criada — payload estável para push e para os testes. */
export interface NotificacaoCriada {
  id: number
  organizacaoId: number
  usuarioId: number
  titulo: string
  corpo: string | null
  tipo: TipoNotificacao
  tarefaId: number | null
  lida: boolean
  criadoEm: string
}

/** Item do sino (resposta dos endpoints GET). */
export interface NotificacaoItem {
  id: number
  titulo: string
  corpo: string | null
  tipo: TipoNotificacao
  tarefaId: number | null
  lida: boolean
  criadoEm: string
}

/** Opções de listagem do sino. */
export interface ListarNotificacoesOpcoes {
  apenasNaoLidas?: boolean
  limite?: number
}

const LIMITE_PADRAO = 50
const LIMITE_MAXIMO = 100

@Injectable()
export class NotificacoesService {
  private readonly logger = new Logger(NotificacoesService.name)

  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
    private readonly realtime: RealtimeService,
  ) {}

  // ==========================================================================
  // Criação (transação do chamador) + push (pós-commit)
  // ==========================================================================

  /**
   * Insert em `notificacoes` NA TRANSAÇÃO DO CHAMADOR (tx ou db já
   * transacionado). Não publica — o push é promessa pós-commit, feita pelo
   * chamador com `publicarCriada`.
   */
  async inserirEmTransacao(
    tx: Pick<ProjetoDbConectado, "insert">,
    input: NovaNotificacaoInput,
  ): Promise<NotificacaoCriada> {
    const criadoEm = input.criadoEm ?? new Date()
    const [res] = await tx.insert(notificacoes).values({
      organizacaoId: input.organizacaoId,
      usuarioId: input.usuarioId,
      titulo: input.titulo,
      corpo: input.corpo,
      tipo: input.tipo,
      tarefaId: input.tarefaId,
      lida: false,
      criadoEm,
    })
    return {
      id: Number(res?.insertId ?? 0),
      organizacaoId: input.organizacaoId,
      usuarioId: input.usuarioId,
      titulo: input.titulo,
      corpo: input.corpo,
      tipo: input.tipo,
      tarefaId: input.tarefaId,
      lida: false,
      criadoEm: criadoEm.toISOString(),
    }
  }

  /**
   * Push `notification.created` para o (projectId, usuarioId) do
   * destinatário. CHAMAR SÓ APÓS COMMIT. Fire-and-forget: erro de transporte
   * é registrado e engolido — o GET do sino é a fonte de verdade.
   */
  publicarCriada(projetoId: number, n: NotificacaoCriada): void {
    try {
      this.realtime.publicarNotificacoes({
        projectId: projetoId,
        usuarioId: n.usuarioId,
        type: "notification.created",
        payload: {
          notification: {
            id: n.id,
            organizacaoId: n.organizacaoId,
            usuarioId: n.usuarioId,
            titulo: n.titulo,
            corpo: n.corpo,
            tipo: n.tipo,
            tarefaId: n.tarefaId,
            lida: n.lida,
            criadoEm: n.criadoEm,
          },
        },
      })
    } catch (erro) {
      this.logger.warn(
        `push notification.created falhou (usuarioId=${n.usuarioId}, id=${n.id}): ${
          erro instanceof Error ? erro.message : String(erro)
        }`,
      )
    }
  }

  // ==========================================================================
  // Queries do usuário da sessão (own-only, sempre)
  // ==========================================================================

  /** GET /:slug/notificacoes — sino do usuário logado (mais recentes 1º). */
  async listar(
    projeto: ProjetoResumo,
    usuarioId: number,
    opcoes: ListarNotificacoesOpcoes = {},
  ): Promise<{ itens: NotificacaoItem[]; naoLidas: number }> {
    const db = await this.dbDoProjeto(projeto)
    const limite = Math.min(opcoes.limite ?? LIMITE_PADRAO, LIMITE_MAXIMO)
    const condicoes = [eq(notificacoes.usuarioId, usuarioId)]
    if (opcoes.apenasNaoLidas) condicoes.push(eq(notificacoes.lida, false))
    const linhas = await db
      .select({
        id: notificacoes.id,
        titulo: notificacoes.titulo,
        corpo: notificacoes.corpo,
        tipo: notificacoes.tipo,
        tarefaId: notificacoes.tarefaId,
        lida: notificacoes.lida,
        criadoEm: notificacoes.criadoEm,
      })
      .from(notificacoes)
      .where(and(...condicoes))
      .orderBy(desc(notificacoes.criadoEm))
      .limit(limite)
    return {
      itens: linhas.map((l) => this.maparItem(l)),
      naoLidas: await this.contarNaoLidasNaDb(db, usuarioId),
    }
  }

  /** GET /:slug/notificacoes/nao-lidas/contagem — badge do sino. */
  async contarNaoLidas(
    projeto: ProjetoResumo,
    usuarioId: number,
  ): Promise<{ contagem: number }> {
    const db = await this.dbDoProjeto(projeto)
    return { contagem: await this.contarNaoLidasNaDb(db, usuarioId) }
  }

  private async contarNaoLidasNaDb(
    db: ProjetoDbConectado,
    usuarioId: number,
  ): Promise<number> {
    const linhas = await db
      .select({ id: notificacoes.id })
      .from(notificacoes)
      .where(
        and(eq(notificacoes.usuarioId, usuarioId), eq(notificacoes.lida, false)),
      )
    return linhas.length
  }

  /**
   * POST /:slug/notificacoes/:id/lida — marca UMA notificação do usuário.
   * id de OUTRO usuário = 404 (mesma semântica de inexistência; existência
   * de registro alheio nunca é vazada). Idempotente: já lida → 200 lida.
   */
  async marcarLida(
    projeto: ProjetoResumo,
    usuarioId: number,
    id: number,
  ): Promise<NotificacaoItem> {
    const db = await this.dbDoProjeto(projeto)
    const [linha] = await db
      .select({ id: notificacoes.id })
      .from(notificacoes)
      .where(
        and(eq(notificacoes.id, id), eq(notificacoes.usuarioId, usuarioId)),
      )
      .limit(1)
    if (!linha) {
      throw new NotFoundException("Notificação não encontrada.")
    }
    await db
      .update(notificacoes)
      .set({ lida: true })
      .where(and(eq(notificacoes.id, id), eq(notificacoes.usuarioId, usuarioId)))
    const naoLidasRestantes = await this.contarNaoLidasNaDb(db, usuarioId)
    this.publicarContagem(projeto.id, usuarioId, naoLidasRestantes)
    const [atualizada] = await db
      .select({
        id: notificacoes.id,
        titulo: notificacoes.titulo,
        corpo: notificacoes.corpo,
        tipo: notificacoes.tipo,
        tarefaId: notificacoes.tarefaId,
        lida: notificacoes.lida,
        criadoEm: notificacoes.criadoEm,
      })
      .from(notificacoes)
      .where(eq(notificacoes.id, id))
      .limit(1)
    if (!atualizada) throw new NotFoundException("Notificação não encontrada.")
    return this.maparItem(atualizada)
  }

  /**
   * POST /:slug/notificacoes/lidas-todas — marca TODAS as não lidas do
   * usuário. Retorna quantas marcadas + contagem restante (0).
   */
  async marcarTodasLidas(
    projeto: ProjetoResumo,
    usuarioId: number,
  ): Promise<{ atualizadas: number; naoLidas: number }> {
    const db = await this.dbDoProjeto(projeto)
    const antes = await this.contarNaoLidasNaDb(db, usuarioId)
    if (antes > 0) {
      await db
        .update(notificacoes)
        .set({ lida: true })
        .where(
          and(
            eq(notificacoes.usuarioId, usuarioId),
            eq(notificacoes.lida, false),
          ),
        )
    }
    const depois = await this.contarNaoLidasNaDb(db, usuarioId)
    this.publicarContagem(projeto.id, usuarioId, depois)
    return { atualizadas: antes - depois, naoLidas: depois }
  }

  /** Push `notifications.unread.changed` — badge do sino em tempo real. */
  private publicarContagem(
    projetoId: number,
    usuarioId: number,
    unreadCount: number,
  ): void {
    try {
      this.realtime.publicarNotificacoes({
        projectId: projetoId,
        usuarioId,
        type: "notifications.unread.changed",
        payload: { unreadCount },
      })
    } catch (erro) {
      this.logger.warn(
        `push notifications.unread.changed falhou (usuarioId=${usuarioId}): ${
          erro instanceof Error ? erro.message : String(erro)
        }`,
      )
    }
  }

  // ==========================================================================
  // Infra
  // ==========================================================================

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

  private maparItem(l: {
    id: number | string
    titulo: string
    corpo: string | null
    tipo: string
    tarefaId: number | string | null
    lida: boolean | number
    criadoEm: Date | string
  }): NotificacaoItem {
    return {
      id: Number(l.id),
      titulo: l.titulo,
      corpo: l.corpo,
      tipo: l.tipo as TipoNotificacao,
      tarefaId: l.tarefaId == null ? null : Number(l.tarefaId),
      lida: Boolean(l.lida),
      criadoEm:
        l.criadoEm instanceof Date ? l.criadoEm.toISOString() : String(l.criadoEm),
    }
  }
}

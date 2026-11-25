/**
 * Repositório do agendador de lembretes (macro 5, subtarefa 1).
 *
 * Porta estreita (`RepositorioLembreteAgendador`) + implementação Drizzle
 * sobre o banco do PROJETO (`projeto_<id>` do slug `gestao-de-tarefas-global`,
 * resolvido no core por slug — padrão de `GestaoOrganizacoesService`). O
 * service do agendador só conhece a porta: os unit tests injetam um fake com
 * semáforo por tarefa, reproduzindo a semântica do `SELECT ... FOR UPDATE`
 * (claim) sem MySQL — idêntico ao padrão de
 * `recorrencia-agendador.repositorio.ts` (macro 4, subtarefa 3).
 *
 * Claim transacional: `claimTarefa` roda DENTRO de `emTransacao` com
 * `SELECT ... FOR UPDATE`; a segunda leitura concorrente (tick sobreposto ou
 * peer blue-green) vê o marcador `historico_tarefas tipoEvento=
 * 'lembrete_gerado'` já inserido — é isso que dá idempotência de v1 (um
 * lembrete por tarefa) sob restart e sob dual blue-green.
 *
 * Varredura do tick (janela do lembrete): `prazo IS NOT NULL AND
 * lembrete_antecedencia_minutos IS NOT NULL AND prazo > agora` — o resto da
 * janela (`(prazo - antecedência) <= agora`) é aplicado no service com o
 * predicado puro `lembreteVencidoAteAgora` do domínio; o índice
 * `tarefas_prazo_lembrete_antecedencia_minutos` (migration 0003) cobre a
 * varredura.
 */
import { Inject, Injectable } from "@nestjs/common"
import { and, eq, gt, isNotNull, sql } from "drizzle-orm"
import {
  colaboradores,
  historicoTarefas,
  notificacoes,
  tarefas,
} from "../../../../../projects/gestao-de-tarefas-global/schema"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { projetos } from "../../../../../database/schema"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
  type ProjetoDb,
} from "../crud/project-db.factory"

import { formatarDatetimeMysql } from "./datetime-mysql"

export const LEMBRETE_AGENDADOR_REPOSITORIO = Symbol(
  "LEMBRETE_AGENDADOR_REPOSITORIO",
)

/** Linha mínima da varredura (o claim re lê a tarefa inteira sob lock). */
export interface TarefaLembreteCandidata {
  id: number
  organizacaoId: number
  /** Coluna `prazo` no formato de texto DATETIME do MySQL. */
  prazo: string
  /** Antecedência em minutos (nunca NULL nesta varredura — filtro SQL). */
  antecedenciaMinutos: number
}

/** Tarefa re-lida sob lock (`SELECT ... FOR UPDATE`) no claim. */
export interface TarefaLembreteClaim {
  id: number
  organizacaoId: number
  titulo: string
  responsavelId: number
  /** NULL = tarefa sem prazo (guarda: sem lembrete — decisão 2026-10-22). */
  prazo: string | null
  /** NULL = sem aviso configurado (guarda: fora do escopo do agendador). */
  antecedenciaMinutos: number | null
}

/** Operações dentro da transação de disparo do lembrete de UMA tarefa. */
export interface TransacaoLembrete {
  /**
   * `SELECT ... FOR UPDATE` da tarefa (claim). Fora da transação chamador
   * nenhum: a lock dura até o commit/rollback.
   */
  claimTarefa(id: number): Promise<TarefaLembreteClaim | null>
  /**
   * Marcador de idempotência de v1: existe `historico_tarefas` com
   * `tipoEvento='lembrete_gerado'` para a tarefa? `true` = lembrete já
   * disparado (segundo tick/concorrência NÃO re-notifica).
   */
  hasLembreteGerado(tarefaId: number): Promise<boolean>
  /**
   * `usuario_id` do responsável (`colaboradores.usuario_id`) — destinatário
   * global da notificação. `null` = colaborador ainda sem usuário vinculado
   * (sem destinatário — o service trata como falha isolada com retry).
   */
  resolveUsuarioResponsavel(responsavelId: number): Promise<number | null>
  /** Insert da notificação (tipo='lembrete', `lida=false`). */
  inserirNotificacao(n: {
    organizacaoId: number
    usuarioId: number
    titulo: string
    corpo: string | null
    tarefaId: number
  }): Promise<void>
  /**
   * Marcador no histórico (append-only): `tipoEvento='lembrete_gerado'`, na
   * MESMA transação da notificação.
   */
  registrarHistoricoLembreteGerado(tarefaId: number, mensagem: string): Promise<void>
}

export interface RepositorioLembreteAgendador {
  /**
   * Varredura do tick: tarefas com `prazo IS NOT NULL`,
   * `lembrete_antecedencia_minutos IS NOT NULL` e `prazo > agora`
   * (o predicado do domínio filtra a janela `(prazo - antecedência) <= agora`).
   */
  listarTarefasCandidatas(agora: Date): Promise<TarefaLembreteCandidata[]>
  /** Transação MySQL para uma tarefa (claim → idempotência → notificação). */
  emTransacao<T>(fn: (tx: TransacaoLembrete) => Promise<T>): Promise<T>
}

@Injectable()
export class LembreteAgendadorRepositorio
  implements RepositorioLembreteAgendador
{
  /** Cache do id do projeto no core (padrão GestaoOrganizacoesService). */
  private projetoIdCache: number | null = null

  constructor(
    @Inject(CORE_DB) private readonly coreDb: CoreDb,
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  private async dbDoProjeto(): Promise<ProjetoDb> {
    if (this.projetoIdCache === null) {
      const linha = (
        await this.coreDb
          .select({ id: projetos.id })
          .from(projetos)
          .where(eq(projetos.slug, "gestao-de-tarefas-global"))
          .limit(1)
      ).at(0)
      if (!linha) {
        throw new Error(
          'Projeto "gestao-de-tarefas-global" não provisionado no core — agendador de lembretes sem banco de projeto.',
        )
      }
      this.projetoIdCache = Number(linha.id)
    }
    return this.factory.obter({ id: this.projetoIdCache })
  }

  async listarTarefasCandidatas(agora: Date): Promise<TarefaLembreteCandidata[]> {
    const db = await this.dbDoProjeto()
    const linhas = await db
      .select({
        id: tarefas.id,
        organizacaoId: tarefas.organizacaoId,
        prazo: tarefas.prazo,
        antecedenciaMinutos: tarefas.lembreteAntecedenciaMinutos,
      })
      .from(tarefas)
      .where(
        and(
          isNotNull(tarefas.prazo),
          isNotNull(tarefas.lembreteAntecedenciaMinutos),
          gt(tarefas.prazo, formatarDatetimeMysql(agora)),
        ),
      )
    return linhas.map((l) => ({
      id: Number(l.id),
      organizacaoId: Number(l.organizacaoId),
      prazo: String(l.prazo),
      antecedenciaMinutos: Number(l.antecedenciaMinutos),
    }))
  }

  async emTransacao<T>(
    fn: (tx: TransacaoLembrete) => Promise<T>,
  ): Promise<T> {
    const db = await this.dbDoProjeto()
    return (db.transaction as unknown as (
      run: (tx: unknown) => Promise<T>,
    ) => Promise<T>)(async (rawTx) => fn(this.naTransacao(rawTx as ProjetoDb)))
  }

  /** Implementação das operações transacionais sobre o handle da transação. */
  private naTransacao(tx: ProjetoDb): TransacaoLembrete {
    return {
      claimTarefa: async (id: number) => {
        const [linha] = await tx
          .select({
            id: tarefas.id,
            organizacaoId: tarefas.organizacaoId,
            titulo: tarefas.titulo,
            responsavelId: tarefas.responsavelId,
            prazo: tarefas.prazo,
            antecedenciaMinutos: tarefas.lembreteAntecedenciaMinutos,
          })
          .from(tarefas)
          .where(eq(tarefas.id, id))
          .limit(1)
          .for("update")
        if (!linha) return null
        return {
          id: Number(linha.id),
          organizacaoId: Number(linha.organizacaoId),
          titulo: linha.titulo,
          responsavelId: Number(linha.responsavelId),
          prazo:
            linha.prazo === null || linha.prazo === undefined
              ? null
              : String(linha.prazo),
          antecedenciaMinutos:
            linha.antecedenciaMinutos === null ||
            linha.antecedenciaMinutos === undefined
              ? null
              : Number(linha.antecedenciaMinutos),
        }
      },
      hasLembreteGerado: async (tarefaId: number) => {
        const [r] = await tx
          .select({ n: sql<number>`count(*)` })
          .from(historicoTarefas)
          .where(
            and(
              eq(historicoTarefas.tarefaId, tarefaId),
              eq(historicoTarefas.tipoEvento, "lembrete_gerado"),
            ),
          )
        return Number(r?.n ?? 0) > 0
      },
      resolveUsuarioResponsavel: async (responsavelId: number) => {
        const [c] = await tx
          .select({ usuarioId: colaboradores.usuarioId })
          .from(colaboradores)
          .where(eq(colaboradores.id, responsavelId))
          .limit(1)
        if (!c || c.usuarioId === null || c.usuarioId === undefined) return null
        return Number(c.usuarioId)
      },
      inserirNotificacao: async (n) => {
        await tx.insert(notificacoes).values({
          organizacaoId: n.organizacaoId,
          usuarioId: n.usuarioId,
          titulo: n.titulo,
          corpo: n.corpo,
          tipo: "lembrete",
          tarefaId: n.tarefaId,
          lida: false,
        })
      },
      registrarHistoricoLembreteGerado: async (tarefaId, mensagem) => {
        await tx.insert(historicoTarefas).values({
          tarefaId,
          tipoEvento: "lembrete_gerado",
          mensagem,
        })
      },
    }
  }
}

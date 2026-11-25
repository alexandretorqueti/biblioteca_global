/**
 * Repositório do agendador de recorrência (macro 4, subtarefa 3).
 *
 * Porta estreita (`RepositorioRecorrenciaAgendador`) + implementação Drizzle
 * sobre o banco do PROJETO (`projeto_<id>` do slug `gestao-de-tarefas-global`,
 * resolvido no core por slug — padrão de `GestaoOrganizacoesService`). O
 * service do agendador só conhece a porta: os unit tests injetam um fake com
 * semáforo por regra, reproduzindo a semântica do `SELECT ... FOR UPDATE`
 * (claim) sem MySQL.
 *
 * Claim transacional: `claimRegra` roda DENTRO de `emTransacao` com
 * `SELECT ... FOR UPDATE`; a segunda leitura concorrente só vê o cursor já
 * avançado — é isso que dá idempotência sob restart e sob dual blue-green
 * (dois agendadores, mesma tabela).
 */
import { Inject, Injectable } from "@nestjs/common"
import { and, eq, isNull, lte, or } from "drizzle-orm"
import {
  regrasRecorrencia,
  tarefas,
} from "../../../../../projects/gestao-de-tarefas-global/schema"
import type {
  Frequencia,
  RegraRecorrencia,
} from "../../../../../projects/gestao-de-tarefas-global/src/recorrencia/tipos"
import type { InstanciaTarefa } from "../../../../../projects/gestao-de-tarefas-global/src/recorrencia/instancia"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { projetos } from "../../../../../database/schema"
import {
  PROJECT_DB_FACTORY,
  type ProjectDbFactory,
  type ProjetoDb,
} from "../crud/project-db.factory"
import { formatarDatetimeMysql } from "./datetime-mysql"

export const RECURRENCIA_AGENDADOR_REPOSITORIO = Symbol(
  "RECURRENCIA_AGENDADOR_REPOSITORIO",
)

/** Identidade mínima retornada pela varredura (o claim re lê a linha inteira). */
export interface RegraVencidaResumo {
  id: number
  organizacaoId: number
}

/** Operações dentro da transação de geração de UMA regra. */
export interface TransacaoRecorrencia {
  /**
   * `SELECT ... FOR UPDATE` da regra (claim). Fora da transação chamador
   * nenhum: a lock dura até o commit/rollback.
   */
  claimRegra(id: number): Promise<RegraRecorrencia | null>
  /** Insert da instância em `tarefas` (payload de `montarInstancia`). */
  inserirInstancia(instancia: InstanciaTarefa): Promise<void>
  /** Avança o cursor `proxima_geracao` (texto "YYYY-MM-DD HH:MM:SS"). */
  avancarProximaGeracao(id: number, proximaGeracao: string): Promise<void>
  /** Encerramento por `dataFim`: `ativa=false`, cursor NULL. */
  encerrarRegra(id: number): Promise<void>
}

export interface RepositorioRecorrenciaAgendador {
  /**
   * Varredura do tick: regras `ativa=true` com `proxima_geracao <= agora`
   * OU `proxima_geracao IS NULL` (bootstrap de regra recém-criada — o
   * service calcula o cursor a partir de agora, sem catch-up retroativo).
   */
  listarRegrasVencidas(agora: Date): Promise<RegraVencidaResumo[]>
  /** Transação MySQL para uma regra (claim → geração → avanço do cursor). */
  emTransacao<T>(fn: (tx: TransacaoRecorrencia) => Promise<T>): Promise<T>
}

/** Linha crua de `regras_recorrencia` no formato do select do repositório. */
interface LinhaRegra {
  id: number
  organizacaoId: number
  titulo: string
  descricao: string | null
  areaId: number
  responsavelId: number
  frequencia: string
  diasSemana: unknown
  horaDoDia: string | null
  dataInicio: string
  dataFim: string | null
  ativa: boolean
  proximaGeracao: string | null
}

/** Colunas selecionadas (todas as que `RegraRecorrencia` precisa). */
const COLUNAS_REGRA = {
  id: regrasRecorrencia.id,
  organizacaoId: regrasRecorrencia.organizacaoId,
  titulo: regrasRecorrencia.titulo,
  descricao: regrasRecorrencia.descricao,
  areaId: regrasRecorrencia.areaId,
  responsavelId: regrasRecorrencia.responsavelId,
  frequencia: regrasRecorrencia.frequencia,
  diasSemana: regrasRecorrencia.diasSemana,
  horaDoDia: regrasRecorrencia.horaDoDia,
  dataInicio: regrasRecorrencia.dataInicio,
  dataFim: regrasRecorrencia.dataFim,
  ativa: regrasRecorrencia.ativa,
  proximaGeracao: regrasRecorrencia.proximaGeracao,
}

/** Linha → tipo do domínio (json `diasSemana` já vem array do mysql2). */
function comoRegra(linha: LinhaRegra): RegraRecorrencia {
  return {
    id: Number(linha.id),
    organizacaoId: Number(linha.organizacaoId),
    titulo: linha.titulo,
    descricao: linha.descricao,
    areaId: Number(linha.areaId),
    responsavelId: Number(linha.responsavelId),
    frequencia: linha.frequencia as Frequencia,
    diasSemana: Array.isArray(linha.diasSemana)
      ? (linha.diasSemana as number[])
      : null,
    horaDoDia: linha.horaDoDia,
    dataInicio: linha.dataInicio,
    dataFim: linha.dataFim,
    ativa: linha.ativa,
    proximaGeracao:
      linha.proximaGeracao === null || linha.proximaGeracao === undefined
        ? null
        : String(linha.proximaGeracao),
  }
}

@Injectable()
export class RecorrenciaAgendadorRepositorio
  implements RepositorioRecorrenciaAgendador
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
          'Projeto "gestao-de-tarefas-global" não provisionado no core — agendador de recorrência sem banco de projeto.',
        )
      }
      this.projetoIdCache = Number(linha.id)
    }
    return this.factory.obter({ id: this.projetoIdCache })
  }

  async listarRegrasVencidas(agora: Date): Promise<RegraVencidaResumo[]> {
    const db = await this.dbDoProjeto()
    const agoraStr = formatarDatetimeMysql(agora)
    const linhas = await db
      .select({
        id: regrasRecorrencia.id,
        organizacaoId: regrasRecorrencia.organizacaoId,
      })
      .from(regrasRecorrencia)
      .where(
        and(
          eq(regrasRecorrencia.ativa, true),
          or(
            isNull(regrasRecorrencia.proximaGeracao),
            lte(regrasRecorrencia.proximaGeracao, agoraStr),
          ),
        ),
      )
    return linhas.map((l) => ({
      id: Number(l.id),
      organizacaoId: Number(l.organizacaoId),
    }))
  }

  async emTransacao<T>(
    fn: (tx: TransacaoRecorrencia) => Promise<T>,
  ): Promise<T> {
    const db = await this.dbDoProjeto()
    return (db.transaction as unknown as (
      run: (tx: unknown) => Promise<T>,
    ) => Promise<T>)(async (rawTx) => fn(this.naTransacao(rawTx as ProjetoDb)))
  }

  /** Implementação das operações transacionais sobre o handle da transação. */
  private naTransacao(tx: ProjetoDb): TransacaoRecorrencia {
    return {
      claimRegra: async (id: number) => {
        const [linha] = await tx
          .select(COLUNAS_REGRA)
          .from(regrasRecorrencia)
          .where(eq(regrasRecorrencia.id, id))
          .limit(1)
          .for("update")
        return linha ? comoRegra(linha as unknown as LinhaRegra) : null
      },
      inserirInstancia: async (instancia: InstanciaTarefa) => {
        await tx.insert(tarefas).values(instancia)
      },
      avancarProximaGeracao: async (id: number, proximaGeracao: string) => {
        await tx
          .update(regrasRecorrencia)
          .set({ proximaGeracao })
          .where(eq(regrasRecorrencia.id, id))
      },
      encerrarRegra: async (id: number) => {
        await tx
          .update(regrasRecorrencia)
          .set({ ativa: false, proximaGeracao: null })
          .where(eq(regrasRecorrencia.id, id))
      },
    }
  }
}

/**
 * NotificacoesMoradorService — lógica de listagem e marcação de leitura
 * de notificações do morador autenticado.
 *
 * Endpoints suportados:
 * - listarNotificacoes: lista notificações do morador autenticado,
 *   com filtro por não lidas e paginação.
 * - marcarComoLida: marca notificação como lida (grava lidaEm).
 *
 * Segurança:
 * - Todas as consultas são filtradas pelo moradorId do usuário autenticado,
 *   impedindo acesso a notificações de outros moradores.
 * - Marcar como lida não afeta o status da encomenda.
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { and, eq, inArray, desc, or, sql, type SQL } from "drizzle-orm"
import type { ProjetoResumo, UsuarioAutenticado } from "@biblioteca-global/shared"
import {
  condominios,
  unidades,
  moradores,
  notificacoes,
  encomendas,
} from "../../../../../projects/taqui/schema"
import { ehErroDatabaseAusente } from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import type { NotificacoesMoradorQuery } from "./dto/notificacoes-morador-query.dto"

/** Notificação retornada na listagem do morador. */
export interface NotificacaoMoradorResult {
  id: number
  encomendaId: number
  tipo: "encomenda_pendente" | "encomenda_pronta_retirada" | "encomenda_entregue" | "ocorrencia_registrada"
  mensagem: string
  lida: boolean
  lidaEm: Date | null
  criadaEm: Date
  /** Dados básicos da encomenda para exibição no card. */
  encomenda: {
    status: "pendente" | "pronta_retirada" | "entregue" | "cancelada"
    fotoUrl: string | null
  } | null
}

/** Resultado da marcação de leitura. */
export interface MarcarComoLidaResult {
  id: number
  lida: true
  lidaEm: Date
}

@Injectable()
export class NotificacoesMoradorService {
  constructor(
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

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
   * Obtém o condomínio do contexto autorizado.
   * Para o TaQui, o condomínio é único por projeto.
   */
  private async obterCondominioDoProjeto(projeto: ProjetoResumo) {
    const db = await this.dbDoProjeto(projeto)
    const [condominio] = await db
      .select({ id: condominios.id })
      .from(condominios)
      .where(eq(condominios.ativo, true))
      .limit(1)
    if (!condominio) {
      throw new NotFoundException("Condomínio não encontrado para este projeto")
    }
    return condominio.id
  }

  /**
   * Busca o morador pelo usuário autenticado.
   * O vínculo é feito por email, telefone ou CPF (matching com usuario).
   */
  private async obterMoradorId(
    projeto: ProjetoResumo,
    usuario: UsuarioAutenticado,
  ) {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // Busca morador ativo por email, telefone ou CPF
    const condicoesBusca: SQL[] = []
    if (usuario.email) {
      condicoesBusca.push(eq(moradores.email, usuario.email))
    }
    if (usuario.telefone) {
      condicoesBusca.push(eq(moradores.telefone, usuario.telefone))
    }
    if (usuario.cpf) {
      condicoesBusca.push(eq(moradores.cpf, usuario.cpf))
    }

    if (condicoesBusca.length === 0) {
      throw new ForbiddenException(
        "Usuário sem dados para vincular a morador (email/telefone/CPF)",
      )
    }

    const [morador] = await db
      .select({ id: moradores.id })
      .from(moradores)
      .where(
        and(
          eq(moradores.ativo, true),
          or(...condicoesBusca),
          // Garante que a unidade pertence ao condomínio
          inArray(
            moradores.unidadeId,
            db
              .select({ id: unidades.id })
              .from(unidades)
              .where(eq(unidades.condominioId, condominioId)),
          ),
        ),
      )
      .limit(1)

    if (!morador) {
      throw new ForbiddenException(
        "Morador não encontrado ou não vinculado a este condomínio",
      )
    }

    return morador.id
  }

  /**
   * Lista notificações do morador autenticado.
   *
   * Filtros suportados:
   * - apenasNaoLidas: se true, retorna apenas não lidas
   * - limit/offset: paginação
   *
   * Retorna notificações com dados básicos da encomenda para exibição
   * em cards na interface do morador.
   */
  async listarNotificacoes(
    projeto: ProjetoResumo,
    usuario: UsuarioAutenticado,
    query: NotificacoesMoradorQuery,
  ): Promise<{ notificacoes: NotificacaoMoradorResult[]; total: number; naoLidas: number }> {
    const moradorId = await this.obterMoradorId(projeto, usuario)
    const db = await this.dbDoProjeto(projeto)

    // Monta condições de filtro
    const condicoes: SQL[] = [eq(notificacoes.moradorId, moradorId)]

    if (query.apenasNaoLidas) {
      condicoes.push(eq(notificacoes.lida, false))
    }

    const onde = and(...condicoes)

    // Conta total e não lidas
    const [countResult] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(notificacoes)
      .where(onde)

    const [naoLidasResult] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(notificacoes)
      .where(and(eq(notificacoes.moradorId, moradorId), eq(notificacoes.lida, false)))

    const total = countResult?.count ?? 0
    const naoLidas = naoLidasResult?.count ?? 0

    // Busca notificações
    const notificacoesRows = await db
      .select({
        id: notificacoes.id,
        encomendaId: notificacoes.encomendaId,
        tipo: notificacoes.tipo,
        mensagem: notificacoes.mensagem,
        lida: notificacoes.lida,
        lidaEm: notificacoes.lidaEm,
        criadaEm: notificacoes.createdAt,
      })
      .from(notificacoes)
      .where(onde)
      .orderBy(desc(notificacoes.createdAt))
      .limit(query.limit)
      .offset(query.offset)

    if (notificacoesRows.length === 0) {
      return { notificacoes: [], total, naoLidas }
    }

    // Busca dados básicos das encomendas
    const encomendaIds = notificacoesRows.map((n) => n.encomendaId)
    const encomendasRows = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        fotoUrl: encomendas.fotoUrl,
      })
      .from(encomendas)
      .where(inArray(encomendas.id, encomendaIds))

    const encomendasMap = new Map<number, { status: typeof encomendasRows[0]["status"]; fotoUrl: string | null }>()
    for (const e of encomendasRows) {
      encomendasMap.set(e.id, { status: e.status, fotoUrl: e.fotoUrl })
    }

    // Monta resultado
    const notificacoesResult: NotificacaoMoradorResult[] = notificacoesRows.map((n) => ({
      id: n.id,
      encomendaId: n.encomendaId,
      tipo: n.tipo,
      mensagem: n.mensagem,
      lida: n.lida,
      lidaEm: n.lidaEm,
      criadaEm: n.criadaEm,
      encomenda: encomendasMap.get(n.encomendaId) ?? null,
    }))

    return { notificacoes: notificacoesResult, total, naoLidas }
  }

  /**
   * Marca notificação como lida.
   *
   * Validações:
   * - Notificação pertence ao morador autenticado
   *
   * Ações:
   * - Grava lida = true
   * - Grava lidaEm com timestamp atual
   *
   * IMPORTANTE: Marcar como lida NÃO afeta o status da encomenda.
   * A confirmação de reconhecimento é uma ação separada.
   */
  async marcarComoLida(
    projeto: ProjetoResumo,
    usuario: UsuarioAutenticado,
    notificacaoId: number,
  ): Promise<MarcarComoLidaResult> {
    const moradorId = await this.obterMoradorId(projeto, usuario)
    const db = await this.dbDoProjeto(projeto)

    // Busca notificação e valida pertencimento
    const [notificacao] = await db
      .select({
        id: notificacoes.id,
        moradorId: notificacoes.moradorId,
        lida: notificacoes.lida,
      })
      .from(notificacoes)
      .where(eq(notificacoes.id, notificacaoId))
      .limit(1)

    if (!notificacao) {
      throw new NotFoundException("Notificação não encontrada")
    }

    // Valida que a notificação pertence ao morador
    if (notificacao.moradorId !== moradorId) {
      throw new ForbiddenException("Notificação não pertence a este morador")
    }

    // Se já está lida, retorna sem atualizar
    if (notificacao.lida) {
      const [notificacaoAtual] = await db
        .select({ lidaEm: notificacoes.lidaEm })
        .from(notificacoes)
        .where(eq(notificacoes.id, notificacaoId))
        .limit(1)

      return {
        id: notificacaoId,
        lida: true,
        lidaEm: notificacaoAtual?.lidaEm ?? new Date(),
      }
    }

    // Atualiza para lida
    const agora = new Date()
    await db
      .update(notificacoes)
      .set({
        lida: true,
        lidaEm: agora,
      })
      .where(eq(notificacoes.id, notificacaoId))

    return {
      id: notificacaoId,
      lida: true,
      lidaEm: agora,
    }
  }
}

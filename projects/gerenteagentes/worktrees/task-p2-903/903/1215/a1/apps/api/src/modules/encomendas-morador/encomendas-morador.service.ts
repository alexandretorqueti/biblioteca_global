/**
 * EncomendasMoradorService — lógica de listagem e confirmação de encomendas
 * pelo morador autenticado.
 *
 * Endpoints suportados:
 * - listarEncomendas: lista encomendas das unidades do morador autenticado,
 *   com filtros por status/grupo e paginação.
 * - confirmarReconhecimento: marca encomenda como reconhecida pelo morador,
 *   muda status para pronta_retirada e cria notificação.
 *
 * Segurança:
 * - Todas as consultas são filtradas pelas unidades do morador autenticado
 *   (via email/telefone/cpf do usuário), impedindo acesso a encomendas de
 *   outras unidades ou condomínios.
 * - A confirmação não marca entrega — apenas muda status para pronta_retirada.
 *   A entrega física continua sendo ato exclusivo da portaria.
 */
import {
  BadRequestException,
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
  transportadoras,
  encomendas,
  notificacoes,
} from "../../../../../projects/taqui/schema"
import { ehErroDatabaseAusente } from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import {
  grupoParaStatus,
  type EncomendasMoradorQuery,
} from "./dto/encomendas-morador-query.dto"

/** Encomenda retornada na listagem do morador. */
export interface EncomendaMoradorResult {
  id: number
  status: "pendente" | "pronta_retirada" | "entregue" | "cancelada"
  fotoUrl: string | null
  transportadora: { id: number; nome: string } | null
  codigoRastreamento: string | null
  unidade: {
    id: number
    label: string | null
    tipo: "apartamento" | "casa"
  }
  registradoEm: Date
  confirmadoEm: Date | null
  entregueEm: Date | null
  canceladoEm: Date | null
  observacoes: string | null
}

/** Resultado da confirmação de reconhecimento. */
export interface ConfirmarReconhecimentoResult {
  encomenda: {
    id: number
    status: "pronta_retirada"
    confirmadoEm: Date
  }
  notificacao: {
    id: number
    tipo: "encomenda_pronta_retirada"
  }
}

@Injectable()
export class EncomendasMoradorService {
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
   * Retorna o morador e suas unidades autorizadas.
   */
  private async obterMoradorComUnidades(
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
      .select({
        id: moradores.id,
        unidadeId: moradores.unidadeId,
        nome: moradores.nome,
      })
      .from(moradores)
      .where(
        and(
          eq(moradores.ativo, true),
          or(...condicoesBusca),
          // Garante que a unidade pertence ao condomínio
          eq(
            moradores.unidadeId,
            db
              .select({ id: unidades.id })
              .from(unidades)
              .where(
                and(
                  eq(unidades.condominioId, condominioId),
                  eq(unidades.id, moradores.unidadeId),
                ),
              )
              .limit(1)
              .as("unidade_subquery").id,
          ),
        ),
      )
      .limit(1)

    if (!morador) {
      throw new ForbiddenException(
        "Morador não encontrado ou não vinculado a este condomínio",
      )
    }

    // Busca todas as unidades do morador (pode haver mais de uma)
    const unidadesRows = await db
      .select({
        id: unidades.id,
        label: unidades.label,
        tipo: unidades.tipo,
      })
      .from(unidades)
      .where(
        and(
          eq(unidades.condominioId, condominioId),
          eq(unidades.ativo, true),
          // Unidades onde o morador está vinculado
          inArray(
            unidades.id,
            db
              .select({ unidadeId: moradores.unidadeId })
              .from(moradores)
              .where(
                and(
                  eq(moradores.ativo, true),
                  or(...condicoesBusca),
                ),
              ),
          ),
        ),
      )

    return {
      moradorId: morador.id,
      moradorNome: morador.nome,
      condominioId,
      unidades: unidadesRows,
    }
  }

  /**
   * Lista encomendas das unidades do morador autenticado.
   *
   * Filtros suportados:
   * - status: filtra por status específico
   * - grupo: filtra por grupo (aguardando, prontas, historico)
   * - limit/offset: paginação
   *
   * Retorna encomendas com dados da transportadora e unidade para exibição
   * em cards na interface do morador.
   */
  async listarEncomendas(
    projeto: ProjetoResumo,
    usuario: UsuarioAutenticado,
    query: EncomendasMoradorQuery,
  ): Promise<{ encomendas: EncomendaMoradorResult[]; total: number }> {
    const { condominioId, unidades } = await this.obterMoradorComUnidades(
      projeto,
      usuario,
    )

    if (unidades.length === 0) {
      return { encomendas: [], total: 0 }
    }

    const db = await this.dbDoProjeto(projeto)
    const unidadeIds = unidades.map((u) => u.id)

    // Monta condições de filtro
    const condicoes: SQL[] = [
      eq(encomendas.condominioId, condominioId),
      inArray(encomendas.unidadeId, unidadeIds),
    ]

    // Filtro por status específico ou grupo
    if (query.status) {
      condicoes.push(eq(encomendas.status, query.status))
    } else if (query.grupo) {
      const statusDoGrupo = grupoParaStatus(query.grupo)
      condicoes.push(inArray(encomendas.status, statusDoGrupo))
    }

    const onde = and(...condicoes)

    // Conta total para paginação
    const [countResult] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(encomendas)
      .where(onde)

    const total = countResult?.count ?? 0

    // Busca encomendas com dados da transportadora
    const encomendasRows = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        fotoUrl: encomendas.fotoUrl,
        transportadoraId: encomendas.transportadoraId,
        codigoRastreamento: encomendas.codigoRastreamento,
        unidadeId: encomendas.unidadeId,
        registradoEm: encomendas.createdAt,
        confirmadoEm: encomendas.confirmadoEm,
        entregueEm: encomendas.entregueEm,
        canceladoEm: encomendas.canceladoEm,
        observacoes: encomendas.observacoes,
      })
      .from(encomendas)
      .where(onde)
      .orderBy(desc(encomendas.createdAt))
      .limit(query.limit)
      .offset(query.offset)

    if (encomendasRows.length === 0) {
      return { encomendas: [], total }
    }

    // Busca transportadoras e unidades para enriquecer resposta
    const transportadoraIds = encomendasRows
      .map((e) => e.transportadoraId)
      .filter((id): id is number => id !== null)

    const transportadorasMap = new Map<number, { id: number; nome: string }>()
    if (transportadoraIds.length > 0) {
      const transportadorasRows = await db
        .select({ id: transportadoras.id, nome: transportadoras.nome })
        .from(transportadoras)
        .where(inArray(transportadoras.id, transportadoraIds))
      for (const t of transportadorasRows) {
        transportadorasMap.set(t.id, { id: t.id, nome: t.nome })
      }
    }

    const unidadesMap = new Map<number, { id: number; label: string | null; tipo: "apartamento" | "casa" }>()
    for (const u of unidades) {
      unidadesMap.set(u.id, { id: u.id, label: u.label, tipo: u.tipo })
    }

    // Monta resultado
    const encomendasResult: EncomendaMoradorResult[] = encomendasRows.map((e) => ({
      id: e.id,
      status: e.status,
      fotoUrl: e.fotoUrl,
      transportadora: e.transportadoraId
        ? transportadorasMap.get(e.transportadoraId) ?? null
        : null,
      codigoRastreamento: e.codigoRastreamento,
      unidade: unidadesMap.get(e.unidadeId) ?? {
        id: e.unidadeId,
        label: null,
        tipo: "apartamento" as const,
      },
      registradoEm: e.registradoEm,
      confirmadoEm: e.confirmadoEm,
      entregueEm: e.entregueEm,
      canceladoEm: e.canceladoEm,
      observacoes: e.observacoes,
    }))

    return { encomendas: encomendasResult, total }
  }

  /**
   * Confirma o reconhecimento da encomenda pelo morador.
   *
   * Validações:
   * - Encomenda pertence a uma das unidades do morador
   * - Encomenda está com status "pendente" (aguardando confirmação)
   * - Morador está autenticado e vinculado ao condomínio
   *
   * Ações:
   * - Muda status para "pronta_retirada"
   * - Grava confirmadoEm e confirmadoPorId
   * - Cria notificação do tipo "encomenda_pronta_retirada"
   *
   * IMPORTANTE: Esta ação NÃO marca entrega. A entrega física continua
   * sendo ato exclusivo da portaria (via tabela entregas).
   */
  async confirmarReconhecimento(
    projeto: ProjetoResumo,
    usuario: UsuarioAutenticado,
    encomendaId: number,
  ): Promise<ConfirmarReconhecimentoResult> {
    const { moradorId, condominioId, unidades } = await this.obterMoradorComUnidades(
      projeto,
      usuario,
    )

    if (unidades.length === 0) {
      throw new ForbiddenException("Morador sem unidades vinculadas")
    }

    const db = await this.dbDoProjeto(projeto)
    const unidadeIds = unidades.map((u) => u.id)

    // Busca encomenda e valida pertencimento
    const [encomenda] = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        unidadeId: encomendas.unidadeId,
        condominioId: encomendas.condominioId,
      })
      .from(encomendas)
      .where(eq(encomendas.id, encomendaId))
      .limit(1)

    if (!encomenda) {
      throw new NotFoundException("Encomenda não encontrada")
    }

    // Valida que a encomenda pertence ao condomínio
    if (encomenda.condominioId !== condominioId) {
      throw new ForbiddenException("Encomenda não pertence a este condomínio")
    }

    // Valida que a encomenda pertence a uma das unidades do morador
    if (!unidadeIds.includes(encomenda.unidadeId)) {
      throw new ForbiddenException(
        "Encomenda não pertence a uma das suas unidades",
      )
    }

    // Valida que a encomenda está pendente (aguardando confirmação)
    if (encomenda.status !== "pendente") {
      throw new BadRequestException(
        `Encomenda não está pendente de confirmação (status atual: ${encomenda.status})`,
      )
    }

    // Atualiza status para pronta_retirada
    const agora = new Date()
    await db
      .update(encomendas)
      .set({
        status: "pronta_retirada",
        confirmadoEm: agora,
        confirmadoPorId: moradorId,
      })
      .where(eq(encomendas.id, encomendaId))

    // Cria notificação para o morador
    const resultadoNotificacao = await db
      .insert(notificacoes)
      .values({
        moradorId,
        encomendaId,
        tipo: "encomenda_pronta_retirada",
        mensagem: "Você confirmou o reconhecimento da encomenda. Retire na portaria.",
        lida: false,
      })

    const notificacaoId = Number(resultadoNotificacao[0].insertId)

    return {
      encomenda: {
        id: encomendaId,
        status: "pronta_retirada",
        confirmadoEm: agora,
      },
      notificacao: {
        id: notificacaoId,
        tipo: "encomenda_pronta_retirada",
      },
    }
  }
}

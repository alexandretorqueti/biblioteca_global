/**
 * OcorrenciasService — lógica de registro de ocorrências/devoluções.
 *
 * Endpoints suportados:
 * - registrar: cria ocorrência vinculada à encomenda, atualiza status da
 *   encomenda para 'cancelada' quando aplicável, aciona notificação para
 *   moradores ativos da unidade, e registra auditoria completa.
 * - listarPorEncomenda: retorna histórico de ocorrências de uma encomenda
 *   (para portaria e morador, respeitando permissões).
 *
 * Segurança:
 * - Todas as consultas são filtradas pelo condominioId do token (via
 *   ProjetoResumo), impedindo acesso a dados de outros condomínios.
 * - A criação valida que encomendaId pertence ao condomínio autorizado.
 * - Notificação é enviada apenas para moradores da unidade afetada.
 *
 * Auditoria:
 * - Toda ocorrência registra: funcionário responsável, data/hora, motivo,
 *   tipo, evidência (foto), e resultado (devolvida ou não).
 * - Histórico é imutável (não há edição/exclusão de ocorrências).
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { and, eq, desc } from "drizzle-orm"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import {
  condominios,
  unidades,
  moradores,
  funcionarios,
  encomendas,
  notificacoes,
  ocorrencias,
} from "../../../../../projects/taqui/schema"
import { ehErroDatabaseAusente } from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import type {
  RegistroOcorrenciaBody,
  TipoOcorrencia,
} from "./dto/registro-ocorrencia-body.dto"

/** Resultado do registro de ocorrência. */
export interface RegistroOcorrenciaResult {
  ocorrencia: Record<string, unknown>
  encomenda: {
    id: number
    status: string
    atualizado: boolean
  }
  notificacao: {
    enviada: boolean
    totalMoradores: number
    erro?: string
  }
}

/** Item do histórico de ocorrências. */
export interface OcorrenciaHistoricoItem {
  id: number
  tipo: TipoOcorrencia
  tipoLabel: string
  motivo: string
  descricao: string | null
  fotoEvidenciaUrl: string | null
  observacoes: string | null
  devolvidaTransportadora: boolean
  dataOcorrencia: string
  registradoPorNome: string
  createdAt: string
}

/** Labels amigáveis para os tipos de ocorrência. */
const TIPOS_LABELS: Record<TipoOcorrencia, string> = {
  devolucao_transportadora: "Devolução pela transportadora",
  extravio: "Extravio",
  recusada: "Recusada pelo morador",
  endereco_incorreto: "Endereço incorreto",
  outro: "Outro",
}

@Injectable()
export class OcorrenciasService {
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
   * Busca o condomínio do contexto autorizado.
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
   * Registra ocorrência e notifica moradores da unidade afetada.
   *
   * Validações:
   * - encomendaId pertence ao condomínio autorizado
   * - registradoPorId é funcionário ativo do condomínio (via contexto)
   * - tipo é válido
   * - motivo tem mínimo 10 caracteres
   * - descricao é obrigatória quando tipo = 'outro'
   *
   * Fluxo:
   * 1. Valida encomenda e condomínio
   * 2. Cria registro de ocorrência com auditoria completa
   * 3. Atualiza status da encomenda para 'cancelada' (se aplicável)
   * 4. Busca moradores ativos da unidade
   * 5. Cria notificação para cada morador com motivo e resultado
   */
  async registrar(
    projeto: ProjetoResumo,
    body: RegistroOcorrenciaBody,
    funcionarioId: number,
  ): Promise<RegistroOcorrenciaResult> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // Valida encomenda pertence ao condomínio
    const [encomenda] = await db
      .select({
        id: encomendas.id,
        condominioId: encomendas.condominioId,
        unidadeId: encomendas.unidadeId,
        status: encomendas.status,
      })
      .from(encomendas)
      .where(
        and(
          eq(encomendas.id, body.encomendaId),
          eq(encomendas.condominioId, condominioId),
        ),
      )
      .limit(1)
    if (!encomenda) {
      throw new BadRequestException(
        "Encomenda não encontrada ou não pertence a este condomínio",
      )
    }

    // Valida funcionário registradoPor pertence ao condomínio e está ativo
    const [funcionario] = await db
      .select({ id: funcionarios.id, nome: funcionarios.nome })
      .from(funcionarios)
      .where(
        and(
          eq(funcionarios.id, funcionarioId),
          eq(funcionarios.condominioId, condominioId),
          eq(funcionarios.ativo, true),
        ),
      )
      .limit(1)
    if (!funcionario) {
      throw new BadRequestException(
        "Funcionário não encontrado, inativo ou não pertence a este condomínio",
      )
    }

    // Determina se deve cancelar a encomenda
    // Tipos que resultam em cancelamento: devolucao_transportadora, extravio, recusada
    const deveCancelar = [
      "devolucao_transportadora",
      "extravio",
      "recusada",
    ].includes(body.tipo)

    // Cria ocorrência
    const dataOcorrencia = body.dataOcorrencia ?? new Date()
    const resultadoOcorrencia = await db.insert(ocorrencias).values({
      encomendaId: body.encomendaId,
      condominioId,
      registradoPorId: funcionarioId,
      tipo: body.tipo,
      motivo: body.motivo,
      descricao: body.descricao ?? null,
      fotoEvidenciaUrl: body.fotoEvidenciaUrl ?? null,
      observacoes: body.observacoes ?? null,
      devolvidaTransportadora: body.devolvidaTransportadora,
      dataOcorrencia,
    })

    const ocorrenciaId = Number(resultadoOcorrencia[0].insertId)

    // Atualiza encomenda se deve cancelar
    let encomendaAtualizada = false
    if (deveCancelar && encomenda.status !== "cancelada") {
      await db
        .update(encomendas)
        .set({
          status: "cancelada",
          canceladoPorId: funcionarioId,
          canceladoEm: dataOcorrencia,
          motivoCancelamento: body.motivo.substring(0, 500),
        })
        .where(eq(encomendas.id, body.encomendaId))
      encomendaAtualizada = true
    }

    // Busca unidade para mensagem da notificação
    const [unidade] = await db
      .select({ id: unidades.id, label: unidades.label })
      .from(unidades)
      .where(eq(unidades.id, encomenda.unidadeId))
      .limit(1)

    // Busca moradores ativos da unidade para notificação
    const moradoresAtivos = await db
      .select({ id: moradores.id, nome: moradores.nome })
      .from(moradores)
      .where(
        and(
          eq(moradores.unidadeId, encomenda.unidadeId),
          eq(moradores.ativo, true),
        ),
      )

    // Aciona notificação para cada morador ativo
    let notificacaoErro: string | undefined
    let notificacaoEnviada = true
    const totalMoradores = moradoresAtivos.length

    if (totalMoradores > 0) {
      try {
        const tipoLabel = TIPOS_LABELS[body.tipo]
        const mensagem = this.construirMensagemNotificacao(
          tipoLabel,
          body.motivo,
          unidade?.label,
          deveCancelar,
        )

        const notificacoesValues = moradoresAtivos.map((m) => ({
          moradorId: m.id,
          encomendaId: body.encomendaId,
          tipo: "ocorrencia_registrada" as const,
          mensagem,
          lida: false,
        }))
        await db.insert(notificacoes).values(notificacoesValues)
      } catch (erro: unknown) {
        notificacaoEnviada = false
        notificacaoErro = erro instanceof Error ? erro.message : String(erro)
        console.error(
          `[Ocorrencias] Falha ao criar notificação para ocorrência ${ocorrenciaId}: ${notificacaoErro}`,
        )
      }
    }

    // Busca ocorrência criada para retornar
    const [ocorrenciaCriada] = await db
      .select()
      .from(ocorrencias)
      .where(eq(ocorrencias.id, ocorrenciaId))
      .limit(1)

    return {
      ocorrencia: ocorrenciaCriada as Record<string, unknown>,
      encomenda: {
        id: body.encomendaId,
        status: deveCancelar ? "cancelada" : encomenda.status,
        atualizado: encomendaAtualizada,
      },
      notificacao: {
        enviada: notificacaoEnviada && totalMoradores > 0,
        totalMoradores,
        erro: notificacaoErro,
      },
    }
  }

  /**
   * Lista histórico de ocorrências de uma encomenda.
   *
   * Respeita isolamento multi-tenant: só retorna ocorrências do condomínio
   * do contexto autorizado.
   */
  async listarPorEncomenda(
    projeto: ProjetoResumo,
    encomendaId: number,
  ): Promise<OcorrenciaHistoricoItem[]> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // Valida encomenda pertence ao condomínio
    const [encomenda] = await db
      .select({ id: encomendas.id })
      .from(encomendas)
      .where(
        and(
          eq(encomendas.id, encomendaId),
          eq(encomendas.condominioId, condominioId),
        ),
      )
      .limit(1)
    if (!encomenda) {
      throw new NotFoundException(
        "Encomenda não encontrada ou não pertence a este condomínio",
      )
    }

    // Busca ocorrências com dados do funcionário
    const ocorrenciasRows = await db
      .select({
        id: ocorrencias.id,
        tipo: ocorrencias.tipo,
        motivo: ocorrencias.motivo,
        descricao: ocorrencias.descricao,
        fotoEvidenciaUrl: ocorrencias.fotoEvidenciaUrl,
        observacoes: ocorrencias.observacoes,
        devolvidaTransportadora: ocorrencias.devolvidaTransportadora,
        dataOcorrencia: ocorrencias.dataOcorrencia,
        createdAt: ocorrencias.createdAt,
        registradoPorId: ocorrencias.registradoPorId,
      })
      .from(ocorrencias)
      .where(
        and(
          eq(ocorrencias.encomendaId, encomendaId),
          eq(ocorrencias.condominioId, condominioId),
        ),
      )
      .orderBy(desc(ocorrencias.dataOcorrencia))

    if (ocorrenciasRows.length === 0) {
      return []
    }

    // Busca nomes dos funcionários
    const funcionarioIds = [...new Set(ocorrenciasRows.map((o) => o.registradoPorId))]
    const funcionariosRows = await db
      .select({ id: funcionarios.id, nome: funcionarios.nome })
      .from(funcionarios)
      .where(
        sql`${funcionarios.id} IN (${sql.join(funcionarioIds.map((id) => sql`${id}`), sql`, `)})`,
      )

    const funcionariosMap = new Map(funcionariosRows.map((f) => [f.id, f.nome]))

    return ocorrenciasRows.map((o) => ({
      id: o.id,
      tipo: o.tipo,
      tipoLabel: TIPOS_LABELS[o.tipo],
      motivo: o.motivo,
      descricao: o.descricao,
      fotoEvidenciaUrl: o.fotoEvidenciaUrl,
      observacoes: o.observacoes,
      devolvidaTransportadora: o.devolvidaTransportadora,
      dataOcorrencia: o.dataOcorrencia.toISOString(),
      registradoPorNome: funcionariosMap.get(o.registradoPorId) ?? "Desconhecido",
      createdAt: o.createdAt.toISOString(),
    }))
  }

  /**
   * Lista ocorrências do condomínio com paginação.
   */
  async listar(
    projeto: ProjetoResumo,
    options: {
      limit?: number
      offset?: number
      encomendaId?: number
      tipo?: TipoOcorrencia
    } = {},
  ): Promise<{ itens: OcorrenciaHistoricoItem[]; total: number }> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    const limit = options.limit ?? 50
    const offset = options.offset ?? 0

    // Condições de filtro
    const condicoes = [eq(ocorrencias.condominioId, condominioId)]
    if (options.encomendaId) {
      condicoes.push(eq(ocorrencias.encomendaId, options.encomendaId))
    }
    if (options.tipo) {
      condicoes.push(eq(ocorrencias.tipo, options.tipo))
    }

    const onde = and(...condicoes)

    // Conta total
    const [countResult] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(ocorrencias)
      .where(onde)

    const total = countResult?.count ?? 0

    if (total === 0) {
      return { itens: [], total: 0 }
    }

    // Busca ocorrências paginadas
    const ocorrenciasRows = await db
      .select({
        id: ocorrencias.id,
        tipo: ocorrencias.tipo,
        motivo: ocorrencias.motivo,
        descricao: ocorrencias.descricao,
        fotoEvidenciaUrl: ocorrencias.fotoEvidenciaUrl,
        observacoes: ocorrencias.observacoes,
        devolvidaTransportadora: ocorrencias.devolvidaTransportadora,
        dataOcorrencia: ocorrencias.dataOcorrencia,
        createdAt: ocorrencias.createdAt,
        registradoPorId: ocorrencias.registradoPorId,
      })
      .from(ocorrencias)
      .where(onde)
      .orderBy(desc(ocorrencias.dataOcorrencia))
      .limit(limit)
      .offset(offset)

    if (ocorrenciasRows.length === 0) {
      return { itens: [], total }
    }

    // Busca nomes dos funcionários
    const funcionarioIds = [...new Set(ocorrenciasRows.map((o) => o.registradoPorId))]
    const funcionariosRows = await db
      .select({ id: funcionarios.id, nome: funcionarios.nome })
      .from(funcionarios)
      .where(
        sql`${funcionarios.id} IN (${sql.join(funcionarioIds.map((id) => sql`${id}`), sql`, `)})`,
      )

    const funcionariosMap = new Map(funcionariosRows.map((f) => [f.id, f.nome]))

    const itens = ocorrenciasRows.map((o) => ({
      id: o.id,
      tipo: o.tipo,
      tipoLabel: TIPOS_LABELS[o.tipo],
      motivo: o.motivo,
      descricao: o.descricao,
      fotoEvidenciaUrl: o.fotoEvidenciaUrl,
      observacoes: o.observacoes,
      devolvidaTransportadora: o.devolvidaTransportadora,
      dataOcorrencia: o.dataOcorrencia.toISOString(),
      registradoPorNome: funcionariosMap.get(o.registradoPorId) ?? "Desconhecido",
      createdAt: o.createdAt.toISOString(),
    }))

    return { itens, total }
  }

  /**
   * Constrói mensagem amigável para notificação do morador.
   */
  private construirMensagemNotificacao(
    tipoLabel: string,
    motivo: string,
    unidadeLabel: string | null | undefined,
    foiCancelada: boolean,
  ): string {
    const unidadeInfo = unidadeLabel ? ` para ${unidadeLabel}` : ""
    const acao = foiCancelada
      ? "Encomenda cancelada"
      : "Ocorrência registrada"

    // Trunca motivo se muito longo para caber no campo de 500 chars
    const motivoTruncado = motivo.length > 200 ? motivo.substring(0, 197) + "..." : motivo

    return `${acao}${unidadeInfo}. Tipo: ${tipoLabel}. Motivo: ${motivoTruncado}`
  }
}

// Import necessário para sql template literal
import { sql } from "drizzle-orm"

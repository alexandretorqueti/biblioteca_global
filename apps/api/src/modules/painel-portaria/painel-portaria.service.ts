/**
 * PainelPortariaService — lógica do painel da portaria.
 *
 * Endpoints suportados:
 * - listarEncomendas: lista encomendas filtradas por estado operacional,
 *   transportadora, localização da unidade, período e busca textual.
 *   Ordena por prioridade operacional (pendências antigas primeiro).
 * - obterDetalhe: retorna encomenda com foto, destino (unidade + moradores)
 *   e transportadora.
 * - registrarEntrega: valida status=confirmada, cria registro na tabela
 *   entregas com evidência completa, atualiza encomenda para status=entregue.
 * - reenviarAviso: reenvia notificação ao morador para encomendas pendentes
 *   ou confirmadas. Bloqueia entregues/canceladas com mensagem clara.
 * - obterIndicadores: contadores de chegadas hoje, aguardando confirmação,
 *   prontas para retirada, entregues hoje e pendências antigas.
 *
 * Segurança:
 * - Todas as consultas são filtradas pelo condominioId do token (via
 *   ProjetoResumo), impedindo acesso a dados de outros condomínios.
 * - O condominioId é obtido do primeiro condomínio ativo do database do
 *   projeto (TaQui é 1 condomínio = 1 projeto).
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { and, eq, like, sql, desc, asc, or, gte, lte, inArray } from "drizzle-orm"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import {
  condominios,
  unidades,
  moradores,
  funcionarios,
  transportadoras,
  encomendas,
  notificacoes,
  entregas,
} from "../../../../../projects/taqui/schema"
import { ehErroDatabaseAusente } from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import type { PainelPortariaQuery } from "./dto/painel-portaria-query.dto"
import type { EntregaBody } from "./dto/entrega-body.dto"
import type { ReenviarAvisoBody } from "./dto/reenviar-aviso-body.dto"

// ============================================================================
// TIPOS DE RESPOSTA
// ============================================================================

/** Estado operacional legível para o painel. */
export type EstadoOperacional =
  | "aguardando_confirmacao"
  | "pronta_retirada"
  | "excecao"
  | "entregue"

/** Indicadores do painel (contadores). */
export interface IndicadoresPainel {
  /** Encomendas registradas hoje (qualquer status). */
  chegadasHoje: number
  /** Status = pendente (aguardando confirmação do morador). */
  aguardandoConfirmacao: number
  /** Status = confirmada (prontas para retirada física). */
  prontasParaRetirada: number
  /** Status = entregue, entreguesEm = hoje. */
  entreguesHoje: number
  /** Pendentes com mais de 3 dias (pendências antigas). */
  pendenciasAntigas: number
}

/** Item da lista de encomendas no painel. */
export interface EncomendaPainelItem {
  id: number
  status: "pendente" | "confirmada" | "entregue" | "cancelada"
  estadoOperacional: EstadoOperacional
  fotoUrl: string | null
  codigoRastreamento: string | null
  /** Identificação amigável da unidade destino. */
  unidadeLabel: string | null
  /** Nome da transportadora (se vinculada). */
  transportadoraNome: string | null
  /** Minutos desde a chegada (createdAt). */
  minutosDesdeChegada: number
  /** Data/hora da chegada (ISO 8601). */
  chegadaEm: string
  /** Morador que confirmou (se aplicável). */
  confirmadoPorNome: string | null
  /** Data/hora da confirmação (se aplicável). */
  confirmadoEm: string | null
  /** Data/hora da entrega (se aplicável). */
  entregueEm: string | null
  observacoes: string | null
}

/** Detalhe completo da encomenda (foto + destino). */
export interface EncomendaDetalhe {
  id: number
  status: "pendente" | "confirmada" | "entregue" | "cancelada"
  estadoOperacional: EstadoOperacional
  fotoUrl: string | null
  codigoRastreamento: string | null
  observacoes: string | null
  chegadaEm: string
  minutosDesdeChegada: number
  /** Dados da unidade destino. */
  unidade: {
    id: number
    label: string | null
    tipo: "apartamento" | "casa"
    rua: string | null
    bloco: string | null
    andar: number | null
    numero: string | null
    quadra: string | null
    lote: string | null
  }
  /** Moradores ativos da unidade. */
  moradores: Array<{
    id: number
    nome: string
    telefone: string | null
    email: string | null
  }>
  /** Transportadora (se vinculada). */
  transportadora: {
    id: number
    nome: string
    cnpj: string | null
    telefone: string | null
  } | null
  /** Funcionário que registrou. */
  registradoPor: {
    id: number
    nome: string
  }
  /** Morador que confirmou (se aplicável). */
  confirmadoPor: {
    id: number
    nome: string
  } | null
  confirmadoEm: string | null
  /** Dados da entrega (se aplicável). */
  entrega: {
    id: number
    funcionarioId: number
    funcionarioNome: string
    dataHoraEntrega: string
    evidenciaQuemRetirou: string | null
  } | null
}

/** Resultado do registro de entrega. */
export interface EntregaResult {
  encomenda: {
    id: number
    status: "entregue"
    entreguePorId: number
    entregueEm: string
  }
  entrega: {
    id: number
    encomendaId: number
    funcionarioId: number
    dataHoraEntrega: string
    evidenciaQuemRetirou: string
  }
}

/** Resultado do reenvio de aviso. */
export interface ReenviarAvisoResult {
  sucesso: true
  notificacoesCriadas: number
  notificacoes: Array<{
    id: number
    moradorId: number
    moradorNome: string
    tipo: string
    mensagem: string
  }>
}

// ============================================================================
// SERVICE
// ============================================================================

/** Limite de dias para considerar pendência antiga. */
const DIAS_PENDENCIA_ANTIGA = 3

@Injectable()
export class PainelPortariaService {
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
   * Obtém o condomínio ativo do database do projeto.
   * TaQui é 1 condomínio = 1 projeto.
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
   * Classifica o status da encomenda em estado operacional legível.
   */
  private classificarEstado(
    status: "pendente" | "confirmada" | "entregue" | "cancelada",
    createdAt: Date,
  ): EstadoOperacional {
    if (status === "pendente") {
      const diasDesdeCriacao =
        (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
      return diasDesdeCriacao >= DIAS_PENDENCIA_ANTIGA
        ? "excecao"
        : "aguardando_confirmacao"
    }
    if (status === "confirmada") return "pronta_retirada"
    if (status === "entregue") return "entregue"
    // cancelada
    return "excecao"
  }

  // ==========================================================================
  // INDICADORES
  // ==========================================================================

  /**
   * Obtém contadores do painel: chegadas hoje, aguardando confirmação,
   * prontas para retirada, entregues hoje e pendências antigas.
   */
  async obterIndicadores(
    projeto: ProjetoResumo,
  ): Promise<IndicadoresPainel> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    const agora = new Date()
    const inicioHoje = new Date(agora)
    inicioHoje.setHours(0, 0, 0, 0)

    const limitePendenciasAntigas = new Date(agora)
    limitePendenciasAntigas.setDate(
      limitePendenciasAntigas.getDate() - DIAS_PENDENCIA_ANTIGA,
    )

    // Busca todas as encomendas do condomínio em um único query para
    // calcular todos os indicadores de forma eficiente.
    const todasEncomendas = await db
      .select({
        status: encomendas.status,
        createdAt: encomendas.createdAt,
        entregueEm: encomendas.entregueEm,
      })
      .from(encomendas)
      .where(eq(encomendas.condominioId, condominioId))

    let chegadasHoje = 0
    let aguardandoConfirmacao = 0
    let prontasParaRetirada = 0
    let entreguesHoje = 0
    let pendenciasAntigas = 0

    for (const enc of todasEncomendas) {
      // Chegadas hoje
      if (enc.createdAt >= inicioHoje) {
        chegadasHoje++
      }

      // Por status
      if (enc.status === "pendente") {
        aguardandoConfirmacao++
        if (enc.createdAt < limitePendenciasAntigas) {
          pendenciasAntigas++
        }
      } else if (enc.status === "confirmada") {
        prontasParaRetirada++
      } else if (enc.status === "entregue") {
        if (enc.entregueEm && enc.entregueEm >= inicioHoje) {
          entreguesHoje++
        }
      }
    }

    return {
      chegadasHoje,
      aguardandoConfirmacao,
      prontasParaRetirada,
      entreguesHoje,
      pendenciasAntigas,
    }
  }

  // ==========================================================================
  // LISTAR ENCOMENDAS
  // ==========================================================================

  /**
   * Lista encomendas filtradas por estado operacional, transportadora,
   * localização, período e busca textual. Ordena por prioridade
   * operacional (pendências antigas → aguardando confirmação → prontas
   * para retirada → entregues).
   *
   * Por padrão, exclui entregues e canceladas da fila ativa (estado=todas
   * ainda exclui entregues/canceladas a menos que um período seja
   * informado).
   */
  async listarEncomendas(
    projeto: ProjetoResumo,
    query: PainelPortariaQuery,
  ): Promise<{ itens: EncomendaPainelItem[]; total: number; indicadores: IndicadoresPainel }> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // Indicadores em paralelo com a lista
    const indicadores = await this.obterIndicadores(projeto)

    // Monta condições de filtro
    const condicoes = [eq(encomendas.condominioId, condominioId)]

    // Filtro por estado operacional
    const limitePendenciasAntigas = new Date()
    limitePendenciasAntigas.setDate(
      limitePendenciasAntigas.getDate() - DIAS_PENDENCIA_ANTIGA,
    )

    if (query.estado === "aguardando_confirmacao") {
      condicoes.push(
        and(
          eq(encomendas.status, "pendente"),
          gte(encomendas.createdAt, limitePendenciasAntigas),
        )!,
      )
    } else if (query.estado === "pronta_retirada") {
      condicoes.push(eq(encomendas.status, "confirmada"))
    } else if (query.estado === "excecoes") {
      // Pendências antigas (pendente > 3 dias) OU canceladas
      condicoes.push(
        or(
          and(
            eq(encomendas.status, "pendente"),
            sql`${encomendas.createdAt} < ${limitePendenciasAntigas}`,
          ),
          eq(encomendas.status, "cancelada"),
        )!,
      )
    } else {
      // "todas" — exclui entregues e canceladas da fila ativa, a menos
      // que o período esteja definido
      if (!query.periodoInicio && !query.periodoFim) {
        condicoes.push(
          inArray(encomendas.status, ["pendente", "confirmada"]),
        )
      }
    }

    // Filtro por transportadora
    if (query.transportadoraId) {
      condicoes.push(eq(encomendas.transportadoraId, query.transportadoraId))
    }

    // Filtro por período
    if (query.periodoInicio) {
      condicoes.push(gte(encomendas.createdAt, new Date(query.periodoInicio)))
    }
    if (query.periodoFim) {
      condicoes.push(lte(encomendas.createdAt, new Date(query.periodoFim)))
    }

    // Filtro por busca textual (código de rastreamento ou ID)
    if (query.busca) {
      const termo = query.busca.trim().toLowerCase()
      const padrao = `%${termo}%`
      condicoes.push(
        or(
          like(sql`lower(${encomendas.codigoRastreamento})`, padrao),
          sql`${encomendas.id} = ${Number(termo) || 0}`,
        )!,
      )
    }

    const onde = and(...condicoes)

    // Query principal com JOIN para obter dados da unidade e transportadora
    const rows = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        fotoUrl: encomendas.fotoUrl,
        codigoRastreamento: encomendas.codigoRastreamento,
        observacoes: encomendas.observacoes,
        createdAt: encomendas.createdAt,
        confirmadoEm: encomendas.confirmadoEm,
        entregueEm: encomendas.entregueEm,
        unidadeLabel: unidades.label,
        transportadoraNome: transportadoras.nome,
        confirmadoPorNome: moradores.nome,
      })
      .from(encomendas)
      .leftJoin(unidades, eq(encomendas.unidadeId, unidades.id))
      .leftJoin(transportadoras, eq(encomendas.transportadoraId, transportadoras.id))
      .leftJoin(moradores, eq(encomendas.confirmadoPorId, moradores.id))
      .where(onde)
      .orderBy(
        // Prioridade operacional:
        // 1. Pendências antigas (pendente + created_at mais antigo)
        // 2. Aguardando confirmação (pendente + created_at mais recente)
        // 3. Prontas para retirada (confirmada)
        // 4. Entregues (se incluídos)
        asc(
          sql`CASE
            WHEN ${encomendas.status} = 'pendente' AND ${encomendas.createdAt} < ${limitePendenciasAntigas} THEN 0
            WHEN ${encomendas.status} = 'pendente' THEN 1
            WHEN ${encomendas.status} = 'confirmada' THEN 2
            WHEN ${encomendas.status} = 'entregue' THEN 3
            WHEN ${encomendas.status} = 'cancelada' THEN 4
            ELSE 5
          END`,
        ),
        asc(encomendas.createdAt),
      )
      .limit(query.limit)
      .offset(query.offset)

    // Filtro adicional por localização (aplicado em memória após JOIN)
    let itensFiltrados = rows
    if (query.localizacao) {
      const termo = query.localizacao.trim().toLowerCase()
      itensFiltrados = rows.filter((r) =>
        r.unidadeLabel?.toLowerCase().includes(termo),
      )
    }

    const itens: EncomendaPainelItem[] = itensFiltrados.map((row) => {
      const estadoOperacional = this.classificarEstado(row.status, row.createdAt)
      const minutosDesdeChegada = Math.floor(
        (Date.now() - row.createdAt.getTime()) / (1000 * 60),
      )

      return {
        id: row.id,
        status: row.status,
        estadoOperacional,
        fotoUrl: row.fotoUrl,
        codigoRastreamento: row.codigoRastreamento,
        unidadeLabel: row.unidadeLabel,
        transportadoraNome: row.transportadoraNome,
        minutosDesdeChegada,
        chegadaEm: row.createdAt.toISOString(),
        confirmadoPorNome: row.confirmadoPorNome ?? null,
        confirmadoEm: row.confirmadoEm?.toISOString() ?? null,
        entregueEm: row.entregueEm?.toISOString() ?? null,
        observacoes: row.observacoes,
      }
    })

    return {
      itens,
      total: itens.length,
      indicadores,
    }
  }

  // ==========================================================================
  // DETALHE
  // ==========================================================================

  /**
   * Obtém detalhe completo da encomenda: foto, destino (unidade + moradores),
   * transportadora, funcionário que registrou e dados de entrega/confirmacao.
   */
  async obterDetalhe(
    projeto: ProjetoResumo,
    encomendaId: number,
  ): Promise<EncomendaDetalhe> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // Busca encomenda com JOINs para dados completos
    const [row] = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        fotoUrl: encomendas.fotoUrl,
        codigoRastreamento: encomendas.codigoRastreamento,
        observacoes: encomendas.observacoes,
        createdAt: encomendas.createdAt,
        confirmadoEm: encomendas.confirmadoEm,
        entregueEm: encomendas.entregueEm,
        entreguePorId: encomendas.entreguePorId,
        confirmadoPorId: encomendas.confirmadoPorId,
        registradoPorId: encomendas.registradoPorId,
        unidadeId: encomendas.unidadeId,
        transportadoraId: encomendas.transportadoraId,
        // Unidade
        unidadeLabel: unidades.label,
        unidadeTipo: unidades.tipo,
        unidadeRua: unidades.rua,
        unidadeBloco: unidades.bloco,
        unidadeAndar: unidades.andar,
        unidadeNumero: unidades.numero,
        unidadeQuadra: unidades.quadra,
        unidadeLote: unidades.lote,
        // Transportadora
        transportadoraNome: transportadoras.nome,
        transportadoraCnpj: transportadoras.cnpj,
        transportadoraTelefone: transportadoras.telefone,
        // Funcionário que registrou
        registradoPorNome: funcionarios.nome,
        // Morador que confirmou
        confirmadoPorNome: moradores.nome,
      })
      .from(encomendas)
      .leftJoin(unidades, eq(encomendas.unidadeId, unidades.id))
      .leftJoin(transportadoras, eq(encomendas.transportadoraId, transportadoras.id))
      .leftJoin(funcionarios, eq(encomendas.registradoPorId, funcionarios.id))
      .leftJoin(moradores, eq(encomendas.confirmadoPorId, moradores.id))
      .where(
        and(
          eq(encomendas.id, encomendaId),
          eq(encomendas.condominioId, condominioId),
        ),
      )
      .limit(1)

    if (!row) {
      throw new NotFoundException(
        "Encomenda não encontrada ou não pertence a este condomínio",
      )
    }

    // Busca moradores ativos da unidade
    const moradoresAtivos = await db
      .select({
        id: moradores.id,
        nome: moradores.nome,
        telefone: moradores.telefone,
        email: moradores.email,
      })
      .from(moradores)
      .where(
        and(
          eq(moradores.unidadeId, row.unidadeId),
          eq(moradores.ativo, true),
        ),
      )

    // Busca registro de entrega (se existir)
    let entregaDetalhe: EncomendaDetalhe["entrega"] = null
    if (row.status === "entregue") {
      const [entregaRow] = await db
        .select({
          id: entregas.id,
          funcionarioId: entregas.funcionarioId,
          dataHoraEntrega: entregas.dataHoraEntrega,
          evidenciaQuemRetirou: entregas.evidenciaQuemRetirou,
        })
        .from(entregas)
        .where(eq(entregas.encomendaId, encomendaId))
        .orderBy(desc(entregas.dataHoraEntrega))
        .limit(1)

      if (entregaRow) {
        // Busca nome do funcionário que entregou
        const [funcEntrega] = await db
          .select({ nome: funcionarios.nome })
          .from(funcionarios)
          .where(eq(funcionarios.id, entregaRow.funcionarioId))
          .limit(1)

        entregaDetalhe = {
          id: entregaRow.id,
          funcionarioId: entregaRow.funcionarioId,
          funcionarioNome: funcEntrega?.nome ?? "Desconhecido",
          dataHoraEntrega: entregaRow.dataHoraEntrega.toISOString(),
          evidenciaQuemRetirou: entregaRow.evidenciaQuemRetirou,
        }
      }
    }

    const estadoOperacional = this.classificarEstado(row.status, row.createdAt)
    const minutosDesdeChegada = Math.floor(
      (Date.now() - row.createdAt.getTime()) / (1000 * 60),
    )

    return {
      id: row.id,
      status: row.status,
      estadoOperacional,
      fotoUrl: row.fotoUrl,
      codigoRastreamento: row.codigoRastreamento,
      observacoes: row.observacoes,
      chegadaEm: row.createdAt.toISOString(),
      minutosDesdeChegada,
      unidade: {
        id: row.unidadeId,
        label: row.unidadeLabel,
        tipo: row.unidadeTipo,
        rua: row.unidadeRua,
        bloco: row.unidadeBloco,
        andar: row.unidadeAndar,
        numero: row.unidadeNumero,
        quadra: row.unidadeQuadra,
        lote: row.unidadeLote,
      },
      moradores: moradoresAtivos.map((m) => ({
        id: m.id,
        nome: m.nome,
        telefone: m.telefone,
        email: m.email,
      })),
      transportadora: row.transportadoraId
        ? {
            id: row.transportadoraId,
            nome: row.transportadoraNome ?? "",
            cnpj: row.transportadoraCnpj,
            telefone: row.transportadoraTelefone,
          }
        : null,
      registradoPor: {
        id: row.registradoPorId,
        nome: row.registradoPorNome ?? "Desconhecido",
      },
      confirmadoPor: row.confirmadoPorId
        ? {
            id: row.confirmadoPorId,
            nome: row.confirmadoPorNome ?? "Desconhecido",
          }
        : null,
      confirmadoEm: row.confirmadoEm?.toISOString() ?? null,
      entrega: entregaDetalhe,
    }
  }

  // ==========================================================================
  // REGISTRAR ENTREGA
  // ==========================================================================

  /**
   * Registra entrega de encomenda. Validações:
   * - Encomenda existe e pertence ao condomínio do token
   * - Status = confirmada (único estado que permite entrega)
   * - FuncionarioId pertence ao condomínio e está ativo
   * - RecebedorNome é obrigatório (evidência mínima)
   *
   * Efeitos:
   * - Cria registro na tabela `entregas` com evidência estruturada (JSON)
   * - Atualiza encomenda: status=entregue, entreguePorId, entregueEm
   * - Cria notificação tipo encomenda_entregue para moradores ativos
   */
  async registrarEntrega(
    projeto: ProjetoResumo,
    encomendaId: number,
    body: EntregaBody,
  ): Promise<EntregaResult> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // 1. Busca encomenda e valida que pertence ao condomínio
    const [encomenda] = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        condominioId: encomendas.condominioId,
        unidadeId: encomendas.unidadeId,
      })
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

    // 2. Valida status — somente confirmada pode ser entregue
    if (encomenda.status === "entregue") {
      throw new ConflictException(
        "Encomenda já foi entregue. Não é possível registrar entrega novamente.",
      )
    }
    if (encomenda.status === "pendente") {
      throw new ConflictException(
        "Encomenda ainda está pendente. O morador precisa confirmar o recebimento antes da entrega física.",
      )
    }
    if (encomenda.status === "cancelada") {
      throw new ConflictException(
        "Encomenda está cancelada. Não é possível entregar encomenda cancelada.",
      )
    }
    if (encomenda.status !== "confirmada") {
      throw new ConflictException(
        `Status atual '${encomenda.status}' não permite entrega. Somente encomendas confirmadas podem ser entregues.`,
      )
    }

    // 3. Valida funcionário pertence ao condomínio e está ativo
    const [funcionario] = await db
      .select({ id: funcionarios.id, nome: funcionarios.nome })
      .from(funcionarios)
      .where(
        and(
          eq(funcionarios.id, body.funcionarioId),
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

    // 4. Monta evidência estruturada (JSON)
    const agora = new Date()
    const evidencia = JSON.stringify({
      recebedorNome: body.recebedorNome,
      recebedorDocumento: body.recebedorDocumento ?? null,
      recebedorVinculo: body.recebedorVinculo ?? null,
      fotoComprovanteUrl: body.fotoComprovanteUrl ?? null,
      funcionarioNome: funcionario.nome,
      dataHora: agora.toISOString(),
      observacoesEntrega: body.observacoesEntrega ?? null,
    })

    // 5. Cria registro na tabela entregas
    const entregaResult = await db.insert(entregas).values({
      encomendaId,
      funcionarioId: body.funcionarioId,
      dataHoraEntrega: agora,
      evidenciaQuemRetirou: evidencia,
    })
    const entregaId = Number(entregaResult[0].insertId)

    // 6. Atualiza encomenda: status=entregue, entreguePorId, entregueEm
    await db
      .update(encomendas)
      .set({
        status: "entregue",
        entreguePorId: body.funcionarioId,
        entregueEm: agora,
      })
      .where(eq(encomendas.id, encomendaId))

    // 7. Cria notificação de entrega para moradores ativos
    try {
      const moradoresAtivos = await db
        .select({ id: moradores.id })
        .from(moradores)
        .where(
          and(
            eq(moradores.unidadeId, encomenda.unidadeId),
            eq(moradores.ativo, true),
          ),
        )

      if (moradoresAtivos.length > 0) {
        const notificacoesValues = moradoresAtivos.map((m) => ({
          moradorId: m.id,
          encomendaId,
          tipo: "encomenda_entregue" as const,
          mensagem: `Sua encomenda foi entregue. Retirada registrada por ${funcionario.nome}.`,
          lida: false,
        }))
        await db.insert(notificacoes).values(notificacoesValues)
      }
    } catch (erro: unknown) {
      // Falha de notificação não impede a entrega — registra no log
      console.error(
        `[PainelPortaria] Falha ao criar notificação de entrega para encomenda ${encomendaId}: ${erro instanceof Error ? erro.message : String(erro)}`,
      )
    }

    // 8. Busca entrega criada para retornar
    const [entregaCriada] = await db
      .select()
      .from(entregas)
      .where(eq(entregas.id, entregaId))
      .limit(1)

    return {
      encomenda: {
        id: encomendaId,
        status: "entregue",
        entreguePorId: body.funcionarioId,
        entregueEm: agora.toISOString(),
      },
      entrega: {
        id: entregaCriada.id,
        encomendaId: entregaCriada.encomendaId,
        funcionarioId: entregaCriada.funcionarioId,
        dataHoraEntrega: entregaCriada.dataHoraEntrega.toISOString(),
        evidenciaQuemRetirou: entregaCriada.evidenciaQuemRetirou ?? "",
      },
    }
  }

  // ==========================================================================
  // REENVIAR AVISO
  // ==========================================================================

  /**
   * Reenvia notificação ao morador sobre encomenda pendente ou confirmada.
   *
   * Validações:
   * - Encomenda existe e pertence ao condomínio
   * - Status = pendente ou confirmada (não faz sentido reenviar para
   *   entregues ou canceladas)
   *
   * Para entregues: retorna ConflictException com mensagem explicando que
   * a encomenda já foi entregue.
   * Para canceladas: retorna ConflictException explicando que a encomenda
   * foi cancelada e não deve ser notificada.
   */
  async reenviarAviso(
    projeto: ProjetoResumo,
    encomendaId: number,
    body: ReenviarAvisoBody,
  ): Promise<ReenviarAvisoResult> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // 1. Busca encomenda e valida que pertence ao condomínio
    const [encomenda] = await db
      .select({
        id: encomendas.id,
        status: encomendas.status,
        unidadeId: encomendas.unidadeId,
      })
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

    // 2. Valida status — somente pendente ou confirmada
    if (encomenda.status === "entregue") {
      throw new ConflictException(
        "Encomenda já foi entregue. Não é necessário reenviar aviso — o morador já retirou.",
      )
    }
    if (encomenda.status === "cancelada") {
      throw new ConflictException(
        "Encomenda está cancelada. Não é possível reenviar aviso para encomenda cancelada.",
      )
    }
    if (encomenda.status !== "pendente" && encomenda.status !== "confirmada") {
      throw new ConflictException(
        `Status atual '${encomenda.status}' não permite reenvio de aviso. Somente encomendas pendentes ou confirmadas.`,
      )
    }

    // 3. Busca moradores ativos da unidade
    const moradoresAtivos = await db
      .select({ id: moradores.id, nome: moradores.nome })
      .from(moradores)
      .where(
        and(
          eq(moradores.unidadeId, encomenda.unidadeId),
          eq(moradores.ativo, true),
        ),
      )

    if (moradoresAtivos.length === 0) {
      return {
        sucesso: true,
        notificacoesCriadas: 0,
        notificacoes: [],
      }
    }

    // 4. Monta mensagem (customizada ou template padrão)
    const tipoNotificacao =
      encomenda.status === "pendente"
        ? "encomenda_pendente"
        : "encomenda_confirmada"

    const mensagemPadrao =
      encomenda.status === "pendente"
        ? "Lembrete: você tem uma encomenda aguardando confirmação na portaria."
        : "Sua encomenda está pronta para retirada na portaria."

    const mensagem = body.mensagemCustom ?? mensagemPadrao

    // 5. Cria notificações
    const notificacoesValues = moradoresAtivos.map((m) => ({
      moradorId: m.id,
      encomendaId,
      tipo: tipoNotificacao as "encomenda_pendente" | "encomenda_confirmada",
      mensagem,
      lida: false,
    }))

    const result = await db.insert(notificacoes).values(notificacoesValues)
    const notificacoesCriadas = result.length ?? moradoresAtivos.length

    // 6. Busca notificações criadas para retornar
    const notificacoesInseridas = await db
      .select({
        id: notificacoes.id,
        moradorId: notificacoes.moradorId,
        tipo: notificacoes.tipo,
        mensagem: notificacoes.mensagem,
      })
      .from(notificacoes)
      .where(eq(notificacoes.encomendaId, encomendaId))
      .orderBy(desc(notificacoes.id))
      .limit(notificacoesCriadas)

    // Busca nomes dos moradores
    const moradorIds = moradoresAtivos.map((m) => m.id)
    const moradoresComNome = await db
      .select({ id: moradores.id, nome: moradores.nome })
      .from(moradores)
      .where(
        sql`${moradores.id} IN (${sql.join(moradorIds.map((id) => sql`${id}`), sql`, `)})`,
      )

    const moradorNomeMap = new Map<number, string>()
    for (const m of moradoresComNome) {
      moradorNomeMap.set(m.id, m.nome)
    }

    return {
      sucesso: true,
      notificacoesCriadas,
      notificacoes: notificacoesInseridas.map((n) => ({
        id: n.id,
        moradorId: n.moradorId,
        moradorNome: moradorNomeMap.get(n.moradorId) ?? "Desconhecido",
        tipo: n.tipo,
        mensagem: n.mensagem,
      })),
    }
  }
}
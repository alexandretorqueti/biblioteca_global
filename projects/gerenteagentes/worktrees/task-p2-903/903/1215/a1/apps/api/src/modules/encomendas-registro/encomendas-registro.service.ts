/**
 * EncomendasRegistroService — lógica do registro rápido de encomendas.
 *
 * Endpoints suportados:
 * - buscarUnidades: busca unidades do condomínio por múltiplos critérios
 *   (label, rua, bloco, numero, quadra, lote, nome de morador).
 * - buscarTransportadoras: busca transportadoras com recorrência (frequência
 *   de uso nas encomendas recentes do condomínio).
 * - registrar: cria encomenda pendente, aciona notificação para moradores
 *   ativos da unidade, e trata falha de notificação de forma recuperável.
 *
 * Segurança:
 * - Todas as consultas são filtradas pelo condominioId do token (via
 *   ProjetoResumo), impedindo acesso a dados de outros condomínios.
 * - A criação valida que unidadeId e registradoPorId pertencem ao
 *   condomínio autorizado antes de inserir.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { and, eq, like, or, sql, desc } from "drizzle-orm"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import {
  condominios,
  unidades,
  moradores,
  funcionarios,
  transportadoras,
  encomendas,
  notificacoes,
} from "../../../../../projects/taqui/schema"
import { ehErroDatabaseAusente } from "../../common/erros"
import { PROJECT_DB_FACTORY, type ProjectDbFactory } from "../crud/project-db.factory"
import type {
  BuscaUnidadesQuery,
} from "./dto/busca-unidades-query.dto"
import type {
  BuscaTransportadorasQuery,
} from "./dto/busca-transportadoras-query.dto"
import type {
  RegistroEncomendaBody,
} from "./dto/registro-encomenda-body.dto"

/** Resultado do registro de encomenda. */
export interface RegistroEncomendaResult {
  encomenda: Record<string, unknown>
  notificacao: {
    enviada: boolean
    totalMoradores: number
    erro?: string
  }
}

/** Unidade retornada pela busca (identificação amigável, sem IDs técnicos). */
export interface UnidadeBuscaResult {
  id: number
  label: string | null
  tipo: "apartamento" | "casa"
  rua: string | null
  bloco: string | null
  andar: number | null
  numero: string | null
  quadra: string | null
  lote: string | null
  moradores: Array<{
    id: number
    nome: string
    ativo: boolean
  }>
}

/** Transportadora com indicador de recorrência. */
export interface TransportadoraBuscaResult {
  id: number
  nome: string
  cnpj: string | null
  telefone: string | null
  /** Quantidade de encomendas recentes (últimos 30 dias) desta transportadora no condomínio. */
  frequencia: number
}

@Injectable()
export class EncomendasRegistroService {
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
   * Busca o condomínio do contexto autorizado. Como o schema do TaQui é
   * multi-condomínio e o token já carrega o projeto, precisamos localizar
   * o condomínio correspondente. Para o TaQui, o condomínio é único por
   * projeto (1 condomínio = 1 projeto TaQui), então buscamos o primeiro
   * condomínio ativo do database do projeto.
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
   * Busca unidades do condomínio por múltiplos critérios.
   *
   * Critérios de busca (OR):
   * - label (identificação amigável)
   * - rua, bloco, numero (apartamento)
   * - quadra, lote (casa)
   * - nome de morador ativo (via JOIN)
   *
   * Retorna unidades com moradores ativos para confirmação visual do destino.
   */
  async buscarUnidades(
    projeto: ProjetoResumo,
    query: BuscaUnidadesQuery,
  ): Promise<UnidadeBuscaResult[]> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    const termo = query.q?.trim().toLowerCase()
    const padrao = termo ? `%${termo}%` : undefined

    // Condições de filtro
    const condicoes = [eq(unidades.condominioId, condominioId)]
    if (query.ativo !== undefined && query.ativo !== null) {
      condicoes.push(eq(unidades.ativo, query.ativo))
    }
    if (query.tipo) {
      condicoes.push(eq(unidades.tipo, query.tipo))
    }

    // Busca textual: OR em label, rua, bloco, numero, quadra, lote
    if (padrao) {
      const buscaCols = [
        like(sql`lower(${unidades.label})`, padrao),
        like(sql`lower(${unidades.rua})`, padrao),
        like(sql`lower(${unidades.bloco})`, padrao),
        like(sql`lower(${unidades.numero})`, padrao),
        like(sql`lower(${unidades.quadra})`, padrao),
        like(sql`lower(${unidades.lote})`, padrao),
      ]
      const buscaOr = or(...buscaCols)
      if (buscaOr) {
        condicoes.push(buscaOr)
      }
    }

    const onde = and(...condicoes)

    // Busca unidades
    const unidadesRows = await db
      .select()
      .from(unidades)
      .where(onde)
      .limit(query.limit)

    if (unidadesRows.length === 0) {
      return []
    }

    // Busca moradores ativos das unidades encontradas
    const unidadeIds = unidadesRows.map((u) => u.id)
    const moradoresRows = await db
      .select({
        id: moradores.id,
        unidadeId: moradores.unidadeId,
        nome: moradores.nome,
        ativo: moradores.ativo,
      })
      .from(moradores)
      .where(
        and(
          sql`${moradores.unidadeId} IN (${sql.join(unidadeIds.map((id) => sql`${id}`), sql`, `)})`,
          eq(moradores.ativo, true),
        ),
      )

    // Se há busca por nome de morador, filtra unidades que têm morador matching
    let unidadesFiltradas = unidadesRows
    if (termo) {
      const moradoresMatching = moradoresRows.filter((m) =>
        m.nome.toLowerCase().includes(termo),
      )
      const unidadeIdsComMoradorMatching = new Set(moradoresMatching.map((m) => m.unidadeId))
      // Mantém unidades que matcharam por label/endereço OU por morador
      const unidadeIdsPorEndereco = new Set(
        unidadesRows
          .filter((u) => {
            const campos = [u.label, u.rua, u.bloco, u.numero, u.quadra, u.lote]
            return campos.some((c) => c?.toLowerCase().includes(termo))
          })
          .map((u) => u.id),
      )
      unidadesFiltradas = unidadesRows.filter(
        (u) => unidadeIdsPorEndereco.has(u.id) || unidadeIdsComMoradorMatching.has(u.id),
      )
    }

    // Monta resultado com moradores agrupados
    const moradoresPorUnidade = new Map<number, Array<{ id: number; nome: string; ativo: boolean }>>()
    for (const m of moradoresRows) {
      if (!unidadesFiltradas.some((u) => u.id === m.unidadeId)) continue
      const lista = moradoresPorUnidade.get(m.unidadeId) ?? []
      lista.push({ id: m.id, nome: m.nome, ativo: m.ativo })
      moradoresPorUnidade.set(m.unidadeId, lista)
    }

    return unidadesFiltradas.map((u) => ({
      id: u.id,
      label: u.label,
      tipo: u.tipo,
      rua: u.rua,
      bloco: u.bloco,
      andar: u.andar,
      numero: u.numero,
      quadra: u.quadra,
      lote: u.lote,
      moradores: moradoresPorUnidade.get(u.id) ?? [],
    }))
  }

  /**
   * Busca transportadoras com indicador de recorrência.
   *
   * A recorrência é calculada pela contagem de encomendas da transportadora
   * no condomínio nos últimos 30 dias. Transportadoras mais frequentes
   * aparecem primeiro (facilita seleção rápida na portaria).
   */
  async buscarTransportadoras(
    projeto: ProjetoResumo,
    query: BuscaTransportadorasQuery,
  ): Promise<TransportadoraBuscaResult[]> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    const termo = query.q?.trim().toLowerCase()
    const padrao = termo ? `%${termo}%` : undefined

    // Condições de filtro
    const condicoes = [eq(transportadoras.ativo, true)]
    if (padrao) {
      const buscaOr = or(
        like(sql`lower(${transportadoras.nome})`, padrao),
        like(sql`lower(${transportadoras.cnpj})`, padrao),
      )
      if (buscaOr) {
        condicoes.push(buscaOr)
      }
    }
    const onde = and(...condicoes)

    // Busca transportadoras ativas
    const transportadorasRows = await db
      .select()
      .from(transportadoras)
      .where(onde)
      .limit(query.limit)

    if (transportadorasRows.length === 0) {
      return []
    }

    // Calcula frequência de uso no condomínio (últimos 30 dias)
    const trintaDiasAtras = new Date()
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30)

    const frequencias = await db
      .select({
        transportadoraId: encomendas.transportadoraId,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(encomendas)
      .where(
        and(
          eq(encomendas.condominioId, condominioId),
          sql`${encomendas.createdAt} >= ${trintaDiasAtras}`,
          sql`${encomendas.transportadoraId} IS NOT NULL`,
        ),
      )
      .groupBy(encomendas.transportadoraId)

    const frequenciaMap = new Map<number, number>()
    for (const f of frequencias) {
      if (f.transportadoraId !== null) {
        frequenciaMap.set(f.transportadoraId, f.count)
      }
    }

    // Monta resultado ordenado por frequência (desc) e nome
    return transportadorasRows
      .map((t) => ({
        id: t.id,
        nome: t.nome,
        cnpj: t.cnpj,
        telefone: t.telefone,
        frequencia: frequenciaMap.get(t.id) ?? 0,
      }))
      .sort((a, b) => {
        if (b.frequencia !== a.frequencia) return b.frequencia - a.frequencia
        return a.nome.localeCompare(b.nome)
      })
  }

  /**
   * Registra encomenda pendente e aciona notificação para moradores ativos.
   *
   * Validações:
   * - unidadeId pertence ao condomínio autorizado
   * - registradoPorId é funcionário ativo do condomínio
   * - transportadoraId (se informado) existe e está ativo
   * - fotoUrl é opcional; se ausente, registra exceção na resposta
   *
   * Notificação:
   * - Cria registro em notificacoes para cada morador ativo da unidade
   * - Falha de notificação é registrada e retornada, mas não impede o registro
   *   (a encomenda é criada mesmo se a notificação falhar)
   */
  async registrar(
    projeto: ProjetoResumo,
    body: RegistroEncomendaBody,
  ): Promise<RegistroEncomendaResult> {
    const condominioId = await this.obterCondominioDoProjeto(projeto)
    const db = await this.dbDoProjeto(projeto)

    // Valida unidade pertence ao condomínio
    const [unidade] = await db
      .select({ id: unidades.id, condominioId: unidades.condominioId, label: unidades.label })
      .from(unidades)
      .where(
        and(
          eq(unidades.id, body.unidadeId),
          eq(unidades.condominioId, condominioId),
        ),
      )
      .limit(1)
    if (!unidade) {
      throw new BadRequestException(
        "Unidade não encontrada ou não pertence a este condomínio",
      )
    }

    // Valida funcionário registradoPor pertence ao condomínio e está ativo
    const [funcionario] = await db
      .select({ id: funcionarios.id })
      .from(funcionarios)
      .where(
        and(
          eq(funcionarios.id, body.registradoPorId),
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

    // Valida transportadora (se informada)
    if (body.transportadoraId) {
      const [transportadora] = await db
        .select({ id: transportadoras.id })
        .from(transportadoras)
        .where(
          and(
            eq(transportadoras.id, body.transportadoraId),
            eq(transportadoras.ativo, true),
          ),
        )
        .limit(1)
      if (!transportadora) {
        throw new BadRequestException("Transportadora não encontrada ou inativa")
      }
    }

    // Registra exceção se foto ausente
    const fotoExcecao = !body.fotoUrl
      ? "Foto não capturada — registro sem evidência fotográfica"
      : undefined

    // Cria encomenda pendente
    const resultado = await db.insert(encomendas).values({
      condominioId,
      unidadeId: body.unidadeId,
      transportadoraId: body.transportadoraId ?? null,
      registradoPorId: body.registradoPorId,
      codigoRastreamento: body.codigoRastreamento ?? null,
      fotoUrl: body.fotoUrl ?? null,
      observacoes: body.observacoes ?? null,
      status: "pendente",
    })

    const encomendaId = Number(resultado[0].insertId)

    // Busca encomenda criada para retornar
    const [encomendaCriada] = await db
      .select()
      .from(encomendas)
      .where(eq(encomendas.id, encomendaId))
      .limit(1)

    // Busca moradores ativos da unidade para notificação
    const moradoresAtivos = await db
      .select({ id: moradores.id, nome: moradores.nome })
      .from(moradores)
      .where(
        and(
          eq(moradores.unidadeId, body.unidadeId),
          eq(moradores.ativo, true),
        ),
      )

    // Aciona notificação para cada morador ativo
    let notificacaoErro: string | undefined
    let notificacaoEnviada = true
    const totalMoradores = moradoresAtivos.length

    if (totalMoradores > 0) {
      try {
        const notificacoesValues = moradoresAtivos.map((m) => ({
          moradorId: m.id,
          encomendaId,
          tipo: "encomenda_pendente" as const,
          mensagem: `Nova encomenda registrada para ${unidade.label ?? "sua unidade"}`,
          lida: false,
        }))
        await db.insert(notificacoes).values(notificacoesValues)
      } catch (erro: unknown) {
        notificacaoEnviada = false
        notificacaoErro = erro instanceof Error ? erro.message : String(erro)
        // Log do erro mas não impede o registro
        console.error(
          `[EncomendasRegistro] Falha ao criar notificação para encomenda ${encomendaId}: ${notificacaoErro}`,
        )
      }
    }

    return {
      encomenda: encomendaCriada as Record<string, unknown>,
      notificacao: {
        enviada: notificacaoEnviada && totalMoradores > 0,
        totalMoradores,
        erro: notificacaoErro,
        ...(fotoExcecao ? { fotoExcecao } : {}),
      },
    }
  }
}

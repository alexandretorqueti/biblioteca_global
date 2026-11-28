/**
 * VitrinePublicaService — conteúdo público read-only da vitrine
 * (macro #10, posição 2/11 — subtarefa 1).
 *
 * Fonte: as 5 tabelas de conteúdo do projeto
 * `vitrine-ia-loja-de-atendentes-virtuais` (planos, itens_faq,
 * metricas_destaque, segmentos, textos_vitrine) no database FÍSICO do
 * projeto. Resolução server-side, nunca do payload:
 *   slug fixo → `projetos` no CORE_DB → ProjectDbFactory.obter({ id }).
 *
 * Garantias de exposição (REQ-F-001 / "sem dados internos expostos"):
 * - SELECT somente com `ativo = true`, ORDER BY `ordem` (id como desempate;
 *   textos_vitrine não tem ordem → id);
 * - serialização por allow-list: cada linha passa por um normalizador que
 *   projeta APENAS os campos de exibição do contrato — `id`, `ativo`,
 *   `ordem` e qualquer coluna de outras tabelas (pedidos, documentos,
 *   integracoes_externas/credenciaisCifradas, agentes_provisionados,
 *   configuracoes_whatsapp) são fisicamente descartados;
 * - a resposta agregada é validada por `vitrinePublicaConteudoSchema`
 *   (strict) antes de sair — desvio de forma é erro no servidor, nunca
 *   vazamento.
 */
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common"
import { asc, eq } from "drizzle-orm"
import {
  vitrinePublicaConteudoSchema,
  type VitrinePublicaConteudo,
  type VitrinePublicaFaq,
  type VitrinePublicaMetrica,
  type VitrinePublicaPlano,
  type VitrinePublicaSegmento,
  type VitrinePublicaTexto,
} from "@biblioteca-global/shared"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { projetos } from "../../../../../database/schema"
import {
  itensFaq,
  metricasDestaque,
  planos as planosTable,
  segmentos,
  textosVitrine,
} from "../../../../../projects/vitrine-ia-loja-de-atendentes-virtuais/schema"
import { PROJECT_DB_FACTORY, type ProjectDbFactory, type ProjetoDb } from "../crud/project-db.factory"
import { SLUG_VITRINE_IA } from "../crud/escopo/vitrine-ia.escopo"

type RegistroDesconhecido = Record<string, unknown>

/** Converte valor de coluna booleana (mysql2 devolve true/false ou 1/0). */
function comoBooleano(valor: unknown): boolean {
  return valor === true || valor === 1
}

/** String de exibição ou null (colunas opcionais). */
function comoTexto(valor: unknown): string | null {
  return typeof valor === "string" ? valor : null
}

/** Decimal do MySQL chega como string ("297.00") — normaliza para número. */
function comoNumero(valor: unknown): number {
  const n = typeof valor === "number" ? valor : Number(valor)
  return Number.isFinite(n) ? n : Number.NaN
}

/** Coluna JSON `beneficios`: aceita array pronto (mysql2) ou string JSON. */
function comoListaStrings(valor: unknown): string[] {
  let base: unknown = valor
  if (typeof base === "string") {
    try {
      base = JSON.parse(base)
    } catch {
      return []
    }
  }
  return Array.isArray(base) ? base.filter((item): item is string => typeof item === "string") : []
}

/** allow-list: planos → { nome, tagline, precoMensal, precoSetup, beneficios, textoBotao, maisPopular }. */
export function normalizarPlano(linha: RegistroDesconhecido): VitrinePublicaPlano {
  return {
    nome: typeof linha.nome === "string" ? linha.nome : String(linha.nome ?? ""),
    tagline: comoTexto(linha.tagline),
    precoMensal: comoNumero(linha.precoMensal ?? linha.preco_mensal),
    precoSetup: linha.precoSetup == null && linha.preco_setup == null
      ? null
      : comoNumero(linha.precoSetup ?? linha.preco_setup),
    beneficios: comoListaStrings(linha.beneficios),
    textoBotao: comoTexto(linha.textoBotao ?? linha.texto_botao),
    maisPopular: comoBooleano(linha.maisPopular ?? linha.mais_popular),
  }
}

/** allow-list: itens_faq → { pergunta, resposta }. */
export function normalizarFaq(linha: RegistroDesconhecido): VitrinePublicaFaq {
  return {
    pergunta: typeof linha.pergunta === "string" ? linha.pergunta : String(linha.pergunta ?? ""),
    resposta: typeof linha.resposta === "string" ? linha.resposta : String(linha.resposta ?? ""),
  }
}

/** allow-list: metricas_destaque → { valor, rotulo }. */
export function normalizarMetrica(linha: RegistroDesconhecido): VitrinePublicaMetrica {
  return {
    valor: typeof linha.valor === "string" ? linha.valor : String(linha.valor ?? ""),
    rotulo: comoTexto(linha.rotulo),
  }
}

/** allow-list: segmentos → { titulo, descricao, icone }. */
export function normalizarSegmento(linha: RegistroDesconhecido): VitrinePublicaSegmento {
  return {
    titulo: typeof linha.titulo === "string" ? linha.titulo : String(linha.titulo ?? ""),
    descricao: comoTexto(linha.descricao),
    icone: comoTexto(linha.icone),
  }
}

/** allow-list: textos_vitrine → { chave, secao, conteudo } (whatsapp_link incluso). */
export function normalizarTexto(linha: RegistroDesconhecido): VitrinePublicaTexto {
  const secao = linha.secao
  return {
    chave: typeof linha.chave === "string" ? linha.chave : String(linha.chave ?? ""),
    secao:
      secao === "hero" || secao === "dores" || secao === "beneficios" ||
      secao === "como_funciona" || secao === "cta" || secao === "contato"
        ? secao
        : null,
    conteudo: typeof linha.conteudo === "string" ? linha.conteudo : String(linha.conteudo ?? ""),
  }
}

@Injectable()
export class VitrinePublicaService {
  private readonly logger = new Logger(VitrinePublicaService.name)
  /** cache do id do projeto no core (slug é fixo por instância — padrão gestao-organizacoes) */
  private projetoIdCache: number | null = null

  constructor(
    @Inject(CORE_DB) private readonly coreDb: CoreDb,
    @Inject(PROJECT_DB_FACTORY) private readonly factory: ProjectDbFactory,
  ) {}

  /** Conteúdo ativo da vitrine, no formato do contrato compartilhado. */
  async obterConteudo(): Promise<VitrinePublicaConteudo> {
    const db = await this.obterDbProjeto()

    // WHERE ativo = true + ORDER BY ordem/id resolvidos pelo banco (a
    // coluna `ordem` não existe em textos_vitrine → desempate por id).
    const [linhasTextos, linhasPlanos, linhasMetricas, linhasFaq, linhasSegmentos] = await Promise.all([
      db
        .select()
        .from(textosVitrine)
        .where(eq(textosVitrine.ativo, true))
        .orderBy(asc(textosVitrine.id)),
      db
        .select()
        .from(planosTable)
        .where(eq(planosTable.ativo, true))
        .orderBy(asc(planosTable.ordem), asc(planosTable.id)),
      db
        .select()
        .from(metricasDestaque)
        .where(eq(metricasDestaque.ativo, true))
        .orderBy(asc(metricasDestaque.ordem), asc(metricasDestaque.id)),
      db
        .select()
        .from(itensFaq)
        .where(eq(itensFaq.ativo, true))
        .orderBy(asc(itensFaq.ordem), asc(itensFaq.id)),
      db
        .select()
        .from(segmentos)
        .where(eq(segmentos.ativo, true))
        .orderBy(asc(segmentos.ordem), asc(segmentos.id)),
    ])

    const conteudo: VitrinePublicaConteudo = {
      textos: (linhasTextos as RegistroDesconhecido[]).map(normalizarTexto),
      planos: (linhasPlanos as RegistroDesconhecido[]).map(normalizarPlano),
      metricas: (linhasMetricas as RegistroDesconhecido[]).map(normalizarMetrica),
      faq: (linhasFaq as RegistroDesconhecido[]).map(normalizarFaq),
      segmentos: (linhasSegmentos as RegistroDesconhecido[]).map(normalizarSegmento),
    }
    // Barreira final: a resposta SÓ sai se couber no contrato strict (nenhuma
    // chave extra sobrevivente a uma eventual regressão de mapeamento).
    return vitrinePublicaConteudoSchema.parse(conteudo)
  }

  /**
   * Database físico do projeto da vitrine — id resolvido no core, nunca no
   * payload. Público para reuso pelo `VitrinePedidosService` (mesma
   * resolução server-side do endpoint de conteúdo).
   */
  async obterDbProjeto(): Promise<ProjetoDb> {
    const projetoId = await this.resolverProjetoId()
    return this.factory.obter({ id: projetoId })
  }

  /** Resolve (e cacheia) o id do projeto `vitrine-ia-loja-de-atendentes-virtuais` no core. */
  private async resolverProjetoId(): Promise<number> {
    if (this.projetoIdCache !== null) return this.projetoIdCache
    const linha = (
      await this.coreDb
        .select({ id: projetos.id })
        .from(projetos)
        .where(eq(projetos.slug, SLUG_VITRINE_IA))
        .limit(1)
    ).at(0)
    if (!linha) {
      throw new NotFoundException(
        `Projeto "${SLUG_VITRINE_IA}" não provisionado no core — vitrine pública indisponível.`,
      )
    }
    const id = Number(linha.id)
    this.logger.log(`Vitrine pública — projeto ${id} (${SLUG_VITRINE_IA})`)
    this.projetoIdCache = id
    return id
  }
}

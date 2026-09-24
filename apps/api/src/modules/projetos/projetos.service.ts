/**
 * ProjetosService — CRUD restrito ao admin global + ciclo de vida (PoC §6.2/§6.3).
 * Provisionamento com compensação: falhou após o registro → desfaz o registro
 * e remove o database criado (best-effort).
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import {
  geradorSistemaConfigSchema,
  type GeradorSistemaConfig,
  type PaginatedResult,
} from "@biblioteca-global/shared"
import {
  ConfigInvalidaError,
  validarConfigContraSchema,
} from "@biblioteca-global/schema-tools"
import {
  SCHEMA_REGISTRY,
  type SchemaRegistry,
} from "../crud/schema-registry"
import type { CreateProjetoDto } from "./dto/create-projeto.dto"
import type { UpdateProjetoDto } from "./dto/update-projeto.dto"
import {
  PROJETO_PROVISIONER,
  validarSlug,
  type ProjetoProvisioner,
} from "./provisioner.service"
import {
  PROJETOS_REPOSITORY,
  type ProjetoRow,
  type ProjetosRepository,
} from "./projetos.repository"
import { encryptDbPassword } from "../../common/crypto/db-credentials"

/** Config mínima para projeto recém-criado (telas de negócio vêm depois). */
export function configPadrao(nome: string): GeradorSistemaConfig {
  return {
    app: { name: nome },
    groups: [],
  }
}

export function nomeDatabaseDoProjeto(projetoId: number): string {
  return `projeto_${projetoId}`
}

/** Valores operacionais usados quando a criação não informa a configuração. */
export const PROJETO_DEFAULTS = {
  branchTrabalho: "base-desenvolvimento",
  repoPath: "/data/workspace/projects/codigofonte/biblioteca-global",
  agenteId: "biblioteca-global",
} as const

/**
 * Configuração de conexão MySQL customizada por projeto.
 * Usada internamente — nunca exposta em respostas da API.
 */
export interface DbConnectionConfig {
  dbHost: string
  dbPort: number
  dbDatabase: string
  dbUser: string
  dbPassword: string
}

/** Logger dedicado (sem expor credenciais). */
const logger = new Logger("ProjetosService")

/**
 * Valida se a configuração de conexão está completa ou vazia.
 * Configuração parcialmente preenchida é rejeitada (todos ou nenhum).
 * Retorna undefined se todos os campos estão vazios (comportamento padrão).
 */
export function validarConfigDb(
  dto: Pick<CreateProjetoDto, "dbHost" | "dbPort" | "dbDatabase" | "dbUser" | "dbPassword">,
): DbConnectionConfig | undefined {
  const campos = {
    dbHost: dto.dbHost?.trim() ?? "",
    dbPort: dto.dbPort,
    dbDatabase: dto.dbDatabase?.trim() ?? "",
    dbUser: dto.dbUser?.trim() ?? "",
    dbPassword: dto.dbPassword ?? "",
  }

  const preenchidos = [
    campos.dbHost !== "",
    campos.dbPort !== undefined && campos.dbPort !== null,
    campos.dbDatabase !== "",
    campos.dbUser !== "",
    campos.dbPassword !== "",
  ]

  const totalPreenchidos = preenchidos.filter(Boolean).length

  // Todos vazios → configuração padrão (env)
  if (totalPreenchidos === 0) {
    return undefined
  }

  // Todos preenchidos → configuração customizada válida
  if (totalPreenchidos === 5) {
    return {
      dbHost: campos.dbHost,
      dbPort: campos.dbPort!,
      dbDatabase: campos.dbDatabase,
      dbUser: campos.dbUser,
      dbPassword: campos.dbPassword,
    }
  }

  // Parcialmente preenchido → rejeitar
  const faltantes: string[] = []
  if (!campos.dbHost) faltantes.push("dbHost")
  if (campos.dbPort === undefined || campos.dbPort === null) faltantes.push("dbPort")
  if (!campos.dbDatabase) faltantes.push("dbDatabase")
  if (!campos.dbUser) faltantes.push("dbUser")
  if (!campos.dbPassword) faltantes.push("dbPassword")

  throw new BadRequestException({
    message: "Configuração de conexão MySQL parcialmente preenchida",
    detalhes: "Todos os campos (dbHost, dbPort, dbDatabase, dbUser, dbPassword) devem ser informados ou nenhum deve ser informado.",
    camposFaltantes: faltantes,
  })
}

/**
 * Sanitiza a resposta pública do projeto — remove credenciais do banco.
 * A senha criptografada NUNCA aparece em respostas da API.
 * Host/porta/database/user são retornados como indicadores de que existe
 * config customizada, mas a senha é sempre omitida.
 */
export function sanitizarProjetoPublico<T extends ProjetoRow>(projeto: T): Omit<T, "dbPasswordCriptografado"> & { dbPasswordConfigurado: boolean } {
  const { dbPasswordCriptografado, ...resto } = projeto
  return {
    ...resto,
    dbPasswordConfigurado: Boolean(dbPasswordCriptografado),
  }
}

/**
 * Sanitiza lista de projetos — aplica sanitizarProjetoPublico em cada item.
 */
export function sanitizarListaProjetosPublica<T extends ProjetoRow>(
  resultado: PaginatedResult<T>,
): PaginatedResult<Omit<T, "dbPasswordCriptografado"> & { dbPasswordConfigurado: boolean }> {
  return {
    ...resultado,
    items: resultado.items.map(sanitizarProjetoPublico),
  }
}

@Injectable()
export class ProjetosService {
  constructor(
    @Inject(PROJETOS_REPOSITORY) private readonly repo: ProjetosRepository,
    @Inject(PROJETO_PROVISIONER)
    private readonly provisioner: ProjetoProvisioner,
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
  ) {}

  async listar(params: {
    page?: number
    pageSize?: number
  }): Promise<PaginatedResult<Omit<ProjetoRow, "dbPasswordCriptografado"> & { dbPasswordConfigurado: boolean }>> {
    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 20
    if (page < 1 || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException("Paginação inválida")
    }
    const resultado = await this.repo.listar({ page, pageSize })
    return sanitizarListaProjetosPublica({ ...resultado, page, pageSize })
  }

  async detalharPorSlug(slug: string): Promise<ProjetoRow | undefined> {
    return this.repo.findBySlug(slug)
  }

  async detalhar(projetoId: number): Promise<Omit<ProjetoRow, "dbPasswordCriptografado"> & { dbPasswordConfigurado: boolean }> {
    const projeto = await this.repo.findById(projetoId)
    if (!projeto) {
      throw new NotFoundException("Projeto não encontrado")
    }
    return sanitizarProjetoPublico(projeto)
  }

  /**
   * Detalhar interno (com credenciais criptografadas) — usado apenas
   * pela ProjectDbFactory e outros componentes internos que precisam
   * da configuração real. NUNCA expor em endpoints da API.
   */
  async detalharInterno(projetoId: number): Promise<ProjetoRow> {
    const projeto = await this.repo.findById(projetoId)
    if (!projeto) {
      throw new NotFoundException("Projeto não encontrado")
    }
    return projeto
  }

  /**
   * Ciclo de vida (PoC §6.3): registro → CREATE DATABASE projeto_<id> →
   * migrations da pasta → config inicial salva.
   */
  async criar(
    dto: CreateProjetoDto,
  ): Promise<(Omit<ProjetoRow, "dbPasswordCriptografado"> & { dbPasswordConfigurado: boolean }) & { database: string; migrationsAplicadas: number }> {
    validarSlug(dto.slug)

    const existente = await this.repo.findBySlug(dto.slug)
    if (existente) {
      throw new ConflictException(`slug ${dto.slug} já existe`)
    }

    // Config inicial: fornecida (validada) ou padrão mínimo.
    const config = dto.config
      ? this.validarConfig(dto.config, dto.slug)
      : configPadrao(dto.nome)

    // Validação de configuração de conexão (todos ou nenhum).
    const configDb = validarConfigDb(dto)

    const projetoId = await this.repo.criar({
      nome: dto.nome,
      slug: dto.slug,
      ativo: dto.ativo ?? true,
      config,
      branchTrabalho: dto.branchTrabalho ?? dto.branch_trabalho ?? PROJETO_DEFAULTS.branchTrabalho,
      repoPath: dto.repoPath ?? dto.repo_path ?? PROJETO_DEFAULTS.repoPath,
      agenteId: dto.agenteId ?? dto.agente_id ?? PROJETO_DEFAULTS.agenteId,
      // Configuração de conexão (criptografada quando presente).
      dbHost: configDb?.dbHost,
      dbPort: configDb?.dbPort,
      dbDatabase: configDb?.dbDatabase,
      dbUser: configDb?.dbUser,
      dbPasswordCriptografado: configDb ? encryptDbPassword(configDb.dbPassword) : undefined,
    })
    const database = nomeDatabaseDoProjeto(projetoId)

    // Log sem credenciais — apenas indicação de que config customizada foi definida.
    if (configDb) {
      logger.log(`Projeto ${projetoId} criado com conexão MySQL customizada (${configDb.dbHost}:${configDb.dbPort}/${configDb.dbDatabase})`)
    }

    try {
      await this.provisioner.prepararDatabase(database)
      const migrationsAplicadas = await this.provisioner.aplicarMigrations(
        dto.slug,
        database,
      )
      const projeto = await this.repo.findById(projetoId)
      if (!projeto) {
        throw new Error("projeto não encontrado após a criação")
      }
      return { ...sanitizarProjetoPublico(projeto), database, migrationsAplicadas }
    } catch (erro: unknown) {
      // Compensação: desfaz o registro e o database parcial.
      await this.repo.remover(projetoId)
      await this.provisioner.removerDatabase(database).catch(() => undefined)
      throw erro
    }
  }

  /**
   * Valida a config em duas camadas:
   * 1. Estrutural (contrato serializável do shared).
   * 2. Contra o schema do projeto: resource/campo inexistente → rejeita
   *    (PoC §7.4 — defesa em profundidade).
   */
  validarConfig(config: unknown, slug: string): GeradorSistemaConfig {
    const resultado = geradorSistemaConfigSchema.safeParse(config)
    if (!resultado.success) {
      throw new BadRequestException({
        message: "Config inválida",
        details: resultado.error.issues.map((issue) => ({
          caminho: issue.path.join("."),
          problema: issue.message,
        })),
      })
    }
    const tabelas = this.registry.tabelasDoProjeto(slug)
    if (tabelas) {
      try {
        validarConfigContraSchema(resultado.data, tabelas)
      } catch (erro: unknown) {
        if (erro instanceof ConfigInvalidaError) {
          throw new BadRequestException({
            message: "Config inválida contra o schema do projeto",
            details: erro.problemas,
          })
        }
        throw erro
      }
    }
    return resultado.data
  }

  /**
   * Atualiza nome/ativo/config e configuração de conexão MySQL.
   * A config é validada ANTES de salvar (PoC §6.2). slug não muda
   * (identifica a pasta no git).
   *
   * Para REMOVER a conexão customizada: enviar dbHost vazio/null
   * (ou qualquer campo vazio) — o service interpreta como "remover".
   */
  async atualizar(
    projetoId: number,
    dto: UpdateProjetoDto,
  ): Promise<Omit<ProjetoRow, "dbPasswordCriptografado"> & { dbPasswordConfigurado: boolean }> {
    const projeto = await this.detalharInterno(projetoId)

    // slug é imutável: identifica a pasta versionada projects/<slug>/.
    if (dto.slug !== undefined && dto.slug !== projeto.slug) {
      throw new BadRequestException("slug não pode ser alterado")
    }

    const campos: Partial<{
      nome: string
      ativo: boolean
      config: GeradorSistemaConfig
      dbHost: string | null
      dbPort: number | null
      dbDatabase: string | null
      dbUser: string | null
      dbPasswordCriptografado: string | null
    }> = {}
    if (dto.nome !== undefined) campos.nome = dto.nome
    if (dto.ativo !== undefined) campos.ativo = dto.ativo
    if (dto.config !== undefined) campos.config = this.validarConfig(dto.config, projeto.slug)

    // ── Configuração de conexão MySQL ─────────────────────────────────
    // Verifica se há intenção de alterar a configuração de conexão.
    const temCamposDb =
      dto.dbHost !== undefined ||
      dto.dbPort !== undefined ||
      dto.dbDatabase !== undefined ||
      dto.dbUser !== undefined ||
      dto.dbPassword !== undefined

    if (temCamposDb) {
      // Monta DTO completado com valores existentes para validar.
      const dtoCompletado = {
        dbHost: dto.dbHost ?? projeto.dbHost ?? undefined,
        dbPort: dto.dbPort ?? projeto.dbPort ?? undefined,
        dbDatabase: dto.dbDatabase ?? projeto.dbDatabase ?? undefined,
        dbUser: dto.dbUser ?? projeto.dbUser ?? undefined,
        // Senha: se não enviada, usa placeholder para validar (não será salva).
        dbPassword: dto.dbPassword ?? "__EXISTING__",
      }

      // Se algum campo foi zerado (vazio/null) → remover configuração.
      const algumZerado =
        dto.dbHost === null || dto.dbHost === "" ||
        dto.dbDatabase === null || dto.dbDatabase === "" ||
        dto.dbUser === null || dto.dbUser === ""

      if (algumZerado) {
        // Remover configuração customizada → voltar ao padrão.
        campos.dbHost = null
        campos.dbPort = null
        campos.dbDatabase = null
        campos.dbUser = null
        campos.dbPasswordCriptografado = null
        logger.log(`Projeto ${projetoId}: configuração de conexão MySQL removida (voltando ao padrão)`)
      } else {
        // Validar completude e criptografar.
        const configDb = validarConfigDb(dtoCompletado)
        if (configDb) {
          campos.dbHost = configDb.dbHost
          campos.dbPort = configDb.dbPort
          campos.dbDatabase = configDb.dbDatabase
          campos.dbUser = configDb.dbUser
          // Só criptografa se nova senha foi enviada; caso contrário mantém a existente.
          if (dto.dbPassword) {
            campos.dbPasswordCriptografado = encryptDbPassword(dto.dbPassword)
          }
          logger.log(`Projeto ${projetoId}: configuração de conexão MySQL atualizada (${configDb.dbHost}:${configDb.dbPort}/${configDb.dbDatabase})`)
        }
      }
    }

    if (Object.keys(campos).length > 0) {
      await this.repo.atualizar(projeto.id, campos)
    }
    const atualizado = await this.repo.findById(projeto.id)
    if (!atualizado) {
      throw new NotFoundException("Projeto não encontrado")
    }
    return sanitizarProjetoPublico(atualizado)
  }

  /** Soft delete: desativa, database preservado (PoC §6.2). */
  async desativar(projetoId: number): Promise<void> {
    const projeto = await this.detalharInterno(projetoId)
    await this.repo.atualizar(projeto.id, { ativo: false })
  }

  /**
   * Garante que o database do projeto existe e tem as migrations aplicadas
   * (idempotente — pode rodar 2x sem quebrar). Usado quando o projeto já
   * existe na tabela core mas o database não foi provisionado (ex.: projeto
   * inserido manualmente ou provisioning anterior falhou).
   */
  async garantirDatabaseProvisionado(
    projetoId: number,
    slug: string,
  ): Promise<{ database: string; migrationsAplicadas: number }> {
    validarSlug(slug)
    const database = nomeDatabaseDoProjeto(projetoId)

    // CREATE DATABASE IF NOT EXISTS — idempotente.
    await this.provisioner.prepararDatabase(database)

    // Aplica migrations pendentes (drizzle migrate também é idempotente).
    const migrationsAplicadas = await this.provisioner.aplicarMigrations(
      slug,
      database,
    )

    return { database, migrationsAplicadas }
  }
}

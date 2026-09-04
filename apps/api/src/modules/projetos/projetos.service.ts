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
  }): Promise<PaginatedResult<ProjetoRow>> {
    const page = params.page ?? 1
    const pageSize = params.pageSize ?? 20
    if (page < 1 || pageSize < 1 || pageSize > 100) {
      throw new BadRequestException("Paginação inválida")
    }
    const resultado = await this.repo.listar({ page, pageSize })
    return { ...resultado, page, pageSize }
  }

  async detalharPorSlug(slug: string): Promise<ProjetoRow | undefined> {
    return this.repo.findBySlug(slug)
  }

  async detalhar(projetoId: number): Promise<ProjetoRow> {
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
  ): Promise<ProjetoRow & { database: string; migrationsAplicadas: number }> {
    validarSlug(dto.slug)

    const existente = await this.repo.findBySlug(dto.slug)
    if (existente) {
      throw new ConflictException(`slug ${dto.slug} já existe`)
    }

    // Config inicial: fornecida (validada) ou padrão mínimo.
    const config = dto.config
      ? this.validarConfig(dto.config, dto.slug)
      : configPadrao(dto.nome)

    const projetoId = await this.repo.criar({
      nome: dto.nome,
      slug: dto.slug,
      ativo: dto.ativo ?? true,
      config,
      branchTrabalho: dto.branchTrabalho ?? dto.branch_trabalho ?? PROJETO_DEFAULTS.branchTrabalho,
      repoPath: dto.repoPath ?? dto.repo_path ?? PROJETO_DEFAULTS.repoPath,
      agenteId: dto.agenteId ?? dto.agente_id ?? PROJETO_DEFAULTS.agenteId,
    })
    const database = nomeDatabaseDoProjeto(projetoId)

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
      return { ...projeto, database, migrationsAplicadas }
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
   * Atualiza nome/ativo/config. A config é validada ANTES de salvar
   * (PoC §6.2). slug não muda (identifica a pasta no git).
   */
  async atualizar(
    projetoId: number,
    dto: UpdateProjetoDto,
  ): Promise<ProjetoRow> {
    const projeto = await this.detalhar(projetoId)

    // slug é imutável: identifica a pasta versionada projects/<slug>/.
    if (dto.slug !== undefined && dto.slug !== projeto.slug) {
      throw new BadRequestException("slug não pode ser alterado")
    }

    const campos: Partial<{
      nome: string
      ativo: boolean
      config: GeradorSistemaConfig
    }> = {}
    if (dto.nome !== undefined) campos.nome = dto.nome
    if (dto.ativo !== undefined) campos.ativo = dto.ativo
    if (dto.config !== undefined) campos.config = this.validarConfig(dto.config, projeto.slug)

    if (Object.keys(campos).length > 0) {
      await this.repo.atualizar(projeto.id, campos)
    }
    const atualizado = await this.repo.findById(projeto.id)
    if (!atualizado) {
      throw new NotFoundException("Projeto não encontrado")
    }
    return atualizado
  }

  /** Soft delete: desativa, database preservado (PoC §6.2). */
  async desativar(projetoId: number): Promise<void> {
    const projeto = await this.detalhar(projetoId)
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

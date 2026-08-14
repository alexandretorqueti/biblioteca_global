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

@Injectable()
export class ProjetosService {
  constructor(
    @Inject(PROJETOS_REPOSITORY) private readonly repo: ProjetosRepository,
    @Inject(PROJETO_PROVISIONER)
    private readonly provisioner: ProjetoProvisioner,
    @Inject(SCHEMA_REGISTRY) private readonly registry: SchemaRegistry,
  ) {}

  async listar(): Promise<ProjetoRow[]> {
    return this.repo.listar()
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
      config,
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
}

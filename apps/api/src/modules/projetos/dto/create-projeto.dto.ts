import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

export const SLUG_REGEX = /^[a-z][a-z0-9-]*$/

/**
 * Criação de projeto (PoC §6.3): registro → CREATE DATABASE projeto_<id> →
 * migrations da pasta → config inicial.
 */
export class CreateProjetoDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  nome!: string

  /** Identifica a pasta projects/<slug>/ — minúsculo, sem espaços. */
  @IsDefined()
  @IsString()
  @Matches(SLUG_REGEX, {
    message: "slug deve começar com letra minúscula (a-z0-9 e hífen)",
  })
  slug!: string

  /** Config inicial opcional (validada); padrão mínimo quando ausente. */
  @IsOptional()
  config?: GeradorSistemaConfig

  /** Aceito pelo form compartilhado; padrão true quando ausente. */
  @IsOptional()
  @IsBoolean()
  ativo?: boolean

  /** Branch de trabalho do projeto (padrão: 'base-desenvolvimento'). */
  @IsOptional()
  @IsString()
  branchTrabalho?: string

  /** Alias compatível com payloads que usam o nome físico da coluna. */
  @IsOptional()
  @IsString()
  branch_trabalho?: string

  /** Caminho do repositório do projeto (padrão: '/data/workspace/projects/codigofonte/biblioteca-global'). */
  @IsOptional()
  @IsString()
  repoPath?: string

  /** Alias compatível com payloads que usam o nome físico da coluna. */
  @IsOptional()
  @IsString()
  repo_path?: string

  /** ID do agente vinculado ao projeto (padrão: 'biblioteca-global'). */
  @IsOptional()
  @IsString()
  agenteId?: string

  /** Alias compatível com payloads que usam o nome físico da coluna. */
  @IsOptional()
  @IsString()
  agente_id?: string

  // ── Conexão MySQL customizada por projeto (opcional) ────────────────
  // Todos opcionais, mas se algum for preenchido, todos são obrigatórios
  // (validação de completude feita no service).

  /** Host do MySQL customizado (ex.: dbaas.example.com). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dbHost?: string

  /** Porta do MySQL customizado (1-65535). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  dbPort?: number

  /** Nome do database no MySQL customizado. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dbDatabase?: string

  /** Usuário do MySQL customizado. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dbUser?: string

  /** Senha do MySQL customizado (será criptografada antes de salvar). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dbPassword?: string
}

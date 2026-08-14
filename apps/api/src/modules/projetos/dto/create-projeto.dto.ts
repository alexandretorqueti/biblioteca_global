import { IsDefined, IsNotEmpty, IsOptional, IsString, Matches } from "class-validator"
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
}

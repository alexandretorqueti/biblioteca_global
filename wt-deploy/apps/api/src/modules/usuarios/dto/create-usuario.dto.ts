import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator"
import type { Perfil } from "@biblioteca-global/shared"

export const PERFIS_VALIDOS: Perfil[] = [
  "admin",
  "gerente",
  "operador",
  "visualizador",
]

/**
 * Criação de usuário — o vínculo é SEMPRE com o projeto do token
 * (PoC §6.2/§8: projetoId jamais é aceito no body).
 */
export class CreateUsuarioDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  nome!: string

  @IsDefined()
  @IsString()
  @MinLength(8)
  senhaInicial!: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  username?: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  email?: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  telefone?: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cpf?: string

  /** Perfil dentro do projeto da sessão; padrão `operador`. */
  @IsOptional()
  @IsIn(PERFIS_VALIDOS)
  perfil?: Perfil

  @IsOptional()
  @IsBoolean()
  ativo?: boolean
}

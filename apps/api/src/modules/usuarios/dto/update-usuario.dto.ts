import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from "class-validator"
import type { Perfil } from "@biblioteca-global/shared"
import { PERFIS_VALIDOS } from "./create-usuario.dto"

/**
 * Edição de usuário — nunca aceita projetoId (PoC §6.2).
 * `perfil` vale para o projeto da sessão; vínculos com outros projetos
 * passam pelo endpoint /vincular (admin global).
 */
export class UpdateUsuarioDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nome?: string

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

  @IsOptional()
  @IsBoolean()
  ativo?: boolean

  @IsOptional()
  @IsIn(PERFIS_VALIDOS)
  perfil?: Perfil
}

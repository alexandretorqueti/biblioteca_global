import { Transform } from "class-transformer"
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from "class-validator"
import type { Perfil } from "@biblioteca-global/shared"
import { PERFIS_VALIDOS } from "./create-usuario.dto"

/**
 * Edição de usuário — nunca aceita projetoId (PoC §6.2).
 * `perfil` vale para o projeto da sessão; vínculos com outros projetos
 * passam pelo endpoint /vincular (admin global).
 *
 * O form compartilhado (criar/editar) envia todos os campos, inclusive
 * vazios — string vazia vira undefined para não derrubar a edição.
 */
const vazioParaUndefined = ({ value }: { value: unknown }): unknown =>
  value === "" ? undefined : value

export class UpdateUsuarioDto {
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @IsNotEmpty()
  nome?: string

  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @IsNotEmpty()
  username?: string

  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @IsNotEmpty()
  email?: string

  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @IsNotEmpty()
  telefone?: string

  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @IsNotEmpty()
  cpf?: string

  @IsOptional()
  @IsBoolean()
  ativo?: boolean

  @IsOptional()
  @IsIn(PERFIS_VALIDOS)
  perfil?: Perfil

  /** Redefinição de senha pelo admin — vazio mantém a senha atual. */
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @MinLength(8)
  senhaInicial?: string
}

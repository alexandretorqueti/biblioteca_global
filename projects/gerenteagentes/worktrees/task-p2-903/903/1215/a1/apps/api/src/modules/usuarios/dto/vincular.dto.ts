import { Type } from "class-transformer"
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  ValidateNested,
} from "class-validator"
import type { Perfil } from "@biblioteca-global/shared"
import { PERFIS_VALIDOS } from "./create-usuario.dto"

export class VinculoAdicionarDto {
  @IsDefined()
  @IsInt()
  @IsPositive()
  projetoId!: number

  @IsDefined()
  @IsIn(PERFIS_VALIDOS)
  perfil!: Perfil
}

/**
 * Gerenciamento de vínculos multi-projeto — exclusivo do admin global
 * (PoC §6.2/§8).
 */
export class VincularDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VinculoAdicionarDto)
  adicionar?: VinculoAdicionarDto[]

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @IsPositive({ each: true })
  remover?: number[]
}

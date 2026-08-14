import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from "class-validator"
import type { GeradorSistemaConfig } from "@biblioteca-global/shared"

/** Atualização de projeto — a config é validada antes de salvar. */
export class UpdateProjetoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nome?: string

  @IsOptional()
  @IsBoolean()
  ativo?: boolean

  @IsOptional()
  config?: GeradorSistemaConfig
}

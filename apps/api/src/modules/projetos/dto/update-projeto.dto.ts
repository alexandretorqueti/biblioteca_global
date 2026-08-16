import { Transform } from "class-transformer"
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator"
import { SLUG_REGEX } from "./create-projeto.dto"

/** Form compartilhado envia string vazia — vira undefined (não altera). */
const vazioParaUndefined = ({ value }: { value: unknown }): unknown =>
  value === "" ? undefined : value

/**
 * Atualização de projeto — a config é validada antes de salvar.
 * `slug` é aceito apenas para validação (imutável: identifica a pasta
 * versionada projects/<slug>/ e o database é derivado do id).
 */
export class UpdateProjetoDto {
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @IsNotEmpty()
  nome?: string

  @IsOptional()
  @IsBoolean()
  ativo?: boolean

  /** Imutável — o service rejeita mudança; aceito p/ o form compartilhado. */
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  @Matches(SLUG_REGEX, {
    message: "slug deve começar com letra minúscula (a-z0-9 e hífen)",
  })
  slug?: string

  @IsOptional()
  config?: import("@biblioteca-global/shared").GeradorSistemaConfig
}

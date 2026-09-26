import { Transform } from "class-transformer"
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
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

  // ── Conexão MySQL customizada por projeto (opcional) ────────────────
  // Todos opcionais; se algum for preenchido, todos são obrigatórios
  // (validação de completude feita no service).
  // Para REMOVER a config customizada, envie dbHost: null (ou vazio) —
  // o service interpreta como "remover configuração e voltar ao padrão".

  /** Host do MySQL customizado. Enviar vazio/null para remover a config. */
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  dbHost?: string | null

  /** Porta do MySQL customizado (1-65535). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  dbPort?: number | null

  /** Nome do database no MySQL customizado. */
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  dbDatabase?: string | null

  /** Usuário do MySQL customizado. */
  @IsOptional()
  @Transform(vazioParaUndefined)
  @IsString()
  dbUser?: string | null

  /** Senha do MySQL customizado (será criptografada antes de salvar). */
  @IsOptional()
  @IsString()
  dbPassword?: string | null
}

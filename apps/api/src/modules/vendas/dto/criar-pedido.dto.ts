import { IsDefined, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator"

export class CriarPedidoDto {
  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  chatId!: string

  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  planoSlug!: string

  @IsOptional()
  @IsIn(["monthly", "yearly"])
  ciclo?: "monthly" | "yearly"

  @IsUrl({ require_tld: false })
  checkoutSuccessUrl!: string

  @IsUrl({ require_tld: false })
  checkoutFailureUrl!: string

  @IsUrl({ require_tld: false })
  checkoutPendingUrl!: string
}

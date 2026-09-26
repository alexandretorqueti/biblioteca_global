/**
 * POST /auth/verify-code — valida o código de 6 dígitos (auth única, D4/D5).
 */
import { IsDefined, IsEmail, IsString, Length, Matches } from "class-validator"

export class VerifyCodeDto {
  @IsDefined()
  @IsString()
  @IsEmail()
  email!: string

  @IsDefined()
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: "code deve ter 6 dígitos" })
  code!: string
}

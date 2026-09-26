/**
 * POST /auth/set-password — define a senha na 1ª vez (auth única, D4).
 * Autenticado pelo token efêmero do verify-code (JWT ~5 min, claim { sub }).
 */
import { IsDefined, IsString, MinLength } from "class-validator"

export class SetPasswordDto {
  @IsDefined()
  @IsString()
  verificationToken!: string

  @IsDefined()
  @IsString()
  @MinLength(8)
  novaSenha!: string
}

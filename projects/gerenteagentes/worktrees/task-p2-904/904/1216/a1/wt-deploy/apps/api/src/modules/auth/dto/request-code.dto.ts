/**
 * POST /auth/request-code — pedido de código por e-mail (auth única, D4).
 * A validação de formato é deliberadamente leve: o service responde a MESMA
 * resposta genérica para e-mail inválido/inexistente/rate-limited.
 */
import { IsDefined, IsEmail, IsString } from "class-validator"

export class RequestCodeDto {
  @IsDefined()
  @IsString()
  @IsEmail()
  email!: string
}

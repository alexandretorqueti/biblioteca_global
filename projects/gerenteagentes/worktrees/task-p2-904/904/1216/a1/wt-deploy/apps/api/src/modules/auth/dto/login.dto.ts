import {
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsString,
  MinLength,
} from "class-validator"
import type { LoginIdentifierType } from "@biblioteca-global/shared"

export const IDENTIFIER_TYPES: LoginIdentifierType[] = [
  "email",
  "username",
  "phone",
  "cpf",
  "document",
]

export class LoginDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  identifier!: string

  @IsDefined()
  @IsString()
  @MinLength(1)
  password!: string

  @IsDefined()
  @IsIn(IDENTIFIER_TYPES)
  identifierType!: LoginIdentifierType
}

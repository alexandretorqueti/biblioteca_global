import { IsDefined, IsNotEmpty, IsString, MinLength } from "class-validator"

export class ChangePasswordDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  senhaAtual!: string

  @IsDefined()
  @IsString()
  @MinLength(8)
  novaSenha!: string
}

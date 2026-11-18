import { IsBase64, IsDefined, IsNotEmpty, IsString, MaxLength } from "class-validator"

export class AnexarDocumentoDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  chatId!: string

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nome!: string

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  mime!: string

  @IsDefined()
  @IsString()
  @IsBase64()
  conteudoBase64!: string
}

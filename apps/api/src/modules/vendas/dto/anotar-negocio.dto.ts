import { Type } from "class-transformer"
import {
  IsDefined,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsBoolean,
  MaxLength,
  ValidateNested,
} from "class-validator"

export class ContatoNegocioDto {
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  nome!: string

  @IsDefined()
  @IsEmail()
  @MaxLength(255)
  email!: string

  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  telefone!: string
}

export class TransbordoNegocioDto {
  @IsDefined()
  @IsBoolean()
  ativo!: boolean

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  destinoNumero?: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  destinoNome?: string
}

export class AnotarNegocioDto {
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
  @MaxLength(2000)
  segmentoDescricao!: string

  @IsDefined()
  @ValidateNested()
  @Type(() => ContatoNegocioDto)
  contato!: ContatoNegocioDto

  @IsDefined()
  @ValidateNested()
  @Type(() => TransbordoNegocioDto)
  transbordo!: TransbordoNegocioDto
}

import { Type } from "class-transformer"
import { IsInt, IsOptional, IsPositive, IsString, Max } from "class-validator"

/** Query da listagem de usuários (filtros/paginação padronizados). */
export class ListUsuariosQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  page?: number

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(100)
  pageSize?: number

  @IsOptional()
  @IsString()
  search?: string

  /** Exclusivo do admin global: lista usuários de outro projeto. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  projetoId?: number
}

import { Type } from "class-transformer"
import { IsInt, IsOptional, IsPositive, IsString, Max } from "class-validator"

export class ListLogsLoginQueryDto {
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
}

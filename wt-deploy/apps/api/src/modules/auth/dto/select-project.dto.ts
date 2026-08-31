import { IsDefined, IsInt, IsPositive } from "class-validator"

export class SelectProjectDto {
  @IsDefined()
  @IsInt()
  @IsPositive()
  projetoId!: number
}

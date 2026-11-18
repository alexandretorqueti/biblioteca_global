import { IsIn } from "class-validator"

export class AceitePedidoDto {
  @IsIn(["aprovar", "rejeitar"])
  decisao!: "aprovar" | "rejeitar"
}

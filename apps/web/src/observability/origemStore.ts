import type { ErrorReportOrigem } from "@biblioteca-global/shared"

type OrigemParcial = Omit<ErrorReportOrigem, "rota"> & { rota?: string }

let origemAtual: OrigemParcial = {}

function rotaAtual(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname || "/"
}

/** Atualiza o contexto funcional da próxima chamada HTTP. */
export function marcarOrigem(origem: OrigemParcial): void {
  origemAtual = { ...origemAtual, ...origem }
}

/** Retorna uma cópia segura do contexto atual, sempre com a rota vigente. */
export function getOrigem(): ErrorReportOrigem {
  const { rota: rotaInformada, ...detalhes } = origemAtual
  return {
    rota: rotaInformada ?? rotaAtual(),
    ...detalhes,
  }
}


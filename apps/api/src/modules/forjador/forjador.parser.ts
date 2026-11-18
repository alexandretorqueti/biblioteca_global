import { BadRequestException } from "@nestjs/common"
import type { ForjadorPersonaTexts } from "./forjador.types"

const MIN_TEXT_LENGTH = 1
const MAX_TEXT_LENGTH = 100_000

/** Extrai os três documentos sem aceitar texto parcial ou ambíguo. */
export function parseForjadorResponse(response: string): ForjadorPersonaTexts {
  const names = { soul: "SOUL.md", identity: "IDENTITY.md", agents: "AGENTS.md" } as const
  const result = {} as ForjadorPersonaTexts
  for (const [key, name] of Object.entries(names) as Array<[keyof ForjadorPersonaTexts, string]>) {
    const escaped = name.replace(".", "\\.")
    const pattern = new RegExp(`(?:<<<\\s*${escaped}\\s*>>>|\\[\\s*${escaped}\\s*\\]|---\\s*${escaped}\\s*---)\\s*([\\s\\S]*?)(?:<<<\\s*END\\s*${escaped}\\s*>>>|\\[\\s*END\\s*${escaped}\\s*\\]|---\\s*END\\s*${escaped}\\s*---)`, "i")
    const match = pattern.exec(response)
    const text = match?.[1]?.trim() ?? ""
    if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(`Resposta do Forjador sem ${name} válido`)
    }
    result[key] = text
  }
  return result
}

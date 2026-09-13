export const EMBEDDED_DESCRIPTION_LIMIT = 12_000
export const DEV_DESCRIPTION_MESSAGE_LIMIT = 30_000

export interface DeveloperDescriptionResolution {
  maskValue: string
  contextBlocks: string[]
  reference: string | null
}

export function resolveDeveloperDescription(description?: string): DeveloperDescriptionResolution {
  if (!description) {
    return { maskValue: "N/A", contextBlocks: [], reference: null }
  }

  if (description.length <= EMBEDDED_DESCRIPTION_LIMIT) {
    return { maskValue: description, contextBlocks: [], reference: null }
  }

  const contextBlocks: string[] = []
  for (let offset = 0; offset < description.length; offset += DEV_DESCRIPTION_MESSAGE_LIMIT) {
    contextBlocks.push(description.slice(offset, offset + DEV_DESCRIPTION_MESSAGE_LIMIT))
  }
  const reference = `A descrição integral foi enviada em mensagem separada nesta sessão em ${contextBlocks.length} bloco(s). Use-a do início ao fim.`
  return { maskValue: reference, contextBlocks, reference }
}

const DEFAULT_CHUNK_SIZE = 6_000

/**
 * Divide a descrição que será memorizada pelo analista antes do prompt final.
 * A divisão é determinística e não descarta conteúdo: a concatenação dos
 * blocos sempre recompõe a descrição original normalizada.
 */
export function splitAnalysisDescription(description?: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error('chunkSize deve ser um inteiro positivo')
  const full = (description || 'N/A').trim() || 'N/A'
  const chunks: string[] = []
  for (let offset = 0; offset < full.length; offset += chunkSize) chunks.push(full.slice(offset, offset + chunkSize))
  return chunks
}

export function buildAnalysisContextMessage(chunk: string, index: number, total: number): string {
  const number = index + 1
  return [
    `CONTEXTO DA TAREFA — BLOCO ${number}/${total}`,
    number === 1 ? 'INÍCIO DA DESCRIÇÃO' : 'CONTINUAÇÃO DA DESCRIÇÃO',
    chunk,
    number === total ? 'FIM DA DESCRIÇÃO' : `FIM DO BLOCO ${number}/${total}`,
    'Armazene este contexto. Responda somente CONTEXTO_RECEBIDO; o pedido de análise e o contrato serão enviados depois.',
  ].join('\n\n')
}

export function buildAnalysisDescriptionReference(chunkCount: number): string {
  return `A descrição integral foi enviada anteriormente nesta sessão em ${chunkCount} bloco(s). Use todos os blocos, do INÍCIO ao FIM, sem omitir seções.`
}

export function buildAnalysisContextConfirmation(description: string | undefined, chunkCount: number): string {
  const length = (description || 'N/A').trim().length || 3
  return `CONFIRMAÇÃO DE CONTEXTO: a descrição possui ${length} caracteres, foi enviada em ${chunkCount} bloco(s) e terminou no marcador FIM DA DESCRIÇÃO. Se algum bloco ou marcador estiver ausente, responda pela forma de perguntas informando exatamente o bloco ausente.`
}

export function isContextAcknowledgement(content: string): boolean {
  return /^CONTEXTO_RECEBIDO[.!]*$/i.test(content.trim())
}

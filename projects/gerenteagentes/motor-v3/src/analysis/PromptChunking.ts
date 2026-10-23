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

/**
 * Correção de protocolo enviada quando o analista não responde exatamente
 * CONTEXTO_RECEBIDO a um bloco (ex.: antecipa o JSON final). Usada uma única
 * vez por bloco antes de falhar a tentativa do modelo.
 */
export function buildAnalysisAcknowledgementCorrection(index: number, total: number): string {
  return [
    `[PROTOCOLO] Sua resposta anterior não seguiu o protocolo de confirmação do bloco ${index + 1}/${total}.`,
    'Não execute a análise ainda, não gere JSON nem plano: o pedido de análise e o contrato serão enviados depois.',
    'Responda somente CONTEXTO_RECEBIDO.',
  ].join('\n')
}

export function splitAnalysisPrompt(prompt: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error('chunkSize deve ser um inteiro positivo')
  if (prompt.length <= chunkSize) return [prompt]
  const chunks: string[] = []
  for (let offset = 0; offset < prompt.length; offset += chunkSize) chunks.push(prompt.slice(offset, offset + chunkSize))
  return chunks
}

export function buildAnalysisPromptBlock(chunk: string, index: number, total: number): string {
  return [
    `INSTRUÇÕES DA ANÁLISE — BLOCO ${index + 1}/${total}`,
    chunk,
    `FIM DO BLOCO ${index + 1}/${total}`,
    'Armazene estas instruções sem executar ainda. Responda somente CONTEXTO_RECEBIDO; a autorização para iniciar será enviada após todos os blocos.',
  ].join('\n\n')
}

export function buildAnalysisPromptActivation(total: number): string {
  return `Todos os ${total} blocos das instruções foram enviados. Agora execute a análise usando a descrição e todos os blocos recebidos. Responda somente no formato exigido pelo contrato indicado.`
}

/**
 * Referência de descrição para retomada incremental de clarificação: a
 * descrição integral já foi enviada na sessão anterior e NÃO é reenviada.
 */
export function buildClarificationDescriptionReference(): string {
  return 'A descrição integral já foi enviada nesta sessão na rodada anterior de análise (retomada incremental após clarificação). Não reenviada; use o contexto já memorizado, do INÍCIO ao FIM DA DESCRIÇÃO.'
}

/**
 * Confirmação anexada ao prompt de retomada: pergunta(s) pendente(s) da
 * rodada e a resposta do usuário, com a instrução de continuação contextual
 * sem repetição de perguntas já respondidas (salvo justificativa explícita).
 */
export function buildClarificationAnswerConfirmation(input: {
  roundNumber: number
  questions: string[]
  answer: { chatMessageId: number | null; texto: string } | null
}): string {
  const lines = [
    `[RETOMADA DE CLARIFICAÇÃO — RODADA ${input.roundNumber}]`,
    'Perguntas que estavam pendentes nesta sessão:',
    ...input.questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    input.answer
      ? `Resposta do usuário${input.answer.chatMessageId != null ? ` (mensagem de chat #${input.answer.chatMessageId})` : ''}: ${input.answer.texto}`
      : 'Nenhuma resposta nova foi registrada; considere o histórico de esclarecimentos já presente nesta sessão e no histórico acima.',
    '',
    'Continue a análise a partir do contexto já investigado nesta sessão, sem reiniciar a investigação e sem reler a descrição integral.',
    'Não repita perguntas já respondidas; se precisar repetir alguma, registre a justificativa explícita no resumo da resposta.',
  ]
  return lines.join('\n')
}

/**
 * Prompt de continuação usado quando não há resolvedor de prompt gerenciado
 * (testes/fallback). Mantém a mesma semântica da versão gerenciada.
 */
export function buildClarificationContinuation(
  task: { title: string; taskId: string; taskType: string },
  input: {
    roundNumber: number
    questions: string[]
    answer: { chatMessageId: number | null; texto: string } | null
  },
): string {
  return [
    `[RETOMADA DE CLARIFICAÇÃO — RODADA ${input.roundNumber}]`,
    `Continue a análise da tarefa "${task.title}" (ID: ${task.taskId}, tipo: ${task.taskType}) nesta mesma sessão.`,
    'Não reinicie a investigação nem releia a descrição integral: use o contexto já enviado e memorizado nesta sessão.',
    '',
    buildClarificationAnswerConfirmation(input),
    '',
    'Responda somente com o JSON final conforme o contrato de análise: plano completo com requisitos e matriz de cobertura, verificação direta (quando aplicável) ou novas perguntas objetivas (kind="perguntas") apenas se indispensáveis.',
  ].join('\n')
}

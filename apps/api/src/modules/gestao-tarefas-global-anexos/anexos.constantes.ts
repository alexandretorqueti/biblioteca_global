/**
 * Limite de upload dos anexos (gestao-de-tarefas-global — macro #6,
 * subtarefa 1).
 *
 * O `FileInterceptor` é avaliado no DECORATOR da classe (momento em que a
 * injeção de dependência ainda não existe — `this.env` é `undefined`); por
 * isso o multer limits lê `process.env.ANEXOS_MAX_BYTES` diretamente, com o
 * mesmo default do `EnvService.anexosMaxBytes` (10MB). A validação CANÔNICA
 * continua no service (via EnvService) — o limite do multer é a defesa de
 * memória (rejeita streams gigantes antes do buffer completo).
 */
export const ANEXOS_MAX_BYTES_PADRAO = 10485760

/** Limite efetivo usado pelo multer (env `ANEXOS_MAX_BYTES`, default 10MB). */
export function limiteUploadAnexoBytes(): number {
  const valor = Number(process.env.ANEXOS_MAX_BYTES ?? ANEXOS_MAX_BYTES_PADRAO)
  return Number.isInteger(valor) && valor > 0 ? valor : ANEXOS_MAX_BYTES_PADRAO
}

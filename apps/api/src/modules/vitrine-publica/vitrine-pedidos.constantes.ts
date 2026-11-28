/**
 * Limites de upload do formulário público da vitrine (vitrine-ia —
 * macro #10, posição 3/11 — subtarefa 1), no padrão de
 * `gestao-tarefas-global-anexos/anexos.constantes.ts`.
 *
 * O `FilesInterceptor` é avaliado no DECORATOR da classe (sem DI —
 * `this.env` é `undefined`); por isso o `limits.fileSize` do multer lê
 * `process.env.VITRINE_UPLOAD_MAX_BYTES` diretamente, com o mesmo default do
 * `EnvService.vitrineUploadMaxBytes` (10MB). A validação CANÔNICA de tamanho
 * continua no service (via EnvService) — o limite do multer é a defesa de
 * memória (rejeita streams gigantes antes do buffer completo).
 */
export const VITRINE_UPLOAD_MAX_BYTES_PADRAO = 10485760

/** Limite efetivo usado pelo multer (env `VITRINE_UPLOAD_MAX_BYTES`, default 10MB). */
export function limiteUploadVitrineBytes(): number {
  const valor = Number(
    process.env.VITRINE_UPLOAD_MAX_BYTES ?? VITRINE_UPLOAD_MAX_BYTES_PADRAO,
  )
  return Number.isInteger(valor) && valor > 0 ? valor : VITRINE_UPLOAD_MAX_BYTES_PADRAO
}

/** Máximo de arquivos por pedido (defesa do multer — `maxCount`). */
export const VITRINE_MAX_ARQUIVOS_POR_PEDIDO = 10

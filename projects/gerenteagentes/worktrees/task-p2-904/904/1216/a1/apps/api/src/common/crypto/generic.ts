/**
 * Criptografia genérica AES-256-GCM para campos sensíveis (PoC §11).
 * Reutilizada por CPF, credenciais de banco por projeto, etc.
 * O resultado é `iv:tag:ciphertext` em base64 (mesmo formato do CPF).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export interface EncryptionContext {
  /** Chave de 32 bytes em hex (64 chars) ou base64. */
  keyHexOrBase64: string
  /** Rótulo para mensagens de erro (ex.: "DB_CREDENTIALS_ENCRYPTION_KEY"). */
  keyEnvName: string
}

/** Criptografa um valor sensível usando AES-256-GCM. */
export function encryptValue(value: string, ctx: EncryptionContext): string {
  const key = resolveKey(ctx)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv, authTag, ciphertext].map((part) => part.toString("base64")).join(":")
}

/** Descriptografa o formato produzido por encryptValue. */
export function decryptValue(encrypted: string, ctx: EncryptionContext): string {
  const key = resolveKey(ctx)
  const parts = encrypted.split(":")
  if (parts.length !== 3) {
    throw new Error("Valor criptografado possui formato inválido")
  }

  const iv = Buffer.from(parts[0] ?? "", "base64")
  const authTag = Buffer.from(parts[1] ?? "", "base64")
  const ciphertext = Buffer.from(parts[2] ?? "", "base64")
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH || ciphertext.length === 0) {
    throw new Error("Valor criptografado possui formato inválido")
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

function resolveKey(ctx: EncryptionContext): Buffer {
  const configured = ctx.keyHexOrBase64
  if (!configured) {
    throw new Error(`Variável de ambiente ausente: ${ctx.keyEnvName}`)
  }

  const key = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64")
  if (key.length !== 32) {
    throw new Error(`${ctx.keyEnvName} deve representar exatamente 32 bytes`)
  }
  return key
}

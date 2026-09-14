import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/** Criptografa um CPF usando AES-256-GCM. O resultado é iv:tag:ciphertext em base64. */
export function encryptCpf(cpf: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(cpf, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv, authTag, ciphertext].map((part) => part.toString("base64")).join(":")
}

/** Descriptografa o formato produzido por encryptCpf e valida sua autenticação. */
export function decryptCpf(encryptedCpf: string): string {
  const parts = encryptedCpf.split(":")
  if (parts.length !== 3) {
    throw new Error("CPF criptografado possui formato inválido")
  }

  const iv = Buffer.from(parts[0] ?? "", "base64")
  const authTag = Buffer.from(parts[1] ?? "", "base64")
  const ciphertext = Buffer.from(parts[2] ?? "", "base64")
  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH || ciphertext.length === 0) {
    throw new Error("CPF criptografado possui formato inválido")
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

function encryptionKey(): Buffer {
  const configured = process.env.CPF_ENCRYPTION_KEY
  if (!configured) {
    throw new Error("Variável de ambiente ausente: CPF_ENCRYPTION_KEY")
  }

  const key = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64")
  if (key.length !== 32) {
    throw new Error("CPF_ENCRYPTION_KEY deve representar exatamente 32 bytes")
  }
  return key
}

/**
 * Criptografia de credenciais de banco por projeto (PoC §11).
 * Usa AES-256-GCM com chave dedicada (DB_CREDENTIALS_ENCRYPTION_KEY).
 * Apenas a senha é criptografada; host/porta/database/user são armazenados
 * em texto claro (não são segredos por si só — a senha sim).
 */
import { decryptValue, encryptValue, type EncryptionContext } from "./generic"

const KEY_ENV_NAME = "DB_CREDENTIALS_ENCRYPTION_KEY"

function ctx(): EncryptionContext {
  return {
    keyHexOrBase64: process.env[KEY_ENV_NAME] ?? "",
    keyEnvName: KEY_ENV_NAME,
  }
}

/** Criptografa a senha do banco para armazenamento seguro. */
export function encryptDbPassword(password: string): string {
  return encryptValue(password, ctx())
}

/** Descriptografa a senha do banco (usada internamente pela factory). */
export function decryptDbPassword(encrypted: string): string {
  return decryptValue(encrypted, ctx())
}

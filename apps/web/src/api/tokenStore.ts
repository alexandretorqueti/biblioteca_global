/**
 * TokenStore concreta do apps/web (contrato de @biblioteca-global/api-client).
 *
 * Em memória como fonte da verdade; persistência opcional em localStorage
 * para "lembrar de mim" sobreviver a reload (Etapa 9 — checkout de sessão).
 * Por segurança, o access token NUNCA vai a localStorage: ele é sempre
 * recém-obtido via select-project/refresh após reload.
 */
import type { TokenStore } from "@biblioteca-global/api-client"

const REFRESH_KEY = "bg.refreshToken"
const PROJETO_KEY = "bg.projetoId"

/** Segregada para permitir limpeza em testes e storage indisponível. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    /* storage indisponível (SSR/testes) — segue só em memória */
  }
}

/**
 * Guarda os tokens da sessão. `persist` pode ser ligado/desligado a qualquer
 * momento ("lembrar de mim" no login): ao ligar, recarrega o refresh do
 * storage; ao desligar, apaga do storage.
 *
 * O ID do último projeto selecionado é persistido separadamente (chave
 * `bg.projetoId`) — é informação de UX ("voltar ao projeto anterior após
 * F5"), não de sessão: sobrevive a `setPersist(false)` e só é apagado no
 * `clear()` (logout).
 */
export class LocalTokenStore implements TokenStore {
  private access: string | null = null
  private refresh: string | null = null
  private persistMode = false

  constructor(initialPersist = false) {
    this.persistMode = initialPersist
    if (initialPersist) {
      const stored = readStored(REFRESH_KEY)
      if (stored) this.refresh = stored
    }
    // NOTA: inicializar com persist false NÃO apaga o storage — a sessão
    // "lembrar de mim" precisa sobreviver ao reload (hidratação). Quem
    // apaga é setPersist(false) chamado pelo logout/desligar.
  }

  /** true se há refresh token persistido (hidratação após reload). */
  temRefreshPersistido(): boolean {
    return readStored(REFRESH_KEY) !== null
  }

  /** Ligar/desligar a persistência (lembrar de mim). */
  setPersist(persist: boolean): void {
    this.persistMode = persist
    if (persist) {
      const stored = readStored(REFRESH_KEY)
      if (stored) this.refresh = stored
    } else {
      writeStored(REFRESH_KEY, null)
    }
  }

  getAccessToken(): string | null {
    return this.access
  }

  getRefreshToken(): string | null {
    return this.refresh
  }

  setAccessToken(token: string | null): void {
    this.access = token
  }

  setRefreshToken(token: string | null): void {
    this.refresh = token
    if (this.persistMode) {
      writeStored(REFRESH_KEY, token)
    }
  }

  /** ID do último projeto selecionado (UX — independente de `persistMode`). */
  getProjetoId(): string | null {
    return readStored(PROJETO_KEY)
  }

  setProjetoId(id: string | null): void {
    writeStored(PROJETO_KEY, id)
  }

  clear(): void {
    this.access = null
    this.refresh = null
    writeStored(REFRESH_KEY, null)
    writeStored(PROJETO_KEY, null)
  }
}

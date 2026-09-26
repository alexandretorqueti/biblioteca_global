/**
 * Lógica de renovação de token — pura e unit-testável (Etapa 9).
 *
 * Responsabilidades:
 *  1. Decodificar o claim `exp` do access token JWT (sem validar assinatura
 *     — o back é quem assina; aqui só lemos o prazo para agendar o renew).
 *  2. Calcular quando renovar (antes da expiração).
 *  3. Orquestrar o fluxo 401 → refresh → retry via SessionRecovery.
 */
import type {
  AuthClient,
  SessionRecovery,
  TokenStore,
} from "@biblioteca-global/api-client"

/** Margem de segurança antes da expiração para renovar proativamente (s). */
export const RENEW_MARGIN_SECONDS = 60

/** Parâmetro de renovação agendada — o AuthContext registra/limpa o timer. */
export interface ScheduledRenew {
  timeoutMs: number
  /** Renova a sessão e (re)agenda o próximo ciclo. */
  renew: () => Promise<void>
}

/** Decodifica o claim `exp` (epoch seconds) de um JWT; null se inválido. */
export function decodeAccessTokenExp(token: string): number | null {
  const partes = token.split(".")
  if (partes.length !== 3) return null
  const payload = partes[1]
  if (!payload) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(
      decodeURIComponent(
        Array.from(atob(payload), (c) =>
          `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
        ).join(""),
      ),
    )
  } catch {
    return null
  }
  if (
    !decoded ||
    typeof decoded !== "object" ||
    !("exp" in decoded) ||
    typeof (decoded as { exp?: unknown }).exp !== "number"
  ) {
    return null
  }
  return (decoded as { exp: number }).exp
}

/**
 * Milissegundos até o refresh proativo, com margem de segurança.
 * Retorna null se não houver exp conhecida (nada a agendar; o recovery
 * cobre o 401).
 */
export function delayUntilRefreshMs(
  exp: number | null,
  nowSeconds: number,
): number | null {
  if (exp === null) return null
  const ms = (exp - nowSeconds - RENEW_MARGIN_SECONDS) * 1000
  if (ms <= 0) return null
  return ms
}

/** Callback de sessão usada nos timers (setTimeout) — teste injeta o runner. */
export type TimerRunner = (
  callback: () => void,
  timeoutMs: number,
) => unknown

/**
 * Encapsula a renovação automática. O AuthContext injeta `onRenew`.
 * `notDueYet` permite que o ciclo continue agendando sem renovar de fato.
 */
export interface TokenRefresherOptions {
  /** Renova a sessão de verdade (refresh + re-seleção de projeto). */
  onRenew: () => Promise<void>
  /** Roda os timers; padrão = setTimeout. */
  runTimer?: TimerRunner
  /** Limpa um timer agendado; padrão = clearTimeout. */
  clearTimer?: (handle: unknown) => void
}

export class TokenRefresher {
  private handle: unknown = null
  private readonly runTimer: TimerRunner
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: TokenRefresherOptions) {
    this.runTimer =
      options.runTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** Agenda o próximo refresh baseado na expiração do access token atual. */
  schedule(getExp: () => number | null, nowSeconds: number): void {
    this.cancel()
    const exp = getExp()
    const ms = delayUntilRefreshMs(exp, nowSeconds)
    if (ms === null) return
    this.handle = this.runTimer(() => {
      void this.options.onRenew()
    }, ms)
  }

  cancel(): void {
    if (this.handle !== null) {
      this.clearTimer(this.handle)
      this.handle = null
    }
  }
}

/**
 * Monta a SessionRecovery do ApiHttpClient: em 401 → renova a sessão →
 * devolve true (a chamada original é repetida) ou false (assume o 401).
 * `renew` é fornecido pelo AuthContext (faz refresh + select-project).
 */
export function createSessionRecovery(
  renew: () => Promise<boolean>,
): SessionRecovery {
  return () => renew()
}

/** Helper assíncrono para login de teste/integração (evita duplicação). */
export function lerExpDoAccessStore(
  store: TokenStore,
): number | null {
  const token = store.getAccessToken()
  return token ? decodeAccessTokenExp(token) : null
}

// Re-export usado por AuthContext apenas para tipos internos.
export type { AuthClient }

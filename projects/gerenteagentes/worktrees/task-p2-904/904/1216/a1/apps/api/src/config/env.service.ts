/**
 * Ambiente tipado da API (PoC §6.1 — config/).
 * Lê do ConfigModule (@nestjs/config), que carrega o .env da raiz.
 */
import { Inject, Injectable } from "@nestjs/common"
import { ConfigService } from "@nestjs/config"

@Injectable()
export class EnvService {
  // @Inject explícito: funciona mesmo sem emitDecoratorMetadata (tsx/esbuild).
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  get mysqlHost(): string {
    return this.required("MYSQL_HOST")
  }

  get mysqlPort(): number {
    return Number(this.required("MYSQL_PORT"))
  }

  get mysqlUser(): string {
    return this.required("MYSQL_USER")
  }

  get mysqlPassword(): string {
    return this.required("MYSQL_PASSWORD")
  }

  /** Usuário root — somente para DDL do provisionamento de projetos. */
  get mysqlRootPassword(): string {
    return this.required("MYSQL_ROOT_PASSWORD")
  }

  get mysqlDatabase(): string {
    return this.required("MYSQL_DATABASE")
  }

  get jwtSecret(): string {
    return this.required("JWT_SECRET")
  }

  /** TTL do access token (padrão seguro: 2 horas). */
  get jwtAccessExpiration(): string {
    return (
      this.config.get<string>("JWT_ACCESS_EXPIRATION") ??
      this.config.get<string>("JWT_ACCESS_TTL") ??
      "2h"
    )
  }

  /** TTL do refresh token (global, revogável; padrão: 7 dias). */
  get refreshTokenTtlDays(): number {
    const expiration =
      this.config.get<string>("JWT_REFRESH_EXPIRATION") ??
      (this.config.get<string>("REFRESH_TOKEN_TTL_DAYS")
        ? `${this.config.get<string>("REFRESH_TOKEN_TTL_DAYS")}d`
        : "7d")
    const match = /^(\d+(?:\.\d+)?)d$/.exec(expiration.trim())
    return match ? Number(match[1]) : 7
  }

  get apiPort(): number {
    return Number(this.config.get<string>("API_PORT") ?? "3001")
  }

  /**
   * APENAS DEBUG: envia mensagem e stack de exceções inesperadas ao cliente.
   * Deve permanecer desligado em produção para não expor detalhes internos.
   */
  get exposeRealErrors(): boolean {
    return this.config.get<string>("API_EXPOSE_REAL_ERRORS") === "true"
  }

  // ── Auth por código (passwordless) ───────────────────────────────────

  /** Segredo HMAC-SHA256 dos códigos de verificação (D5). */
  get authCodeSecret(): string {
    return this.required("AUTH_CODE_SECRET")
  }

  /** TTL do código em ms (padrão 10 min). */
  get authCodeTtlMs(): number {
    return Number(this.config.get<string>("AUTH_CODE_TTL_MS") ?? "600000")
  }

  /** Máximo de tentativas de verificação por código (estouro invalida). */
  get authMaxAttempts(): number {
    return Number(this.config.get<string>("AUTH_MAX_ATTEMPTS") ?? "5")
  }

  /** Códigos permitidos por janela (rate-limit no request-code). */
  get authRateLimitMax(): number {
    return Number(this.config.get<string>("AUTH_RATE_LIMIT_MAX") ?? "3")
  }

  /** Janela do rate-limit em ms (padrão 15 min). */
  get authRateLimitWindowMs(): number {
    return Number(
      this.config.get<string>("AUTH_RATE_LIMIT_WINDOW_MS") ?? "900000",
    )
  }

  /** TTL do token efêmero emitido no verify-code (1ª vez, sem senha). */
  get authVerifyTokenTtl(): string {
    return this.config.get<string>("AUTH_VERIFY_TOKEN_TTL") ?? "5m"
  }

  /**
   * APENAS DEBUG (default off): loga o código quando o SMTP não está
   * configurado — usado na validação manual (Etapa 11 do passo a passo).
   * NUNCA ligar em produção.
   */
  get authCodeDebugLog(): boolean {
    return this.config.get<string>("AUTH_CODE_DEBUG_LOG") === "true"
  }

  // ── E-mail (SMTP) ────────────────────────────────────────────────────

  get smtpHost(): string {
    return this.config.get<string>("SMTP_HOST") ?? ""
  }

  get smtpPort(): number {
    return Number(this.config.get<string>("SMTP_PORT") ?? "587")
  }

  get smtpUser(): string {
    return this.config.get<string>("SMTP_USER") ?? ""
  }

  get smtpPassword(): string {
    return this.config.get<string>("SMTP_PASSWORD") ?? ""
  }

  get smtpFrom(): string {
    return (
      this.config.get<string>("SMTP_FROM") ??
      "noreply@globaltecnologia.com.br"
    )
  }

  // ── Provisionamento (token de serviço) ───────────────────────────────

  /** Token de serviço do GerenteAgentes (nunca logar). */
  get provisionToken(): string {
    return this.required("PROVISION_TOKEN")
  }

  /** Token exclusivo para ingestão de eventos do motor de tarefas. */
  get libraryRealtimeEventsToken(): string {
    return this.config.get<string>("LIBRARY_REALTIME_EVENTS_TOKEN") ?? ""
  }

  private required(key: string): string {
    const valor = this.config.get<string>(key)
    if (!valor) {
      throw new Error(
        `Variável de ambiente ausente: ${key} — copie .env.example para .env e ajuste.`,
      )
    }
    return valor
  }
}

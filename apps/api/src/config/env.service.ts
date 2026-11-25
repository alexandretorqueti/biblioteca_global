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
   * Modo produção por padrão de segurança: `true` quando NODE_ENV=production.
   * O ConfigService do @nestjs/config já incorpora o process.env, então a
   * leitura via config cobre tanto o .env quanto o ambiente do processo
   * (containers blue-green definem NODE_ENV no processo, não no .env).
   */
  get isProduction(): boolean {
    return this.config.get<string>("NODE_ENV") === "production"
  }

  /**
   * APENAS DEBUG: envia mensagem e stack de exceções inesperadas ao cliente.
   * Em produção (NODE_ENV=production) NUNCA expõe detalhes reais, mesmo com
   * API_EXPOSE_REAL_ERRORS=true — o comportamento seguro é o padrão.
   */
  get exposeRealErrors(): boolean {
    if (this.isProduction) return false
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

  get tenantIngestToken(): string { return this.required("TENANT_INGEST_TOKEN") }

  /** Token de serviço da API interna de forjamento de personas. */
  get forjadorToken(): string {
    return this.required("FORJADOR_TOKEN")
  }

  /** Upstream do BFF do Console (com fallback para a ponte legada da Isa). */
  get forjadorBffUpstream(): string {
    return this.config.get<string>("FORJADOR_BFF_UPSTREAM")
      || this.config.get<string>("ISA_BFF_UPSTREAM")
      || ""
  }

  /** Token do BFF do Console (com fallback para a ponte legada da Isa). */
  get forjadorBffToken(): string {
    return this.config.get<string>("FORJADOR_BFF_TOKEN")
      || this.config.get<string>("ISA_BFF_TOKEN")
      || ""
  }

  get forjadorAgentId(): string {
    return this.config.get<string>("FORJADOR_AGENT_ID") || "definicaopersonalidadeagentes"
  }

  /** Limite de espera do forjamento; nunca permite exceder 30 minutos. */
  get forjadorTimeoutMs(): number {
    const value = Number(this.config.get<string>("FORJADOR_TIMEOUT_MS") ?? "1740000")
    if (!Number.isInteger(value) || value < 1000 || value > 1_800_000) {
      throw new Error("FORJADOR_TIMEOUT_MS deve ser um inteiro entre 1000 e 1800000 ms")
    }
    return value
  }

  get vendasAceiteManual(): boolean {
    return this.config.get<string>("VENDAS_ACEITE_MANUAL") !== "false"
  }

  /** Token exclusivo para ingestão de eventos do motor de tarefas. */
  get libraryRealtimeEventsToken(): string {
    return this.config.get<string>("LIBRARY_REALTIME_EVENTS_TOKEN") ?? ""
  }

  // ── Billing / Mercado Pago ──────────────────────────────────────────

  get pspProvider(): string {
    return this.required("PSP_PROVIDER")
  }

  get pspAccessToken(): string {
    return this.required("PSP_ACCESS_TOKEN")
  }

  get pspWebhookSecret(): string {
    return this.required("PSP_WEBHOOK_SECRET")
  }

  get pspApiUrl(): string {
    return this.config.get<string>("PSP_API_URL") ?? "https://api.mercadopago.com"
  }

  get pspTimeoutMs(): number {
    const value = Number(this.config.get<string>("PSP_TIMEOUT_MS") ?? "10000")
    if (!Number.isInteger(value) || value < 100 || value > 120000) {
      throw new Error("PSP_TIMEOUT_MS deve ser um inteiro entre 100 e 120000 ms")
    }
    return value
  }

  get vendasDocumentosDir(): string {
    return this.config.get<string>("VENDAS_DOCUMENTOS_DIR") ?? "/data/vendas-documentos"
  }

  get vendasDocumentosMaxBytes(): number {
    const value = Number(this.config.get<string>("VENDAS_DOCUMENTOS_MAX_BYTES") ?? "10485760")
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("VENDAS_DOCUMENTOS_MAX_BYTES deve ser um inteiro positivo")
    }
    return value
  }

  /** Diretório de armazenamento dos anexos de tarefas (gestao-de-tarefas-global). */
  get anexosDir(): string {
    return this.config.get<string>("ANEXOS_DIR") ?? "/data/gestao-tarefas-anexos"
  }

  /** Limite máximo de bytes por anexo (default ~10MB). */
  get anexosMaxBytes(): number {
    const value = Number(this.config.get<string>("ANEXOS_MAX_BYTES") ?? "10485760")
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error("ANEXOS_MAX_BYTES deve ser um inteiro positivo")
    }
    return value
  }

  get telegramBotToken(): string {
    return this.config.get<string>("TELEGRAM_BOT_TOKEN") ?? ""
  }

  get telegramDlqChatId(): string {
    return this.config.get<string>("TELEGRAM_DLQ_CHAT_ID") ?? ""
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

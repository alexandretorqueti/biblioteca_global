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

  get mysqlDatabase(): string {
    return this.required("MYSQL_DATABASE")
  }

  get jwtSecret(): string {
    return this.required("JWT_SECRET")
  }

  /** TTL do access token (PoC §5.2 — curto, ~15 min). */
  get jwtAccessTtl(): string {
    return this.config.get<string>("JWT_ACCESS_TTL") ?? "15m"
  }

  /** TTL do refresh token em dias (global, revogável). */
  get refreshTokenTtlDays(): number {
    return Number(this.config.get<string>("REFRESH_TOKEN_TTL_DAYS") ?? "7")
  }

  get apiPort(): number {
    return Number(this.config.get<string>("API_PORT") ?? "3001")
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

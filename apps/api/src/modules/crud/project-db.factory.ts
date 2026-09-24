/**
 * Fábrica de conexões por projeto (PoC §6.1 database/projects):
 * - Cache por projetoId com invalidação por fingerprint (config change → reconnect).
 * - Projeto sem configuração customizada: usa MYSQL_* do env e database `projeto_<id>`.
 * - Projeto com configuração customizada: usa host/porta/database/user/senha próprios.
 * - A seleção é baseada no projeto do token (id derivado, nunca do payload).
 * - Credenciais descriptografadas em memória (AES-256-GCM) — NUNCA logadas.
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common"
import { eq } from "drizzle-orm"
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2"
import mysql, { type Pool } from "mysql2/promise"
import { EnvService } from "../../config/env.service"
import { CORE_DB, type CoreDb } from "../../database/database.module"
import { decryptDbPassword } from "../../common/crypto/db-credentials"
import { projetos } from "../../../../../database/schema"
import { nomeDatabaseDoProjeto } from "../projetos/projetos.service"

export type ProjetoDb = MySql2Database

export interface ConexaoProjeto {
  db: ProjetoDb
  fechar(): Promise<void>
}

/**
 * Opções completas de conexão MySQL — o conector recebe tudo que precisa
 * para criar o pool, sem depender de env internally.
 */
export interface OpcoesConexao {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/** Injetável para testes unitários (fake sem MySQL real). */
export type ConectorProjeto = (opcoes: OpcoesConexao) => Promise<ConexaoProjeto>

export const CONECTOR_PROJETO = Symbol("CONECTOR_PROJETO")
export const PROJECT_DB_FACTORY = Symbol("PROJECT_DB_FACTORY")

/** Conector padrão: pool mysql2 com as opções fornecidas pela factory. */
export function criarConectorPadrao(): ConectorProjeto {
  return async (opcoes: OpcoesConexao): Promise<ConexaoProjeto> => {
    const pool: Pool = mysql.createPool({
      host: opcoes.host,
      port: opcoes.port,
      user: opcoes.user,
      password: opcoes.password,
      database: opcoes.database,
      connectionLimit: 3,
      waitForConnections: true,
    })
    return {
      db: drizzle(pool, { mode: "default" }),
      fechar: () => pool.end(),
    }
  }
}

/** Configuração de conexão customizada lida do core (campos sensíveis inclusos). */
interface ProjetoConfigRow {
  dbHost: string | null
  dbPort: number | null
  dbDatabase: string | null
  dbUser: string | null
  dbPasswordCriptografado: string | null
}

/**
 * Entrada de cache: conexão ativa + fingerprint da configuração que a gerou.
 * Quando a configuração muda (ex.: rotação de senha), o fingerprint difere
 * e a conexão antiga é fechada antes de criar a nova.
 */
interface CacheEntry {
  conexao: ConexaoProjeto
  fingerprint: string
}

@Injectable()
export class ProjectDbFactory implements OnModuleDestroy {
  private readonly logger = new Logger(ProjectDbFactory.name)
  private readonly cache = new Map<number, CacheEntry>()

  constructor(
    @Inject(CONECTOR_PROJETO) private readonly conector: ConectorProjeto,
    @Inject(CORE_DB) private readonly coreDb: CoreDb,
    private readonly env: EnvService,
  ) {}

  async obter(projeto: { id: number }): Promise<ProjetoDb> {
    const config = await this.buscarConfig(projeto.id)
    const fingerprint = this.calcularFingerprint(config)

    const existente = this.cache.get(projeto.id)
    if (existente && existente.fingerprint === fingerprint) {
      return existente.conexao.db
    }

    // Configuração mudou ou primeira vez — fechar conexão antiga se existir.
    if (existente) {
      this.logger.log(`Configuração MySQL do projeto ${projeto.id} alterada — reconectando`)
      await existente.conexao.fechar().catch(() => undefined)
    }

    const opcoes = this.resolverOpcoes(config, projeto.id)
    const conexao = await this.conector(opcoes)
    this.cache.set(projeto.id, { conexao, fingerprint })
    return conexao.db
  }

  /**
   * Fecha todas as conexões em cache (chamado no shutdown do módulo).
   */
  async onModuleDestroy(): Promise<void> {
    for (const entry of this.cache.values()) {
      await entry.conexao.fechar().catch(() => undefined)
    }
    this.cache.clear()
  }

  /**
   * Busca os campos de conexão customizada do projeto no core.
   * Retorna undefined se o projeto não existir (usa padrão).
   */
  private async buscarConfig(projetoId: number): Promise<ProjetoConfigRow | undefined> {
    const linhas = await this.coreDb
      .select({
        dbHost: projetos.dbHost,
        dbPort: projetos.dbPort,
        dbDatabase: projetos.dbDatabase,
        dbUser: projetos.dbUser,
        dbPasswordCriptografado: projetos.dbPasswordCriptografado,
      })
      .from(projetos)
      .where(eq(projetos.id, projetoId))
      .limit(1)
    return linhas.at(0)
  }

  /**
   * Resolve as opções de conexão: customizadas (se o projeto tem config completa)
   * ou padrão (env + database derivado do id).
   *
   * A senha é descriptografada em memória apenas quando necessária e nunca logada.
   */
  private resolverOpcoes(config: ProjetoConfigRow | undefined, projetoId: number): OpcoesConexao {
    if (this.temConfigCustomizada(config)) {
      return {
        host: config!.dbHost!,
        port: config!.dbPort!,
        user: config!.dbUser!,
        password: decryptDbPassword(config!.dbPasswordCriptografado!),
        database: config!.dbDatabase!,
      }
    }

    // Padrão: credenciais do env, database derivado do id (nunca do input do cliente).
    return {
      host: this.env.mysqlHost,
      port: this.env.mysqlPort,
      user: this.env.mysqlUser,
      password: this.env.mysqlPassword,
      database: nomeDatabaseDoProjeto(projetoId),
    }
  }

  /**
   * Configuração customizada é considerada completa quando TODOS os campos
   * estão preenchidos. Campos parciais são ignorados (fallback para padrão).
   */
  private temConfigCustomizada(config: ProjetoConfigRow | undefined): boolean {
    return Boolean(
      config?.dbHost &&
      config.dbPort &&
      config.dbDatabase &&
      config.dbUser &&
      config.dbPasswordCriptografado,
    )
  }

  /**
   * Fingerprint da configuração — usado para detectar mudanças.
   * Inclui a senha CRIPTOGRAFADA (não a descriptografada) para segurança.
   * Nunca logar este valor em produção (contém hash da senha).
   */
  private calcularFingerprint(config: ProjetoConfigRow | undefined): string {
    if (!this.temConfigCustomizada(config)) {
      return "default"
    }
    // Fingerprint baseado nos campos customizados — muda quando qualquer campo é alterado.
    return [
      config!.dbHost,
      String(config!.dbPort),
      config!.dbDatabase,
      config!.dbUser,
      config!.dbPasswordCriptografado,
    ].join("|")
  }
}

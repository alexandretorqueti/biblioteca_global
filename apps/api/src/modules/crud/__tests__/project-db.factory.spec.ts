// @vitest-environment node
/**
 * Testes da ProjectDbFactory — cenários:
 * 1. Projeto sem configuração customizada → fallback para env + projeto_<id>
 * 2. Projeto com configuração customizada → usa host/porta/database/user/senha próprios
 * 3. Cache: mesma instância para chamadas consecutivas
 * 4. Invalidação: alteração de credenciais fecha e recria a conexão
 * 5. Segurança: credenciais não aparecem em logs
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { createCipheriv, randomBytes } from "node:crypto"
import {
  ProjectDbFactory,
  criarConectorPadrao,
  type ConectorProjeto,
  type ConexaoProjeto,
  type OpcoesConexao,
  type ProjetoDb,
} from "../project-db.factory"
import type { CoreDb } from "../../../database/database.module"
import type { EnvService } from "../../../config/env.service"

// ── Helpers ──────────────────────────────────────────────────────────────

interface ProjetoConfig {
  dbHost: string | null
  dbPort: number | null
  dbDatabase: string | null
  dbUser: string | null
  dbPasswordCriptografado: string | null
}

/** Estado compartilhado para o fakeCoreDb — setado antes de cada obter(). */
let ultimoProjetoConsultado = 0
let configsPorProjeto = new Map<number, ProjetoConfig>()

/**
 * Fake CoreDb que simula a consulta de config do projeto.
 * O `where()` captura o id via `ultimoProjetoConsultado` (variável de teste).
 */
function fakeCoreDb(): CoreDb {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            const id = ultimoProjetoConsultado
            const row = configsPorProjeto.get(id)
            const result: ProjetoConfig[] = row
              ? [{
                  dbHost: row.dbHost,
                  dbPort: row.dbPort,
                  dbDatabase: row.dbDatabase,
                  dbUser: row.dbUser,
                  dbPasswordCriptografado: row.dbPasswordCriptografado,
                }]
              : []
            return { at: (i: number) => result[i] }
          },
        }),
      }),
    }),
  } as unknown as CoreDb
}

/** Fake EnvService com valores padrão. */
function fakeEnv(overrides: Partial<{
  mysqlHost: string
  mysqlPort: number
  mysqlUser: string
  mysqlPassword: string
}> = {}): EnvService {
  return {
    mysqlHost: overrides.mysqlHost ?? "localhost",
    mysqlPort: overrides.mysqlPort ?? 3306,
    mysqlUser: overrides.mysqlUser ?? "root",
    mysqlPassword: overrides.mysqlPassword ?? "env-password",
  } as EnvService
}

/**
 * Conector fake que registra as opções recebidas e retorna um db marcador.
 */
function fakeConector(registro: OpcoesConexao[]): ConectorProjeto {
  return async (opcoes: OpcoesConexao): Promise<ConexaoProjeto> => {
    registro.push({ ...opcoes })
    return {
      db: { _opcoes: opcoes } as unknown as ProjetoDb,
      fechar: async () => undefined,
    }
  }
}

/**
 * Conector fake simples — registra opções e retorna db com marcador de database.
 */
function fakeConectorSimples(registro: OpcoesConexao[]): ConectorProjeto {
  return async (opcoes: OpcoesConexao): Promise<ConexaoProjeto> => {
    registro.push({ ...opcoes })
    return {
      db: { marcador: opcoes.database } as unknown as ProjetoDb,
      fechar: async () => undefined,
    }
  }
}

/**
 * Criptografa uma senha para testes (AES-256-GCM) — mesma lógica do
 * `encryptDbPassword` mas inline para evitar dependência de env var.
 * Usa a mesma chave que o `vi.stubEnv` configura nos testes.
 */
function encryptForTest(value: string): string {
  const key = Buffer.from("a".repeat(64), "hex") // 32 bytes
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv, authTag, ciphertext].map((p) => p.toString("base64")).join(":")
}

// ── Testes ───────────────────────────────────────────────────────────────

describe("ProjectDbFactory — fallback para padrão (env + projeto_<id>)", () => {
  let registro: OpcoesConexao[]

  beforeEach(() => {
    registro = []
    configsPorProjeto = new Map()
    ultimoProjetoConsultado = 0
  })

  it("projeto sem config customizada usa credenciais do env e database projeto_<id>", async () => {
    const coreDb = fakeCoreDb()
    const env = fakeEnv({ mysqlHost: "db.local", mysqlPort: 3307, mysqlUser: "app", mysqlPassword: "s3cret" })
    const conector = fakeConectorSimples(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 5
    await factory.obter({ id: 5 })

    expect(registro).toHaveLength(1)
    const primeira = registro[0]!
    expect(primeira.host).toBe("db.local")
    expect(primeira.port).toBe(3307)
    expect(primeira.user).toBe("app")
    expect(primeira.password).toBe("s3cret")
    expect(primeira.database).toBe("projeto_5")
  })

  it("projeto com config parcial (só host) cai no fallback padrão", async () => {
    configsPorProjeto.set(10, {
      dbHost: "external.db.com",
      dbPort: null,
      dbDatabase: null,
      dbUser: null,
      dbPasswordCriptografado: null,
    })
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConectorSimples(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 10
    await factory.obter({ id: 10 })

    const primeira = registro[0]!
    // Config parcial → fallback para padrão
    expect(primeira.host).toBe("localhost")
    expect(primeira.database).toBe("projeto_10")
  })

  it("projeto inexistente no core usa fallback padrão", async () => {
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConectorSimples(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 999
    await factory.obter({ id: 999 })

    const primeira = registro[0]!
    expect(primeira.database).toBe("projeto_999")
    expect(primeira.host).toBe("localhost")
  })
})

describe("ProjectDbFactory — conexão customizada", () => {
  let registro: OpcoesConexao[]

  beforeEach(() => {
    registro = []
    configsPorProjeto = new Map()
    ultimoProjetoConsultado = 0
    // Chave usada por encryptForTest e decryptDbPassword (lê de process.env)
    vi.stubEnv("DB_CREDENTIALS_ENCRYPTION_KEY", "a".repeat(64))
  })

  it("projeto com config completa usa host/porta/database/user/senha próprios", async () => {
    const senhaCriptografada = encryptForTest("P@ssw0rd!")
    configsPorProjeto.set(6241, {
      dbHost: "dbaas.example.com",
      dbPort: 3307,
      dbDatabase: "bdportalemp",
      dbUser: "portal_user",
      dbPasswordCriptografado: senhaCriptografada,
    })
    const coreDb = fakeCoreDb()
    const env = fakeEnv() // não deve ser usado
    const conector = fakeConector(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 6241
    await factory.obter({ id: 6241 })

    expect(registro).toHaveLength(1)
    const primeira = registro[0]!
    expect(primeira.host).toBe("dbaas.example.com")
    expect(primeira.port).toBe(3307)
    expect(primeira.user).toBe("portal_user")
    expect(primeira.password).toBe("P@ssw0rd!") // descriptografada em memória
    expect(primeira.database).toBe("bdportalemp")
  })

  it("senha descriptografada não é a mesma que a criptografada", async () => {
    const senhaCriptografada = encryptForTest("real-password")
    configsPorProjeto.set(100, {
      dbHost: "remote.db",
      dbPort: 3306,
      dbDatabase: "mydb",
      dbUser: "user",
      dbPasswordCriptografado: senhaCriptografada,
    })
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConector(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 100
    await factory.obter({ id: 100 })

    const primeira = registro[0]!
    // A senha passada ao conector é a descriptografada, não a criptografada
    expect(primeira.password).toBe("real-password")
    expect(primeira.password).not.toBe(senhaCriptografada)
  })
})

describe("ProjectDbFactory — cache", () => {
  let registro: OpcoesConexao[]

  beforeEach(() => {
    registro = []
    configsPorProjeto = new Map()
    ultimoProjetoConsultado = 0
  })

  it("mesma instância por projeto (cache) — conector chamado uma única vez", async () => {
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConectorSimples(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 5
    const db1 = await factory.obter({ id: 5 })
    const db2 = await factory.obter({ id: 5 })

    expect(db1).toBe(db2) // mesma instância
    expect(registro).toHaveLength(1) // conector chamado uma vez
  })

  it("projetos diferentes geram conexões diferentes", async () => {
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConectorSimples(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 5
    await factory.obter({ id: 5 })
    ultimoProjetoConsultado = 6
    await factory.obter({ id: 6 })

    expect(registro).toHaveLength(2)
    expect(registro[0]!.database).toBe("projeto_5")
    expect(registro[1]!.database).toBe("projeto_6")
  })
})

describe("ProjectDbFactory — invalidação de cache por mudança de configuração", () => {
  let registro: OpcoesConexao[]

  beforeEach(() => {
    registro = []
    configsPorProjeto = new Map()
    ultimoProjetoConsultado = 0
    vi.stubEnv("DB_CREDENTIALS_ENCRYPTION_KEY", "a".repeat(64))
  })

  it("alteração de senha criptografada fecha conexão antiga e cria nova", async () => {
    const senha1 = encryptForTest("password-v1")
    configsPorProjeto.set(42, {
      dbHost: "remote.db",
      dbPort: 3306,
      dbDatabase: "mydb",
      dbUser: "user",
      dbPasswordCriptografado: senha1,
    })

    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conexoesFechadas: number[] = []
    const conector: ConectorProjeto = async (opcoes: OpcoesConexao) => {
      const idx = registro.length
      registro.push({ ...opcoes })
      return {
        db: { idx } as unknown as ProjetoDb,
        fechar: async () => { conexoesFechadas.push(idx) },
      }
    }
    const factory = new ProjectDbFactory(conector, coreDb, env)

    // Primeira conexão
    ultimoProjetoConsultado = 42
    const db1 = await factory.obter({ id: 42 })
    expect(registro).toHaveLength(1)
    expect(registro[0]!.password).toBe("password-v1")

    // Simula rotação de senha (muda o valor criptografado no "banco")
    const senha2 = encryptForTest("password-v2")
    configsPorProjeto.set(42, {
      ...(configsPorProjeto.get(42) ?? { dbHost: null, dbPort: null, dbDatabase: null, dbUser: null, dbPasswordCriptografado: null }),
      dbPasswordCriptografado: senha2,
    })

    // Próxima chamada deve detectar a mudança e reconectar
    const db2 = await factory.obter({ id: 42 })
    expect(db1).not.toBe(db2) // instâncias diferentes
    expect(registro).toHaveLength(2)
    expect(registro[1]!.password).toBe("password-v2")
    expect(conexoesFechadas).toContain(0) // conexão antiga foi fechada
  })

  it("alteração de host fecha conexão antiga e cria nova", async () => {
    configsPorProjeto.set(7, {
      dbHost: "host1.db.com",
      dbPort: 3306,
      dbDatabase: "db1",
      dbUser: "user",
      dbPasswordCriptografado: encryptForTest("pass"),
    })

    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConector(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 7
    await factory.obter({ id: 7 })
    expect(registro[0]!.host).toBe("host1.db.com")

    // Muda o host
    configsPorProjeto.set(7, {
      ...(configsPorProjeto.get(7) ?? { dbHost: null, dbPort: null, dbDatabase: null, dbUser: null, dbPasswordCriptografado: null }),
      dbHost: "host2.db.com",
    })

    await factory.obter({ id: 7 })
    expect(registro).toHaveLength(2)
    expect(registro[1]!.host).toBe("host2.db.com")
  })

  it("remoção de config customizada volta para o padrão", async () => {
    configsPorProjeto.set(15, {
      dbHost: "remote.db",
      dbPort: 3306,
      dbDatabase: "custom_db",
      dbUser: "user",
      dbPasswordCriptografado: encryptForTest("pass"),
    })

    const coreDb = fakeCoreDb()
    const env = fakeEnv({ mysqlHost: "default.host" })
    const conector = fakeConector(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    ultimoProjetoConsultado = 15
    await factory.obter({ id: 15 })
    expect(registro[0]!.host).toBe("remote.db")
    expect(registro[0]!.database).toBe("custom_db")

    // Remove a config customizada (simula admin limpando os campos)
    configsPorProjeto.set(15, {
      dbHost: null,
      dbPort: null,
      dbDatabase: null,
      dbUser: null,
      dbPasswordCriptografado: null,
    })

    await factory.obter({ id: 15 })
    expect(registro).toHaveLength(2)
    expect(registro[1]!.host).toBe("default.host")
    expect(registro[1]!.database).toBe("projeto_15")
  })
})

describe("ProjectDbFactory — segurança (credenciais em logs)", () => {
  beforeEach(() => {
    configsPorProjeto = new Map()
    ultimoProjetoConsultado = 0
    vi.stubEnv("DB_CREDENTIALS_ENCRYPTION_KEY", "a".repeat(64))
  })

  it("nenhum log contém senha descriptografada ou criptografada", async () => {
    const senhaCriptografada = encryptForTest("super-secret-password")
    configsPorProjeto.set(99, {
      dbHost: "remote.db",
      dbPort: 3306,
      dbDatabase: "mydb",
      dbUser: "user",
      dbPasswordCriptografado: senhaCriptografada,
    })
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const registro: OpcoesConexao[] = []
    const conector = fakeConector(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    // Captura logs do Logger
    const loggerInstance = (factory as unknown as { logger: { log: (...args: unknown[]) => void } }).logger
    const logSpy = vi.spyOn(loggerInstance, "log")

    ultimoProjetoConsultado = 99
    await factory.obter({ id: 99 })

    // Verifica que nenhum argumento de log contém a senha
    for (const call of logSpy.mock.calls) {
      const logText = call.map(String).join(" ")
      expect(logText).not.toContain("super-secret-password")
      expect(logText).not.toContain(senhaCriptografada)
    }

    // A senha descriptografada está nas opções do conector (uso interno) mas não em logs
    expect(registro[0]!.password).toBe("super-secret-password")
  })
})

describe("ProjectDbFactory — database derivado do id (sem input do cliente)", () => {
  beforeEach(() => {
    configsPorProjeto = new Map()
    ultimoProjetoConsultado = 0
  })

  it("no fallback, database é sempre projeto_<id> — nunca input externo", async () => {
    const registro: OpcoesConexao[] = []
    const coreDb = fakeCoreDb()
    const env = fakeEnv()
    const conector = fakeConectorSimples(registro)
    const factory = new ProjectDbFactory(conector, coreDb, env)

    // Simula chamadas com ids variados — o database é SEMPRE derivado
    for (const id of [1, 42, 6241, 99999]) {
      ultimoProjetoConsultado = id
      await factory.obter({ id })
    }

    expect(registro.every((r) => /^projeto_[0-9]+$/.test(r.database))).toBe(true)
    expect(registro.map((r) => r.database)).toEqual([
      "projeto_1", "projeto_42", "projeto_6241", "projeto_99999",
    ])
  })
})

describe("criarConectorPadrao", () => {
  it("não depende de EnvService — recebe opções completas", () => {
    // criarConectorPadrao não recebe mais env — é uma factory de conector puro
    const conector = criarConectorPadrao()
    expect(typeof conector).toBe("function")
  })
})

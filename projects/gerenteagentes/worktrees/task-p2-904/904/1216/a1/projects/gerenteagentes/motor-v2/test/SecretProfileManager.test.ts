import { execSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  SecretProfileManager,
  TASK_ENVIRONMENT_MANIFEST,
  checkGitSecurity,
  resolveGitTopLevel,
  type EnvironmentManifest,
} from "../src/workspaces/SecretProfileManager.js"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "motor-v2-secrets-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function writeManifest(content: unknown): Promise<void> {
  return writeFile(join(tempDir, TASK_ENVIRONMENT_MANIFEST), JSON.stringify(content))
}

function writeSecret(relativePath: string, content: string): Promise<void> {
  const full = join(tempDir, "secrets", relativePath)
  // Ensure parent dir exists
  const dir = full.substring(0, full.lastIndexOf("/"))
  return import("node:fs/promises").then(({ mkdir }) =>
    mkdir(dir, { recursive: true }).then(() => writeFile(full, content)),
  )
}

describe("SecretProfileManager — parsing de manifesto", () => {
  const manager = new SecretProfileManager()

  it("rejeita versão diferente de 1", async () => {
    await writeManifest({ version: 2, files: [] })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("version")
    }
  })

  it("rejeita campos desconhecidos em entries", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "a.env", target: ".env", required: false, extra: true }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("campo_desconhecido")
    }
  })

  it("rejeita target absoluto", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: "/etc/.env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("path_invalido")
    }
  })

  it("rejeita target com '..'", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: "../.env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("path_invalido")
    }
  })

  it("rejeita source absoluto", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "/absolute/path.env", target: ".env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("path_invalido")
    }
  })

  it("rejeita source com '..'", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "../escape.env", target: ".env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("path_invalido")
    }
  })

  it("rejeita target que não é .env nem .env.*", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: "config.yaml", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("target_deve_ser_env")
    }
  })

  it("aceita manifesto ausente como perfil sem segredos", async () => {
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.files).toEqual([])
    }
  })

  it("rejeita files não-array", async () => {
    await writeManifest({ version: 1, files: "not-array" })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
  })

  it("rejeita required com tipo errado", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "a.env", target: ".env", required: "yes" }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("campos_invalidos")
    }
  })
})

describe("SecretProfileManager — interpolação", () => {
  const manager = new SecretProfileManager()

  it("interpola ${environment} e ${projectSlug} no source", async () => {
    await writeManifest({
      version: 1,
      files: [
        {
          source: "shared/${environment}.env",
          target: ".env",
          required: true,
        },
        {
          source: "${projectSlug}/${environment}.env",
          target: ".env",
          required: true,
        },
      ],
    })
    await writeSecret("shared/staging.env", "SHARED_KEY=shared_value\n")
    await writeSecret("my-project/staging.env", "PROJECT_KEY=project_value\n")

    const result = await manager.inspectManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "staging",
      projectSlug: "my-project",
    })
    expect(result.ok).toBe(true)
  })
})

describe("SecretProfileManager — obrigatório vs opcional", () => {
  const manager = new SecretProfileManager()

  it("bloqueia quando arquivo required está ausente", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: true }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("obrigatório ausente")
      expect(result.requiredAction).toBeTruthy()
    }
  })

  it("bloqueia quando required=true mas TASK_SECRETS_ROOT não está configurado", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: true }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      // root ausente
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("TASK_SECRETS_ROOT")
    }
  })

  it("ignora silenciosamente arquivo opcional ausente no inspect", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)
  })

  it("ignora silenciosamente arquivo opcional ausente no materialize", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: false }],
    })
    const result = await manager.materializeManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keys).toEqual([])
    }
  })
})

describe("SecretProfileManager — mescla e sobrescrita de chaves", () => {
  const manager = new SecretProfileManager()

  it("mescla chaves de múltiplas entradas com mesmo target; posterior sobrescreve", async () => {
    await writeManifest({
      version: 1,
      files: [
        { source: "shared/dev.env", target: ".env", required: true },
        { source: "test-project/dev.env", target: ".env", required: true },
      ],
    })
    await writeSecret("shared/dev.env", "SHARED_KEY=shared\nOVERWRITE=from_shared\n")
    await writeSecret("test-project/dev.env", "PROJECT_KEY=project\nOVERWRITE=from_project\n")

    const result = await manager.materializeManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.env).toEqual({
        SHARED_KEY: "shared",
        PROJECT_KEY: "project",
        OVERWRITE: "from_project",
      })
      expect(result.keys).toContain("SHARED_KEY")
      expect(result.keys).toContain("PROJECT_KEY")
      expect(result.keys).toContain("OVERWRITE")
    }
  })

  it("escreve arquivos em targets diferentes separadamente", async () => {
    await writeManifest({
      version: 1,
      files: [
        { source: "shared/dev.env", target: ".env", required: true },
        { source: "test-project/dev.env", target: ".env.local", required: true },
      ],
    })
    await writeSecret("shared/dev.env", "KEY_A=value_a\n")
    await writeSecret("test-project/dev.env", "KEY_B=value_b\n")

    const result = await manager.materializeManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)

    const envContent = await readFile(join(tempDir, ".env"), "utf8")
    expect(envContent).toContain("KEY_A")
    const localContent = await readFile(join(tempDir, ".env.local"), "utf8")
    expect(localContent).toContain("KEY_B")
  })
})

describe("SecretProfileManager — modo 0600", () => {
  const manager = new SecretProfileManager()

  it("cria arquivo materializado com modo 0600", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: true }],
    })
    await writeSecret("shared/dev.env", "SECRET=value\n")

    const result = await manager.materializeManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)

    const stats = await stat(join(tempDir, ".env"))
    // Check file mode (0600 = owner read/write only)
    expect(stats.mode & 0o777).toBe(0o600)
  })
})

describe("SecretProfileManager — conteúdo do .env materializado", () => {
  const manager = new SecretProfileManager()

  it("escreve chaves com valores citados (JSON.stringify)", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: true }],
    })
    await writeSecret("shared/dev.env", 'DB_URL="postgres://localhost/db"\nAPI_KEY=plain_value\n')

    const result = await manager.materializeManifest({
      repoPath: tempDir,
      root: join(tempDir, "secrets"),
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)

    const content = await readFile(join(tempDir, ".env"), "utf8")
    // Values should be JSON-quoted
    expect(content).toContain('DB_URL="postgres://localhost/db"')
    expect(content).toContain('API_KEY="plain_value"')
  })

  it("retorna ok=true sem root quando nenhum arquivo é required", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: false }],
    })
    const result = await manager.materializeManifest({
      repoPath: tempDir,
      // sem root
      environment: "development",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.keys).toEqual([])
      expect(result.env).toEqual({})
    }
  })
})

describe("SecretProfileManager — environment/projectSlug inválidos", () => {
  const manager = new SecretProfileManager()

  it("rejeita environment com caracteres inválidos", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "../bad",
      projectSlug: "test-project",
    })
    expect(result.ok).toBe(false)
  })

  it("rejeita projectSlug vazio", async () => {
    await writeManifest({
      version: 1,
      files: [{ source: "shared/dev.env", target: ".env", required: false }],
    })
    const result = await manager.inspectManifest({
      repoPath: tempDir,
      environment: "development",
      projectSlug: "",
    })
    expect(result.ok).toBe(false)
  })
})

describe("checkGitSecurity — segurança git do alvo", () => {
  it("pula silenciosamente em diretório que não é repo git", async () => {
    // Não deve lançar — diretório temporário não é repo git
    await expect(checkGitSecurity(tempDir, ".env")).resolves.toBeUndefined()
  })

  it("bloqueia quando o alvo não é ignorado pelo git", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "motor-v2-gitsec-"))
    try {
      execSync("git init", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.email test@test.com", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.name test", { cwd: gitDir, stdio: "ignore" })
      // Cria um arquivo dummy e faz commit para ter um repo válido
      await writeFile(join(gitDir, "dummy.txt"), "x")
      execSync("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" })
      // NÃO adiciona .env ao .gitignore → check-ignore deve falhar
      await expect(checkGitSecurity(gitDir, ".env")).rejects.toThrow("não é ignorado")
    } finally {
      await rm(gitDir, { recursive: true, force: true })
    }
  })

  it("permite quando o alvo está no .gitignore e não está rastreado", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "motor-v2-gitsec-"))
    try {
      execSync("git init", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.email test@test.com", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.name test", { cwd: gitDir, stdio: "ignore" })
      await writeFile(join(gitDir, ".gitignore"), ".env\n")
      await writeFile(join(gitDir, "dummy.txt"), "x")
      execSync("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" })
      // .env está no .gitignore e não está rastreado → deve passar
      await expect(checkGitSecurity(gitDir, ".env")).resolves.toBeUndefined()
    } finally {
      await rm(gitDir, { recursive: true, force: true })
    }
  })

  it("bloqueia quando o alvo já está rastreado pelo git", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "motor-v2-gitsec-"))
    try {
      execSync("git init", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.email test@test.com", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.name test", { cwd: gitDir, stdio: "ignore" })
      // Passo 1: .env.local é rastreado no commit inicial (sem .gitignore para ele)
      await writeFile(join(gitDir, ".env.local"), "SECRET=x")
      await writeFile(join(gitDir, "dummy.txt"), "x")
      execSync("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" })
      // Passo 2: adiciona .env.local ao .gitignore APÓS já estar rastreado
      // (situação real: alguém cometeu o .env por engano e depois colocou no .gitignore)
      await writeFile(join(gitDir, ".gitignore"), ".env\n.env.local\n")
      execSync("git add .gitignore && git commit -m gitignore-update", { cwd: gitDir, stdio: "ignore" })
      // Agora .env.local está no .gitignore (check-ignore passa) E está rastreado (ls-files detecta)
      await expect(checkGitSecurity(gitDir, ".env.local")).rejects.toThrow("já está rastreado")
    } finally {
      await rm(gitDir, { recursive: true, force: true })
    }
  })
})

describe("resolveGitTopLevel", () => {
  it("resolve o toplevel de um repo git", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "motor-v2-toplevel-"))
    try {
      execSync("git init", { cwd: gitDir, stdio: "ignore" })
      const topLevel = await resolveGitTopLevel(gitDir)
      expect(topLevel).toBeTruthy()
      // O toplevel deve ser o próprio diretório (ou resolvido)
      expect(topLevel.length).toBeGreaterThan(0)
    } finally {
      await rm(gitDir, { recursive: true, force: true })
    }
  })

  it("resolve o toplevel de um subdiretório de um repo", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "motor-v2-toplevel-"))
    try {
      execSync("git init", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.email test@test.com", { cwd: gitDir, stdio: "ignore" })
      execSync("git config user.name test", { cwd: gitDir, stdio: "ignore" })
      const subDir = join(gitDir, "projects", "sub")
      await import("node:fs/promises").then(({ mkdir }) => mkdir(subDir, { recursive: true }))
      await writeFile(join(gitDir, "dummy.txt"), "x")
      execSync("git add . && git commit -m init", { cwd: gitDir, stdio: "ignore" })
      const topLevel = await resolveGitTopLevel(subDir)
      // Deve resolver para a raiz do repo, não o subdiretório
      expect(topLevel).not.toContain("projects/sub")
    } finally {
      await rm(gitDir, { recursive: true, force: true })
    }
  })

  it("lança erro em diretório que não é repo git", async () => {
    await expect(resolveGitTopLevel(tempDir)).rejects.toThrow()
  })
})

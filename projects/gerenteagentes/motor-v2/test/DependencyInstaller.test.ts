/**
 * Testes do DependencyInstaller
 * @vitest-environment node
 *
 * Testa a instalação de dependências (npm ci) com runner mockado:
 * - npm ci roda apenas quando há package-lock.json
 * - Pula quando não há package-lock.json
 * - Falha quando npm ci modifica arquivo rastreado
 * - Falha clara quando npm ci retorna erro
 * - Timeout configurável
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DependencyInstaller, isLockfileOutOfSync, resolveInstallTimeoutMs, type CommandRunner } from "../src/workspaces/DependencyInstaller.js"

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "motor-v2-depinstall-"))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function createMockRunner(overrides: Partial<CommandRunner> = {}): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    ...overrides,
  }
}

describe("DependencyInstaller — detecção de package-lock.json", () => {
  it("pula quando não há package-lock.json na raiz do worktree", async () => {
    const runner = createMockRunner()
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skipped).toBe(true)
    }
    // Runner NÃO deve ser chamado (sem package-lock.json = nada a fazer)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it("executa npm ci quando há package-lock.json na raiz", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")
    const runner = createMockRunner()
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skipped).toBe(false)
    }
    // Runner deve ter sido chamado com npm ci
    const calls = vi.mocked(runner.run).mock.calls
    const npmCiCall = calls.find(([cmd]) => cmd === "npm ci")
    expect(npmCiCall).toBeTruthy()
    expect(npmCiCall![1]).toBe(tempDir)
  })
})

describe("DependencyInstaller — git status antes/depois", () => {
  it("captura git status antes e depois do npm ci", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")
    const runner = createMockRunner()
    const installer = new DependencyInstaller(runner)

    await installer.install({ worktreePath: tempDir })

    const calls = vi.mocked(runner.run).mock.calls
    const gitStatusCalls = calls.filter(([cmd]) => cmd === "git status --porcelain")
    // Deve haver 2 chamadas: antes e depois do npm ci
    expect(gitStatusCalls.length).toBe(2)
    // A primeira chamada é ANTES do npm ci
    const npmCiIndex = calls.findIndex(([cmd]) => cmd === "npm ci")
    const firstStatusIndex = calls.findIndex(([cmd]) => cmd === "git status --porcelain")
    expect(firstStatusIndex).toBeLessThan(npmCiIndex)
  })

  it("falha quando npm ci modifica arquivo rastreado", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    // Primeiro git status: limpo; segundo: com mudança em arquivo rastreado
    let callCount = 0
    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") {
          callCount++
          if (callCount === 1) return { stdout: "", stderr: "" }
          // Depois do npm ci: package-lock.json foi modificado (arquivo rastreado)
          return { stdout: " M package-lock.json\n", stderr: "" }
        }
        if (cmd === "npm ci") return { stdout: "added 100 packages\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("modificou arquivos rastreados")
      expect(result.reason).toContain("package-lock.json")
    }
  })

  it("não falha quando npm ci adiciona apenas arquivos não rastreados (untracked)", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    let callCount = 0
    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") {
          callCount++
          if (callCount === 1) return { stdout: "", stderr: "" }
          // Depois do npm ci: apenas node_modules (untracked) apareceu
          return { stdout: "?? node_modules/\n", stderr: "" }
        }
        if (cmd === "npm ci") return { stdout: "added 100 packages\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.skipped).toBe(false)
    }
  })

  it("falha quando múltiplos arquivos rastreados são modificados", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    let callCount = 0
    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") {
          callCount++
          if (callCount === 1) return { stdout: "", stderr: "" }
          return { stdout: " M package-lock.json\n M package.json\n?? node_modules/\n", stderr: "" }
        }
        if (cmd === "npm ci") return { stdout: "", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("modificou arquivos rastreados")
      // Deve listar os arquivos rastreados (não os untracked)
      expect(result.reason).toContain("package-lock.json")
      expect(result.reason).toContain("package.json")
      // node_modules é untracked (??), NÃO deve aparecer na lista de rastreados
      expect(result.reason).not.toContain("node_modules")
    }
  })
})

describe("DependencyInstaller — falha do npm ci", () => {
  it("retorna erro claro quando npm ci falha", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
        if (cmd === "npm ci") throw new Error("npm ERR! ERESOLVE could not resolve dependency tree")
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("npm ci falhou")
      expect(result.reason).toContain("ERESOLVE")
    }
  })

  it("trunca saída muito longa do npm ci na mensagem de erro", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    const longOutput = "x".repeat(5000)
    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
        if (cmd === "npm ci") throw new Error(longOutput)
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      // A mensagem de erro deve ser truncada (máx ~1000 chars do excerpt)
      expect(result.reason.length).toBeLessThan(2000)
    }
  })

  it("não executa git status depois se npm ci falhar", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
        if (cmd === "npm ci") throw new Error("npm ERR! fail")
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    await installer.install({ worktreePath: tempDir })

    const calls = vi.mocked(runner.run).mock.calls
    const gitStatusCalls = calls.filter(([cmd]) => cmd === "git status --porcelain")
    // Apenas 1 chamada (antes); a segunda não deve acontecer porque npm ci falhou
    expect(gitStatusCalls.length).toBe(1)
  })
})

describe("DependencyInstaller — timeout", () => {
  it("passa o timeout configurado para o runner", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")
    const runner = createMockRunner()
    const installer = new DependencyInstaller(runner)

    await installer.install({ worktreePath: tempDir, timeoutMs: 42_000 })

    const calls = vi.mocked(runner.run).mock.calls
    const npmCiCall = calls.find(([cmd]) => cmd === "npm ci")
    expect(npmCiCall).toBeTruthy()
    expect(npmCiCall![2]).toBe(42_000)
  })

  it("usa timeout default de 15 minutos quando não configurado", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")
    const runner = createMockRunner()
    const installer = new DependencyInstaller(runner)

    await installer.install({ worktreePath: tempDir })

    const calls = vi.mocked(runner.run).mock.calls
    const npmCiCall = calls.find(([cmd]) => cmd === "npm ci")
    expect(npmCiCall).toBeTruthy()
    expect(npmCiCall![2]).toBe(15 * 60 * 1000)
  })
})

describe("resolveInstallTimeoutMs", () => {
  const originalEnv = process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS = originalEnv
    } else {
      delete process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS
    }
  })

  it("retorna 15 minutos quando a variável não está configurada", () => {
    delete process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS
    expect(resolveInstallTimeoutMs()).toBe(15 * 60 * 1000)
  })

  it("retorna o valor configurado quando a variável é um número válido", () => {
    process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS = "60000"
    expect(resolveInstallTimeoutMs()).toBe(60_000)
  })

  it("retorna o default quando a variável não é um número", () => {
    process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS = "not-a-number"
    expect(resolveInstallTimeoutMs()).toBe(15 * 60 * 1000)
  })

  it("retorna o default quando a variável é zero ou negativo", () => {
    process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS = "0"
    expect(resolveInstallTimeoutMs()).toBe(15 * 60 * 1000)

    process.env.TASK_DEPENDENCY_INSTALL_TIMEOUT_MS = "-100"
    expect(resolveInstallTimeoutMs()).toBe(15 * 60 * 1000)
  })
})

describe("DependencyInstaller — auto-recovery de lockfile desatualizado", () => {
  it("detecta erro EUSAGE e roda npm install automaticamente", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
        if (cmd === "npm ci") {
          // Primeira chamada: falha com EUSAGE (lockfile desatualizado)
          throw new Error(
            "npm error code EUSAGE\nnpm error\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.\nnpm error Missing: @biblioteca-global/project-taqui@0.0.0 from lock file"
          )
        }
        if (cmd === "npm install") return { stdout: "added 50 packages\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    // Simula o cenário: primeira chamada npm ci falha, npm install roda, segunda npm ci succeeds
    let npmCiCallCount = 0
    vi.mocked(runner.run).mockImplementation(async (cmd: string) => {
      if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
      if (cmd === "npm ci") {
        npmCiCallCount++
        if (npmCiCallCount === 1) {
          throw new Error(
            "npm error code EUSAGE\nnpm error Missing: @biblioteca-global/project-taqui@0.0.0 from lock file"
          )
        }
        return { stdout: "added 100 packages\n", stderr: "" }
      }
      if (cmd === "npm install") return { stdout: "added 50 packages\n", stderr: "" }
      return { stdout: "", stderr: "" }
    })

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lockfileRegenerated).toBe(true)
    }
    // Verifica que npm install foi chamado
    const calls = vi.mocked(runner.run).mock.calls
    const npmInstallCall = calls.find(([cmd]) => cmd === "npm install")
    expect(npmInstallCall).toBeTruthy()
    // Verifica que npm ci foi chamado 2 vezes
    const npmCiCalls = calls.filter(([cmd]) => cmd === "npm ci")
    expect(npmCiCalls.length).toBe(2)
  })

  it("falha se npm install também falhar", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    let npmCiCallCount = 0
    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
        if (cmd === "npm ci") {
          npmCiCallCount++
          throw new Error("npm error code EUSAGE\nnpm error Missing: @pkg from lock file")
        }
        if (cmd === "npm install") throw new Error("npm error ECONNREFUSED")
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("mesmo após npm install")
    }
  })

  it("não tenta auto-recovery para erros que não são EUSAGE", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") return { stdout: "", stderr: "" }
        if (cmd === "npm ci") throw new Error("npm error ERESOLVE could not resolve dependency tree")
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("npm ci falhou")
      expect(result.reason).not.toContain("mesmo após npm install")
    }
    // npm install NÃO deve ter sido chamado
    const calls = vi.mocked(runner.run).mock.calls
    const npmInstallCall = calls.find(([cmd]) => cmd === "npm install")
    expect(npmInstallCall).toBeFalsy()
  })
})

describe("isLockfileOutOfSync", () => {
  it("detecta erro EUSAGE", () => {
    expect(isLockfileOutOfSync("npm error code EUSAGE")).toBe(true)
  })

  it("detecta 'Missing: <pkg> from lock file'", () => {
    expect(isLockfileOutOfSync("npm error Missing: @biblioteca-global/project-taqui@0.0.0 from lock file")).toBe(true)
  })

  it("detecta mensagem completa de lockfile desatualizado", () => {
    const msg =
      "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync."
    expect(isLockfileOutOfSync(msg)).toBe(true)
  })

  it("não detecta erros unrelated", () => {
    expect(isLockfileOutOfSync("npm error ERESOLVE could not resolve")).toBe(false)
    expect(isLockfileOutOfSync("npm error ENOENT no such file")).toBe(false)
    expect(isLockfileOutOfSync("")).toBe(false)
  })
})

describe("DependencyInstaller — integração com git status falhando", () => {
  it("prossegue mesmo se git status antes falhar (tolerância a ambientes sem git)", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") throw new Error("not a git repository")
        if (cmd === "npm ci") return { stdout: "added 100 packages\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    // Não deve falhar por causa do git status; deve completar com sucesso
    expect(result.ok).toBe(true)
  })

  it("prossegue sem verificar tracked files se git status depois falhar", async () => {
    await writeFile(join(tempDir, "package-lock.json"), "{}")

    let callCount = 0
    const runner = createMockRunner({
      run: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === "git status --porcelain") {
          callCount++
          if (callCount === 1) return { stdout: "", stderr: "" }
          throw new Error("not a git repository")
        }
        if (cmd === "npm ci") return { stdout: "added 100 packages\n", stderr: "" }
        return { stdout: "", stderr: "" }
      }),
    })
    const installer = new DependencyInstaller(runner)

    const result = await installer.install({ worktreePath: tempDir })

    // Não deve falhar; considera sucesso (sem como verificar)
    expect(result.ok).toBe(true)
  })
})

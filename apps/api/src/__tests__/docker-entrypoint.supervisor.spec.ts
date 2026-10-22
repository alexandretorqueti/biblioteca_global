// @vitest-environment node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { execPath } from "node:process"
import { afterEach, describe, expect, it } from "vitest"

/** Coleta stderr de um ChildProcess em memória. */
function collectStderr(child: ChildProcess): { readonly text: string } {
  const buffer: string[] = []
  child.stderr?.on("data", (chunk: Buffer) => buffer.push(chunk.toString()))
  return { get text() { return buffer.join("") } }
}

const apiDirectory = resolve(__dirname, "../..")
const entrypoint = resolve(apiDirectory, "docker-entrypoint.sh")
const repository = resolve(apiDirectory, "../..")
const temporaryDirectories: string[] = []

type EntrypointFixture = {
  events: string
  motorPid: string
  repository: string
  sshDirectory: string
  temporaryDirectory: string
}

async function createFixture(serveriaKnownHosts?: string): Promise<EntrypointFixture> {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "api-entrypoint-"))
  temporaryDirectories.push(temporaryDirectory)
  const bin = resolve(temporaryDirectory, "bin")
  const events = resolve(temporaryDirectory, "events.log")
  const motorPid = resolve(temporaryDirectory, "motor.pid")
  const repository = resolve(temporaryDirectory, "repository")
  const sshDirectory = resolve(temporaryDirectory, "ssh")
  await mkdir(bin)
  await mkdir(resolve(repository, "apps/api"), { recursive: true })
  await mkdir(resolve(repository, "projects/gerenteagentes/motor-v3"), { recursive: true })
  await writeFile(resolve(repository, "package.json"), "{}\n")
  await writeFile(
    resolve(repository, "apps/api/serveria_known_hosts"),
    serveriaKnownHosts ?? (await readFile(resolve(apiDirectory, "serveria_known_hosts"), "utf8")),
  )

  const writeExecutable = async (name: string, content: string) => {
    const path = resolve(bin, name)
    await writeFile(path, content)
    await chmod(path, 0o755)
  }

  await writeExecutable("npm", "#!/bin/sh\nexit 0\n")
  await writeExecutable("git", "#!/bin/sh\nexit 0\n")
  await writeExecutable(
    "ssh-keyscan",
    `#!/bin/sh
echo "github-keyscan" >> "$ENTRYPOINT_TEST_EVENTS"
printf '%s\\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDOMecXLXUjZfcJAtEaykBerYEqxwDfGvdP8jd0kVaUP'
`,
  )
  await writeExecutable(
    "node",
    `#!${execPath}
const { appendFileSync, writeFileSync } = require("node:fs")
const isMotor = process.argv[2] === "projects/gerenteagentes/motor-v3/dist/start.js"
const role = isMotor ? "motor" : "api"
appendFileSync(process.env.ENTRYPOINT_TEST_EVENTS, role + "-started\\n")
if (isMotor) {
  writeFileSync(process.env.ENTRYPOINT_TEST_MOTOR_PID, String(process.pid))
  if (process.env.ENTRYPOINT_TEST_MOTOR_MODE === "early-fail") process.exit(23)
}
const terminate = () => {
  appendFileSync(process.env.ENTRYPOINT_TEST_EVENTS, role + "-terminated\\n")
  process.exit(0)
}
process.on("SIGTERM", terminate)
process.on("SIGINT", terminate)
setInterval(() => {}, 1_000)
`,
  )

  return { events, motorPid, repository, sshDirectory, temporaryDirectory }
}

function startEntrypoint(fixture: EntrypointFixture, motorMode: "early-fail" | "running") {
  return spawn("sh", [entrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      ENTRYPOINT_TEST_EVENTS: fixture.events,
      ENTRYPOINT_TEST_MOTOR_MODE: motorMode,
      ENTRYPOINT_TEST_MOTOR_PID: fixture.motorPid,
      MOTOR_VERSION: "v3",
      MOTOR_WORKTREE_ROOT: resolve(fixture.temporaryDirectory, "worktrees"),
      ENTRYPOINT_SSH_DIRECTORY: fixture.sshDirectory,
      PATH: `${resolve(fixture.temporaryDirectory, "bin")}:${process.env.PATH}`,
      REPO_PATH: fixture.repository,
    },
    stdio: "ignore",
  })
}

function exits(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult) => {
    child.once("exit", (code, signal) => resolveResult({ code, signal }))
  })
}

async function waitForFile(path: string, content: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(content)) return
    } catch {
      // O processo ainda não produziu o evento.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
  throw new Error(`Evento não observado: ${content}`)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

/** Número de falhas simuladas para db:migrate:gerenteagentes (ajustado por teste). */
let failCount = 0

/**
 * Cria fixture com mock de npm que falha controladamente para
 * db:migrate:gerenteagentes. Usa arquivo contador para determinar
 * quantas falhas produzir antes de succeeding.
 */
async function createMigrateFixture(failCount: number) {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "api-migrate-"))
  temporaryDirectories.push(temporaryDirectory)
  const bin = resolve(temporaryDirectory, "bin")
  const events = resolve(temporaryDirectory, "events.log")
  const motorPid = resolve(temporaryDirectory, "motor.pid")
  const migrateCount = resolve(temporaryDirectory, "migrate.count")
  const repository = resolve(temporaryDirectory, "repository")
  const sshDirectory = resolve(temporaryDirectory, "ssh")
  await mkdir(bin)
  await mkdir(resolve(repository, "apps/api"), { recursive: true })
  await mkdir(resolve(repository, "projects/gerenteagentes/motor-v3"), { recursive: true })
  await writeFile(resolve(repository, "package.json"), "{}\n")
  await writeFile(
    resolve(repository, "apps/api/serveria_known_hosts"),
    await readFile(resolve(apiDirectory, "serveria_known_hosts"), "utf8"),
  )

  const writeExecutable = async (name: string, content: string) => {
    const path = resolve(bin, name)
    await writeFile(path, content)
    await chmod(path, 0o755)
  }

  // npm mock: falha para db:migrate:gerenteagentes até failCount chamadas;
  // demais comandos (db:migrate global, db:bootstrap, etc.) sempre succeedem.
  await writeExecutable(
    "npm",
    `#!/bin/sh
case "$*" in
  "run db:migrate:gerenteagentes")
    count=0
    if [ -f "$ENTRYPOINT_TEST_MIGRATE_COUNT" ]; then
      count=$(cat "$ENTRYPOINT_TEST_MIGRATE_COUNT")
    fi
    count=$((count + 1))
    printf '%s' "$count" > "$ENTRYPOINT_TEST_MIGRATE_COUNT"
    if [ "$count" -le "$ENTRYPOINT_TEST_MIGRATE_FAIL_COUNT" ]; then
      echo "Error: ER_PARSE_ERROR (1064)" >&2
      echo "  You have an error in your SQL syntax; check the manual" >&2
      echo "  at line 42: CREATE TABLE sem statement-breakpoint" >&2
      echo "  at file: 0082_postdeploy_verifications.sql" >&2
      exit 1
    fi
    echo "migrate-gerenteagentes-ok" >> "$ENTRYPOINT_TEST_EVENTS"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
  )
  await writeFile(migrateCount, "0")

  await writeExecutable("git", "#!/bin/sh\nexit 0\n")
  await writeExecutable(
    "ssh-keyscan",
    `#!/bin/sh
printf '%s\\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDOMecXLXUjZfcJAtEaykBerYEqxwDfGvdP8jd0kVaUP'
`,
  )
  await writeExecutable(
    "node",
    `#!${execPath}
const { appendFileSync, writeFileSync } = require("node:fs")
const isMotor = process.argv[2] === "projects/gerenteagentes/motor-v3/dist/start.js"
const role = isMotor ? "motor" : "api"
appendFileSync(process.env.ENTRYPOINT_TEST_EVENTS, role + "-started\\n")
if (isMotor) writeFileSync(process.env.ENTRYPOINT_TEST_MOTOR_PID, String(process.pid))
const terminate = () => {
  appendFileSync(process.env.ENTRYPOINT_TEST_EVENTS, role + "-terminated\\n")
  process.exit(0)
}
process.on("SIGTERM", terminate)
process.on("SIGINT", terminate)
setInterval(() => {}, 1_000)
`,
  )

  return { events, migrateCount, motorPid, repository, sshDirectory, temporaryDirectory }
}

function startEntrypointMigrate(fixture: Awaited<ReturnType<typeof createMigrateFixture>>) {
  const child = spawn("sh", [entrypoint], {
    cwd: repository,
    env: {
      ...process.env,
      ENTRYPOINT_TEST_EVENTS: fixture.events,
      ENTRYPOINT_TEST_MIGRATE_COUNT: fixture.migrateCount,
      ENTRYPOINT_TEST_MIGRATE_FAIL_COUNT: String(failCount),
      ENTRYPOINT_TEST_MOTOR_MODE: "running",
      ENTRYPOINT_TEST_MOTOR_PID: fixture.motorPid,
      ENTRYPOINT_MIGRATE_MAX_ATTEMPTS: "3",
      ENTRYPOINT_MIGRATE_SLEEP_SECONDS: "0",
      MOTOR_VERSION: "v3",
      MOTOR_WORKTREE_ROOT: resolve(fixture.temporaryDirectory, "worktrees"),
      ENTRYPOINT_SSH_DIRECTORY: fixture.sshDirectory,
      PATH: `${resolve(fixture.temporaryDirectory, "bin")}:${process.env.PATH}`,
      REPO_PATH: fixture.repository,
    },
    stdio: ["ignore", "ignore", "pipe"],
  })
  return child
}

describe("supervisor do docker-entrypoint para motor-v3", () => {
  it("prepara github.com em background sem atrasar o boot da API", async () => {
    const fixture = await createFixture()
    const entrypointProcess = startEntrypoint(fixture, "running")

    await waitForFile(fixture.events, "api-started")
    await waitForFile(resolve(fixture.sshDirectory, "known_hosts"), "github.com")

    entrypointProcess.kill("SIGTERM")
    await expect(exits(entrypointProcess)).resolves.toMatchObject({ code: 143 })
  }, 10_000)

  it("não duplica github.com em execuções repetidas", async () => {
    const githubKnownHost = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDOMecXLXUjZfcJAtEaykBerYEqxwDfGvdP8jd0kVaUP\n"
    const fixture = await createFixture(githubKnownHost)

    const firstEntrypoint = startEntrypoint(fixture, "running")
    await waitForFile(fixture.events, "api-started")
    firstEntrypoint.kill("SIGTERM")
    await expect(exits(firstEntrypoint)).resolves.toMatchObject({ code: 143 })
    await writeFile(fixture.events, "")

    const secondEntrypoint = startEntrypoint(fixture, "running")
    await waitForFile(fixture.events, "api-started")
    secondEntrypoint.kill("SIGTERM")
    await expect(exits(secondEntrypoint)).resolves.toMatchObject({ code: 143 })

    const knownHosts = await readFile(resolve(fixture.sshDirectory, "known_hosts"), "utf8")
    expect(knownHosts.match(/^github\.com /gm)).toHaveLength(1)
    await expect(readFile(fixture.events, "utf8")).resolves.not.toContain("github-keyscan")
  }, 10_000)

  it("encerra antes de iniciar a API quando o Motor morre na janela de boot", async () => {
    const fixture = await createFixture()
    const entrypointProcess = startEntrypoint(fixture, "early-fail")

    await expect(exits(entrypointProcess)).resolves.toMatchObject({ code: 1 })
    await expect(readFile(fixture.events, "utf8")).resolves.not.toContain("api-started")
  }, 10_000)

  it("encerra a API e falha o container quando o Motor morre depois da subida", async () => {
    const fixture = await createFixture()
    const entrypointProcess = startEntrypoint(fixture, "running")
    await waitForFile(fixture.events, "api-started")
    const motorPid = Number((await readFile(fixture.motorPid, "utf8")).trim())

    globalThis.process.kill(motorPid, "SIGTERM")

    await expect(exits(entrypointProcess)).resolves.toMatchObject({ code: 1 })
    await waitForFile(fixture.events, "api-terminated")
  }, 10_000)

  it("propaga SIGTERM aos dois processos filhos antes de encerrar", async () => {
    const fixture = await createFixture()
    const entrypointProcess = startEntrypoint(fixture, "running")
    await waitForFile(fixture.events, "api-started")

    entrypointProcess.kill("SIGTERM")

    await expect(exits(entrypointProcess)).resolves.toMatchObject({ code: 143 })
    await waitForFile(fixture.events, "api-terminated")
    await waitForFile(fixture.events, "motor-terminated")
  }, 10_000)
})

describe("entrypoint: visibilidade de erro SQL no db:migrate:gerenteagentes", () => {
  it("exibe o erro SQL completo no stderr na primeira falha e recupera em tentativa posterior", async () => {
    failCount = 1
    const fixture = await createMigrateFixture(failCount)
    const child = startEntrypointMigrate(fixture)
    const stderr = collectStderr(child)

    // Aguarda a API subir — significa que o migrate eventualmente succeeded
    await waitForFile(fixture.events, "api-started")

    // O erro SQL deve aparecer no stderr (visível na primeira falha)
    expect(stderr.text).toContain("ER_PARSE_ERROR")
    expect(stderr.text).toContain("0082_postdeploy_verifications.sql")
    expect(stderr.text).toContain("falhou (tentativa 1/")
    expect(stderr.text).toContain("saída do comando")

    // O contador deve ter sido incrementado (tentativa 1 falhou, 2 succeeded)
    const finalCount = Number((await readFile(fixture.migrateCount, "utf8")).trim())
    expect(finalCount).toBe(2)

    child.kill("SIGTERM")
    await exits(child)
  }, 15_000)

  it("esgota as tentativas e encerra com código 1 mantendo o erro visível", async () => {
    failCount = 99 // Sempre falha; max attempts = 3
    const fixture = await createMigrateFixture(failCount)
    const child = startEntrypointMigrate(fixture)
    const stderr = collectStderr(child)

    const result = await exits(child)
    expect(result.code).toBe(1)

    // Todas as 3 tentativas devem ter registrado erro SQL no stderr
    expect(stderr.text).toContain("ER_PARSE_ERROR")
    expect(stderr.text).toContain("tentativa 1/3")
    expect(stderr.text).toContain("tentativa 2/3")
    expect(stderr.text).toContain("tentativa 3/3")
    expect(stderr.text).toContain("indisponível após 3 tentativas")

    // A API não deve ter subido
    const eventsContent = await readFile(fixture.events, "utf8").catch(() => "")
    expect(eventsContent).not.toContain("api-started")
  }, 15_000)

  it("succeede na primeira tentativa sem produzir saída de erro", async () => {
    failCount = 0
    const fixture = await createMigrateFixture(failCount)
    const child = startEntrypointMigrate(fixture)
    const stderr = collectStderr(child)

    await waitForFile(fixture.events, "api-started")

    // Nenhuma mensagem de falha no stderr
    expect(stderr.text).not.toContain("ER_PARSE_ERROR")
    expect(stderr.text).not.toContain("falhou")

    // Contador = 1 (succeede na primeira)
    const finalCount = Number((await readFile(fixture.migrateCount, "utf8")).trim())
    expect(finalCount).toBe(1)

    child.kill("SIGTERM")
    await exits(child)
  }, 15_000)
})

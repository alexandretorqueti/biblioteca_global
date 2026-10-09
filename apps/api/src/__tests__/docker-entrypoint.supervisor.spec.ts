// @vitest-environment node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

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
    `#!/bin/sh
if [ "$1" = "projects/gerenteagentes/motor-v3/dist/start.js" ]; then
  echo "motor-started" >> "$ENTRYPOINT_TEST_EVENTS"
  echo "$$" > "$ENTRYPOINT_TEST_MOTOR_PID"
  if [ "$ENTRYPOINT_TEST_MOTOR_MODE" = "early-fail" ]; then
    exit 23
  fi
  trap 'echo "motor-terminated" >> "$ENTRYPOINT_TEST_EVENTS"; exit 0' TERM INT
  while :; do sleep 0.05; done
fi
echo "api-started" >> "$ENTRYPOINT_TEST_EVENTS"
trap 'echo "api-terminated" >> "$ENTRYPOINT_TEST_EVENTS"; exit 0' TERM INT
while :; do sleep 0.05; done
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

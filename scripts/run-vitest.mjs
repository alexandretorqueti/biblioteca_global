import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const env = { ...process.env, TZ: "UTC" }

// `host.docker.internal` é resolvido pelos containers, mas não pelo host
// Linux. Ao rodar `npm test` diretamente no host, use a porta publicada do
// MySQL local. Um valor informado explicitamente diferente é preservado.
if (process.platform === "linux" && !existsSync("/.dockerenv") && (!env.MYSQL_HOST || env.MYSQL_HOST === "host.docker.internal")) {
  env.MYSQL_HOST = "127.0.0.1"
}

// Node 22.6+ habilita `--experimental-strip-types` por padrão, o que impede
// o carregamento de arquivos .ts com parameter properties ou decorators
// (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). O Vitest usa o pipeline Vite/esbuild
// para transformar TypeScript; desativar o strip nativo evita o conflito.
const vitest = spawn(process.execPath, ["--no-experimental-strip-types", "node_modules/vitest/vitest.mjs", "run", "--passWithNoTests"], {
  env,
  stdio: "inherit",
})

vitest.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})

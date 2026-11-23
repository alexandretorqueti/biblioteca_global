// @vitest-environment node
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const script = readFileSync(
  resolve(process.cwd(), "projects/gerenteagentes/scripts/deploy-blue-green.sh"),
  "utf8",
)
const callbackLib = readFileSync(
  resolve(process.cwd(), "projects/gerenteagentes/scripts/lib/deploy-callback.sh"),
  "utf8",
)

describe("deploy de produção isolado do banco", () => {
  it("recria api/web sem administrar dependências no deploy e no rollback", () => {
    const composeUp = script.match(/docker compose[^\n]+ up [^\n]+/g) ?? []

    // api e web são criados em chamadas separadas (o Nginx do web precisa do
    // alias DNS da API já existente); o bundle de chats (chat-universal +
    // chat-proxy, compose da raiz) é a terceira chamada. Todas devem ser
    // isoladas de dependências — em especial os chats, porque o compose
    // padrão criaria uma API paralela colidindo com o slot ativo.
    expect(composeUp).toHaveLength(3)
    for (const command of composeUp) {
      expect(command).toContain("--no-deps")
      expect(command).toMatch(/\b(api|web|chat-universal|chat-proxy)\b/)
      expect(command).not.toMatch(/\bmysql\b/)
    }
    // Identificação por serviço (a definição da função de chats aparece
    // antes do fluxo principal no texto do script).
    const apiUp = composeUp.find((command) => /\bapi\b/.test(command))
    const webUp = composeUp.find((command) => /\bweb\b/.test(command))
    const chatUp = composeUp.find((command) => command.includes("chat-universal"))
    expect(apiUp).toBeDefined()
    expect(webUp).toBeDefined()
    // api e web são criados em chamadas separadas, nesta ordem: o Nginx do
    // web precisa do alias DNS da API já existente.
    expect(script.indexOf(apiUp!)).toBeLessThan(script.indexOf(webUp!))

    // Etapa de bundle de chats: rebuild com --build no projeto compose da
    // raiz, cobrindo exatamente os dois serviços do bundle.
    expect(chatUp).toBeDefined()
    expect(chatUp).toContain("--build")
    expect(chatUp).toMatch(/chat-universal chat-proxy/)
    expect(chatUp).toMatch(/-p "\$\{CHAT_COMPOSE_PROJECT:-biblioteca-global\}"/)
    expect(chatUp).toContain("-f docker-compose.yml")
  })

  it("executa o bundle de chats como etapa best-effort pós-swap com alerta degradável", () => {
    const swapIndex = script.indexOf('write_active_slot "$target"')
    const chatCallIndex = script.indexOf("deploy_chat_bundle || true")
    expect(swapIndex).toBeGreaterThan(-1)
    expect(chatCallIndex).toBeGreaterThan(swapIndex)
    // A chamada é degradaível: nunca altera exit code/callback nem reverte o
    // blue-green (daí o `|| true` na invocação).
    expect(script).toMatch(/deploy_chat_bundle\(\) \{[\s\S]*?return 0\n\}/)
    // Alerta visível no log do deploy + Telegram best-effort (pula em
    // silêncio sem credenciais; nunca aborta).
    expect(script).toContain("ALERTA CHATS:")
    expect(script).toContain("chats_status=")
    expect(script).toContain("TELEGRAM_BOT_TOKEN")
    expect(script).toContain("TELEGRAM_DLQ_CHAT_ID")
    // Smoke do bundle: /health do chat-universal e chat-proxy por Host.
    expect(script).toContain("${CHAT_UNIVERSAL_HOST_PORT:-8084}/health")
    expect(script).toContain("isa.globaltecnologia.net")
    expect(script).toContain("alpha.globaltecnologia.net")
    // O smoke legado só roda com os containers legacy em execução (a profile
    // legacy pode estar baixada; cobrar 200 de container parado geraria
    // falso alerta).
    expect(script).toContain("legacy_container_running")
    expect(script).toContain("biblioteca-global-$name")
  })

  it("confere saúde e preserva a identidade do MySQL", () => {
    expect(script).toContain("MYSQL_HOST_BLUEGREEN")
    expect(script).toContain("MYSQL_PORT_BLUEGREEN")
    expect(script).toContain("MySQL é")
    expect(script).toContain("compartilhado e nunca é recriado")
  })

  it("entrega o resultado ao Motor do slot correto sem depender de rota no Nginx", () => {
    expect(script).toContain('DEPLOY_BATCH_ID="${3:-}"')
    // O segredo do callback e o header vivem na lib compartilhada.
    expect(callbackLib).toContain("MOTOR_DEPLOY_CALLBACK_TOKEN")
    expect(callbackLib).toContain("X-Motor-Deploy-Token")
    // O URL do callback vive na lib compartilhada, sourceada pelo script.
    expect(script).toContain("scripts/lib/deploy-callback.sh")
    expect(callbackLib).toContain("http://127.0.0.1:${port}/api/motor/deploy/batches/${DEPLOY_BATCH_ID}/result")
    expect(script).toContain('callback_port="$NEW_MOTOR_PORT"')
    expect(script).toContain('callback_port="$(motor_port_for_slot "$active")"')
  })

  it("grava a evidência antes do callback e limita a notificação com retry dual-porta", () => {
    expect(script).toContain('write_deploy_status "$status"')
    expect(script.indexOf('write_deploy_status "$status"')).toBeLessThan(script.indexOf('notify_deploy_result "$status"'))
    // Limites por tentativa preservados (agora na lib).
    expect(callbackLib).toContain('--connect-timeout "${MOTOR_DEPLOY_CALLBACK_CONNECT_TIMEOUT_SECONDS:-2}"')
    expect(callbackLib).toContain('--max-time "${MOTOR_DEPLOY_CALLBACK_TIMEOUT_SECONDS:-15}"')
    // Retry dual-porta: 3010 e 3011 alternadas com rounds limitados e backoff.
    expect(callbackLib).toContain('MOTOR_DEPLOY_CALLBACK_PORTS="${MOTOR_DEPLOY_CALLBACK_PORTS:-3010 3011}"')
    expect(callbackLib).toContain("MOTOR_DEPLOY_CALLBACK_ROUNDS")
    expect(callbackLib).toContain("MOTOR_DEPLOY_CALLBACK_RETRY_DELAY_SECONDS")
    expect(callbackLib).toMatch(/for \(\( round = 1; round <= MOTOR_DEPLOY_CALLBACK_ROUNDS/)
    // Best-effort: a chamada no trap nunca aborta o deploy.
    expect(script).toMatch(/notify_deploy_result "\$status" "\$callback_port" \|\|/)
  })
})

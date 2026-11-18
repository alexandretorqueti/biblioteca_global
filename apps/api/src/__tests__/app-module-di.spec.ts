// @vitest-environment node
/**
 * Smoke test do grafo de dependências do AppModule.
 *
 * Captura em tempo de teste erros de DI do Nest (ex.: guard que injeta um
 * provider não visível no módulo do controller) — classe de defeito que só
 * aparecia no boot do container e derrubava o deploy blue-green.
 *
 * Incidente motivador (2026-11-18, bloqueios 3494/3495): PainelTenantModule
 * (isas-mt-10, subtarefa 2) usava JwtAuthGuard sem importar AuthModule;
 * JwtService ficava invisível no contexto do módulo e a API crash-loopava.
 */
import { describe, expect, it } from "vitest"
import { Test } from "@nestjs/testing"
import { AppModule } from "../app.module"

// Envs que só existem no compose (PSP_*): defaults para o spec rodar em
// qualquer worktree/gate, sem depender do ambiente de deploy.
process.env.PSP_PROVIDER ??= "mercadopago"
process.env.PSP_API_URL ??= "https://api.mercadopago.com"
process.env.PSP_TIMEOUT_MS ??= "10000"

describe("AppModule — grafo de dependências", () => {
  it("compila sem dependências irrestáveis", async () => {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile()
    await ref.close()
    expect(ref).toBeTruthy()
  }, 60_000)
})

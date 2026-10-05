import { describe, expect, it } from "vitest"
import { config as sistemaAdmGlobalConfig } from "../../../../../../projects/sistema-adm-global/config"

describe("configuração do Administrador Global", () => {
  it("envia o contrato do módulo sistêmico de usuários", () => {
    const tela = sistemaAdmGlobalConfig.groups
      .flatMap((grupo) => grupo.items)
      .find((item) => item.screen.kind === "cadastro" && item.screen.resource === "usuarios")

    expect(tela?.screen.kind).toBe("cadastro")
    if (tela?.screen.kind === "cadastro") {
      const campos = tela.screen.fields?.map((field) => field.name)
      // O schema atual do projeto usa `papel` para representar o perfil do
      // usuário; `senhaInicial` não é um campo persistido do cadastro.
      expect(campos).toEqual(expect.arrayContaining(["nome", "email", "papel", "ativo"]))
      expect(campos).not.toContain("senhaInicial")
      expect(campos).not.toContain("perfil")
    }
  })
})

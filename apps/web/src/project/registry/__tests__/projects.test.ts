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
      expect(campos).toEqual(expect.arrayContaining([
        "nome",
        "username",
        "email",
        "telefone",
        "cpf",
        "senhaInicial",
        "perfil",
        "ativo",
      ]))
      expect(campos).not.toContain("papel")

      const perfil = tela.screen.fields?.find((field) => field.name === "perfil")
      expect(perfil).toMatchObject({ type: "select" })
      expect(perfil?.options).toEqual([
        { label: "Administrador", value: "admin" },
        { label: "Gerente", value: "gerente" },
        { label: "Operador", value: "operador" },
        { label: "Visualizador", value: "visualizador" },
      ])
      expect(tela.screen.fields?.find((field) => field.name === "senhaInicial"))
        .toMatchObject({ required: true })
    }
  })
})

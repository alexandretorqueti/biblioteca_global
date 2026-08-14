// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import AuthPanel from "../AuthPanel"
import type { AuthPanelConfig } from "../AuthPanel"

const config: AuthPanelConfig = {
  appName: "Biblioteca Demo",
  title: "Acesse o sistema",
  loginIdentifier: "username",
  registrationFields: [],
}

describe("AuthPanel", () => {
  it("renderiza o formulário de login com o identificador configurado", () => {
    render(
      <AuthPanel
        config={{ ...config, loginIdentifier: "email" }}
        onLogin={() => undefined}
      />,
    )
    expect(screen.getByText("Acesse o sistema")).toBeInTheDocument()
    expect(screen.getByLabelText(/E-mail\b/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Senha\b/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Entrar" }),
    ).toBeInTheDocument()
  })

  it("usa label customizado para o identificador", () => {
    render(
      <AuthPanel
        config={{
          ...config,
          loginIdentifier: "username",
          customIdentifierLabel: "Login",
        }}
        onLogin={() => undefined}
      />,
    )
    expect(screen.getByLabelText(/^Login\b/)).toBeInTheDocument()
  })

  it("envia os valores do login para onLogin", async () => {
    const user = userEvent.setup()
    let received: Record<string, string | boolean> | undefined
    render(
      <AuthPanel
        config={config}
        onLogin={async (values) => {
          received = values
        }}
      />,
    )

    await user.type(screen.getByLabelText(/Nome de usuário\b/), "alexandre")
    await user.type(screen.getByLabelText(/Senha\b/), "senha-secreta")
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    expect(received).toEqual({
      identifier: "alexandre",
      password: "senha-secreta",
      rememberMe: false,
    })
  })

  it("mostra estado de loading enquanto o login está em andamento", async () => {
    const user = userEvent.setup()
    let resolveLogin: (() => void) | undefined
    render(
      <AuthPanel
        config={config}
        onLogin={() =>
          new Promise<void>((resolve) => {
            resolveLogin = resolve
          })
        }
      />,
    )

    await user.type(screen.getByLabelText(/Nome de usuário\b/), "alexandre")
    await user.type(screen.getByLabelText(/Senha\b/), "senha-secreta")
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    expect(
      screen.getByRole("button", { name: "Entrando..." }),
    ).toBeDisabled()

    resolveLogin?.()
    expect(
      await screen.findByRole("button", { name: "Entrar" }),
    ).toBeInTheDocument()
  })

  it("navega para o modo de cadastro quando habilitado", async () => {
    const user = userEvent.setup()
    render(
      <AuthPanel
        config={{
          ...config,
          allowRegistration: true,
          registrationFields: [
            { name: "nome", label: "Nome completo", type: "text" },
          ],
        }}
        onRegister={() => undefined}
      />,
    )

    await user.click(screen.getByText("Cadastre-se"))
    expect(screen.getByText("Crie sua conta")).toBeInTheDocument()
    expect(screen.getByLabelText(/Nome completo\b/)).toBeInTheDocument()
  })
})

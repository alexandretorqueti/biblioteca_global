// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom/vitest"
import AuthPanel from "../AuthPanel"
import type { AuthPanelConfig } from "../AuthPanel"
import { BibliotecaThemeProvider } from "../../theme/BibliotecaThemeProvider"

const config: AuthPanelConfig = {
  appName: "Biblioteca Demo",
  title: "Acesse o sistema",
  loginIdentifier: "username",
  registrationFields: [],
}

describe("AuthPanel", () => {
  // globals:false no vitest — sem auto-cleanup do RTL.
  afterEach(cleanup)

  it("respeita o modo escuro do tema", () => {
    render(
      <BibliotecaThemeProvider initialTheme="escuro">
        <AuthPanel config={config} onLogin={() => undefined} />
      </BibliotecaThemeProvider>,
    )
    expect(screen.getByTestId("auth-panel-root")).toHaveAttribute(
      "data-theme-mode",
      "dark",
    )
  })

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

  // ── Auth por código (auth única — Etapa 9) ───────────────────────────

  it("mostra o link de código por e-mail e navega para o modo código", async () => {
    const user = userEvent.setup()
    render(<AuthPanel config={config} />)

    await user.click(screen.getByText("Entrar com código por e-mail"))
    expect(screen.getByText("Entrar com código")).toBeInTheDocument()
    expect(screen.getByLabelText(/E-mail\b/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Enviar código" }),
    ).toBeInTheDocument()
  })

  it("oculta o link de código quando allowCodeLogin=false", () => {
    render(
      <AuthPanel
        config={{ ...config, allowCodeLogin: false }}
        onLogin={() => undefined}
      />,
    )
    expect(
      screen.queryByText("Entrar com código por e-mail"),
    ).not.toBeInTheDocument()
  })

  it("request-code: envia o e-mail e mostra a mensagem genérica", async () => {
    const user = userEvent.setup()
    let emailRecebido: string | undefined
    render(
      <AuthPanel
        config={config}
        onRequestCode={async (email) => {
          emailRecebido = email
        }}
      />,
    )

    await user.click(screen.getByText("Entrar com código por e-mail"))
    await user.type(screen.getByLabelText(/E-mail\b/), "cliente@exemplo.com")
    await user.click(screen.getByRole("button", { name: "Enviar código" }))

    expect(emailRecebido).toBe("cliente@exemplo.com")
    expect(
      await screen.findByText(
        "Se o e-mail existir, você receberá um código de acesso.",
      ),
    ).toBeInTheDocument()
    // Passa para o campo do código.
    expect(screen.getByLabelText(/Código de 6 dígitos\b/)).toBeInTheDocument()
  })

  it("verify-code: envia email+código e, na 1ª vez, abre 'Defina sua senha'", async () => {
    const user = userEvent.setup()
    let verificacao: { email: string; code: string } | undefined
    render(
      <AuthPanel
        config={config}
        onRequestCode={async () => undefined}
        onVerifyCode={async (email, code) => {
          verificacao = { email, code }
          return { primeiraVez: true, verificationToken: "vt-1" }
        }}
      />,
    )

    await user.click(screen.getByText("Entrar com código por e-mail"))
    await user.type(screen.getByLabelText(/E-mail\b/), "cliente@exemplo.com")
    await user.click(screen.getByRole("button", { name: "Enviar código" }))
    await user.type(
      await screen.findByLabelText(/Código de 6 dígitos\b/),
      "123456",
    )
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    expect(verificacao).toEqual({ email: "cliente@exemplo.com", code: "123456" })
    expect(screen.getByText("Defina sua senha")).toBeInTheDocument()
    expect(screen.getByLabelText(/Nova senha\b/)).toBeInTheDocument()
  })

  it("set-password: exige confirmação igual e chama onSetPassword", async () => {
    const user = userEvent.setup()
    let enviado: { novaSenha: string; verificationToken: string } | undefined
    render(
      <AuthPanel
        config={config}
        onRequestCode={async () => undefined}
        onVerifyCode={async () => ({
          primeiraVez: true,
          verificationToken: "vt-1",
        })}
        onSetPassword={async (novaSenha, verificationToken) => {
          enviado = { novaSenha, verificationToken }
        }}
      />,
    )

    // Vai até a tela de definir senha.
    await user.click(screen.getByText("Entrar com código por e-mail"))
    await user.type(screen.getByLabelText(/E-mail\b/), "cliente@exemplo.com")
    await user.click(screen.getByRole("button", { name: "Enviar código" }))
    await user.type(
      await screen.findByLabelText(/Código de 6 dígitos\b/),
      "123456",
    )
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    // Senhas diferentes → erro de validação local.
    await user.type(screen.getByLabelText(/Nova senha\b/), "senha-12345")
    await user.type(screen.getByLabelText(/Confirme a senha\b/), "senha-diferente")
    await user.click(screen.getByRole("button", { name: "Definir senha" }))
    expect(screen.getByText("As senhas não coincidem.")).toBeInTheDocument()
    expect(enviado).toBeUndefined()

    // Senhas iguais → chama onSetPassword com o token efêmero.
    await user.clear(screen.getByLabelText(/Confirme a senha\b/))
    await user.type(screen.getByLabelText(/Confirme a senha\b/), "senha-12345")
    await user.click(screen.getByRole("button", { name: "Definir senha" }))

    expect(enviado).toEqual({ novaSenha: "senha-12345", verificationToken: "vt-1" })
    expect(
      await screen.findByText(
        "Senha definida! Entre com sua nova senha ou com o código.",
      ),
    ).toBeInTheDocument()
  })

  it("verify-code com login completo (não-1ª vez) não abre definir senha", async () => {
    const user = userEvent.setup()
    render(
      <AuthPanel
        config={config}
        onRequestCode={async () => undefined}
        onVerifyCode={async () => ({ primeiraVez: false })}
      />,
    )

    await user.click(screen.getByText("Entrar com código por e-mail"))
    await user.type(screen.getByLabelText(/E-mail\b/), "cliente@exemplo.com")
    await user.click(screen.getByRole("button", { name: "Enviar código" }))
    await user.type(
      await screen.findByLabelText(/Código de 6 dígitos\b/),
      "123456",
    )
    await user.click(screen.getByRole("button", { name: "Entrar" }))

    expect(screen.queryByText("Defina sua senha")).not.toBeInTheDocument()
    expect(
      screen.getByText("Login realizado com sucesso."),
    ).toBeInTheDocument()
  })
})

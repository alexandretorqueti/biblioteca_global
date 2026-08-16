/**
 * LoginScreen (Etapa 9) — AuthPanel da UI + api-client.
 *
 * O componente visual (AuthPanel) é reutilizado da UI; aqui ligamos o
 * formulário à operação `login` do AuthContext. Erros da api-client
 * (credenciais inválidas, usuário inativo, rate-limit) são exibidos no painel.
 */
import { useState, type ReactNode } from "react"
import {
  Alert,
  Box,
  Typography,
} from "@mui/material"
import { AuthPanel, type AuthPanelConfig } from "@biblioteca-global/ui"
import { ApiClientError } from "@biblioteca-global/api-client"
import { useAuth } from "../auth/AuthContext"

const authPanelConfig: AuthPanelConfig = {
  appName: "Biblioteca Global",
  title: "Acesse a plataforma",
  subtitle: "Entre com seu e-mail, usuário, CPF ou telefone",
  loginIdentifier: "email",
  allowRememberMe: true,
  allowPasswordRecovery: false,
  allowRegistration: false,
  socialProviders: [],
  registrationFields: [],
  loginButtonLabel: "Entrar",
}

/** Traduz um ApiClientError para mensagem amigável. */
export function mensagemDeErroAuth(erro: unknown): string {
  if (erro instanceof Error && "status" in erro) {
    const apiErr = erro as ApiClientError
    if (apiErr.status === 401) {
      return "Identificador ou senha incorretos."
    }
    if (apiErr.status === 429) {
      return "Muitas tentativas. Aguarde um instante e tente novamente."
    }
    if (apiErr.status === 403) {
      return "Usuário sem permissão para acessar."
    }
    if (apiErr.status === 0 || apiErr.status >= 500) {
      return "Não foi possível conectar ao servidor. Tente novamente."
    }
  }
  if (erro instanceof Error && erro.message) {
    return erro.message
  }
  return "Erro inesperado. Tente novamente."
}

export default function LoginScreen(): ReactNode {
  const { login, requestCode, verifyCode, setPassword } = useAuth()
  const [erro, setErro] = useState<string | null>(null)

  const handleLogin = async (
    values: Record<string, string | boolean>,
  ): Promise<void> => {
    setErro(null)
    try {
      await login({
        identifier: String(values.identifier ?? ""),
        password: String(values.password ?? ""),
        identifierType: "email",
        rememberMe: Boolean(values.rememberMe),
      })
      // Sucesso: AuthContext autentica (1 projeto seleciona direto; com
      // vários, o roteador leva à seleção).
    } catch (e: unknown) {
      setErro(mensagemDeErroAuth(e))
      // Não relança: o erro já foi apresentado no painel acima.
    }
  }

  const handleRequestCode = async (email: string): Promise<void> => {
    setErro(null)
    try {
      await requestCode(email)
      // Resposta sempre ok — o painel mostra a mensagem genérica.
    } catch (e: unknown) {
      setErro(mensagemDeErroAuth(e))
    }
  }

  const handleVerifyCode = async (
    email: string,
    code: string,
  ): Promise<{ primeiraVez: boolean; verificationToken?: string }> => {
    setErro(null)
    try {
      const resultado = await verifyCode(email, code)
      if (resultado.primeiraVez) {
        return { primeiraVez: true, verificationToken: resultado.verificationToken }
      }
      // Login completo já aplicado pelo AuthContext.
      return { primeiraVez: false }
    } catch {
      // Código inválido/expirado: o próprio AuthPanel exibe o erro no modo código.
      return { primeiraVez: false }
    }
  }

  const handleSetPassword = async (
    novaSenha: string,
    verificationToken: string,
  ): Promise<void> => {
    setErro(null)
    await setPassword(novaSenha, verificationToken)
  }

  return (
    <Box>
      {erro && (
        <Alert severity="error" sx={{ mb: 2 }} data-testid="login-error">
          {erro}
        </Alert>
      )}
      <AuthPanel
        config={authPanelConfig}
        onLogin={handleLogin}
        onRequestCode={handleRequestCode}
        onVerifyCode={handleVerifyCode}
        onSetPassword={handleSetPassword}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        align="center"
        display="block"
        sx={{ mt: 3 }}
      >
        Plataforma de geração de sistemas — Biblioteca Global
      </Typography>
    </Box>
  )
}

import { useState } from "react"
import { Stack } from "@mui/material"
import AuthPanel, {
  type AuthPanelConfig,
  type AuthValues,
} from "../components/AuthPanel"
import ResultPanel from "../components/ResultPanel"

const config: AuthPanelConfig = {
  appName: "Biblioteca Gera",
  title: "Acesse sua conta",
  subtitle: "Entre para acessar os componentes e tutoriais",
  loginIdentifier: "cpf",
  customIdentifierLabel: "CPF",
  allowRegistration: true,
  allowPasswordRecovery: true,
  allowRememberMe: true,
  requirePasswordConfirmation: true,
  registrationColumns: 2,
  socialProviders: [
    { provider: "google", label: "Google" },
    { provider: "github", label: "GitHub" },
  ],
  registrationFields: [
    {
      name: "nome",
      label: "Nome completo",
      type: "text",
      required: true,
      fullWidth: true,
    },
    {
      name: "email",
      label: "E-mail",
      type: "email",
      required: true,
    },
    {
      name: "telefone",
      label: "Telefone",
      type: "tel",
      required: true,
    },
    {
      name: "cpf",
      label: "CPF",
      type: "text",
      required: true,
    },
    {
      name: "password",
      label: "Senha",
      type: "password",
      required: true,
    },
  ],
}

export default function AuthDemoPage() {
  const [result, setResult] = useState<{
    action: string
    values: AuthValues | string
  } | null>(null)

  return (
    <Stack spacing={3}>
      <AuthPanel
        config={config}
        onLogin={(values) => setResult({ action: "login", values })}
        onRegister={(values) =>
          setResult({ action: "cadastro", values })
        }
        onForgotPassword={(identifier) =>
          setResult({
            action: "recuperação de senha",
            values: identifier,
          })
        }
        onSocialLogin={(provider) =>
          setResult({
            action: "login social",
            values: provider,
          })
        }
      />

      {result && (
        <ResultPanel
          title={`Evento recebido: ${result.action}`}
          value={result.values}
        />
      )}
    </Stack>
  )
}

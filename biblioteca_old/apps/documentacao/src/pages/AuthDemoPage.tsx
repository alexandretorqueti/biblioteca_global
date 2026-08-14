import { useState, useRef, useEffect } from "react"
import { Stack, Button, Typography, Paper, Alert, CircularProgress } from "@mui/material"
import {
  AuthPanel,
  type AuthPanelConfig,
  type AuthValues,
  FieldMultipleChoice,
  type MultipleChoiceConfig,
} from "@alexandretorqueti/biblioteca-global-ui"
import ResultPanel from "../components/ResultPanel"
import { loadProjetos } from "../services/dataSources"

const authConfig: AuthPanelConfig = {
  appName: "Biblioteca Gera",
  title: "Acesse sua conta",
  subtitle: "Entre e selecione o projeto/contexto para continuar",
  loginIdentifier: "email",
  customIdentifierLabel: "E-mail corporativo",
  allowRegistration: false,
  allowPasswordRecovery: true,
  allowRememberMe: true,
  registrationFields: [],
}

const projectConfig: MultipleChoiceConfig = {
  loadOptions: loadProjetos,
  idField: "id",
  displayField: "nome",
  minimumSearchLength: 0,
  debounceMs: 280,
  noOptionsText: "Nenhum projeto encontrado",
}

export default function AuthDemoPage() {
  const [step, setStep] = useState<"auth" | "select" | "done">("auth")
  const [authValues, setAuthValues] = useState<AuthValues | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | number>("")
  const [finalResult, setFinalResult] = useState<{
    autenticacao: AuthValues | null
    projetoId: string | number
    acessoEm: string
  } | null>(null)
  const [error, setError] = useState<string>("")
  const [isLoadingProject, setIsLoadingProject] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string>("")

  const projectFieldRef = useRef<HTMLDivElement>(null)
  const statusLiveRef = useRef<HTMLDivElement>(null)

  // Atualiza mensagem de status para leitores de tela (acessibilidade)
  const announce = (message: string) => {
    setStatusMessage(message)
    // Limpa após anunciar
    setTimeout(() => setStatusMessage(""), 1200)
  }

  const handleLogin = (values: AuthValues) => {
    setAuthValues(values)
    setSelectedProjectId("")
    setError("")
    setStep("select")
    announce("Autenticação realizada com sucesso. Selecione o projeto.")

    // Foco automático + anúncio para acessibilidade
    setTimeout(() => {
      const input = projectFieldRef.current?.querySelector("input")
      input?.focus()
    }, 80)
  }

  const handleProjectChange = (_name: string, value: string | number) => {
    setSelectedProjectId(value)
    setError("")
  }

  const handleEnterProject = async () => {
    if (!selectedProjectId) {
      setError("Selecione um projeto para prosseguir.")
      announce("Erro: selecione um projeto.")
      return
    }

    setIsLoadingProject(true)
    setError("")

    try {
      await new Promise((r) => setTimeout(r, 420))

      const resultado = {
        autenticacao: authValues,
        projetoId: selectedProjectId,
        acessoEm: new Date().toISOString(),
      }

      setFinalResult(resultado)
      setStep("done")
      announce("Projeto selecionado com sucesso. Fluxo concluído.")
    } catch {
      setError("Falha ao confirmar seleção do projeto. Tente novamente.")
      announce("Falha ao confirmar o projeto.")
    } finally {
      setIsLoadingProject(false)
    }
  }

  const simularFalhaCarregamento = () => {
    setError("Erro simulado: não foi possível carregar a lista de projetos.")
    announce("Erro simulado carregado para demonstração.")
  }

  const reiniciar = () => {
    setStep("auth")
    setAuthValues(null)
    setSelectedProjectId("")
    setFinalResult(null)
    setError("")
    setIsLoadingProject(false)
    announce("Demonstração reiniciada.")
  }

  // Limpa status live region
  useEffect(() => {
    if (statusMessage && statusLiveRef.current) {
      statusLiveRef.current.textContent = statusMessage
    }
  }, [statusMessage])

  return (
    <Stack spacing={3}>
      {/* Região live para leitores de tela (acessibilidade) */}
      <div
        ref={statusLiveRef}
        aria-live="polite"
        aria-atomic="true"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}
      />

      {step === "auth" && (
        <AuthPanel
          config={authConfig}
          onLogin={handleLogin}
          onForgotPassword={(identifier) =>
            console.log("Solicitação de recuperação:", identifier)
          }
        />
      )}

      {step === "select" && authValues && (
        <Paper
          elevation={0}
          sx={{ p: 3, border: "1px solid", borderColor: "divider" }}
          role="region"
          aria-label="Seleção de projeto após autenticação"
        >
          <Typography variant="h6" component="h2" fontWeight={700} gutterBottom>
            Bem-vindo!
          </Typography>
          <Typography color="text.secondary" mb={2}>
            Autenticação realizada. Selecione o projeto/contexto de trabalho:
          </Typography>

          {error && (
            <Alert 
              severity="warning" 
              sx={{ mb: 2 }} 
              onClose={() => setError("")}
              role="alert"
            >
              {error}
            </Alert>
          )}

          <div ref={projectFieldRef}>
            <FieldMultipleChoice
              name="projetoId"
              label="Projeto / Contexto"
              value={selectedProjectId}
              config={projectConfig}
              required
              helperText="Digite para pesquisar. O componente gerencia loading, erro e opções automaticamente."
              disabled={isLoadingProject}
              onChange={handleProjectChange}
            />
          </div>

          <Stack direction="row" spacing={2} mt={3}>
            <Button
              variant="contained"
              disabled={!selectedProjectId || isLoadingProject}
              onClick={handleEnterProject}
              startIcon={isLoadingProject ? <CircularProgress size={16} color="inherit" /> : null}
              aria-busy={isLoadingProject}
            >
              {isLoadingProject ? "Confirmando acesso..." : "Entrar no projeto selecionado"}
            </Button>
            <Button variant="outlined" onClick={reiniciar} disabled={isLoadingProject}>
              Cancelar
            </Button>
            <Button 
              variant="text" 
              color="warning" 
              onClick={simularFalhaCarregamento}
              disabled={isLoadingProject}
              size="small"
              aria-label="Simular erro de carregamento para demonstração"
            >
              Simular falha
            </Button>
          </Stack>

          <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: "block" }}>
            Demonstração de loadOptions assíncrono, estados de erro/carregamento e foco automático.
          </Typography>
        </Paper>
      )}

      {step === "done" && finalResult && (
        <Stack spacing={2} role="region" aria-label="Resultado do fluxo">
          <Typography variant="h6" color="success.main" fontWeight={700}>
            Fluxo concluído com sucesso
          </Typography>
          <ResultPanel
            title="Resultado: autenticação + seleção de projeto (loadOptions + a11y + erro)"
            value={finalResult}
          />
          <Button variant="outlined" onClick={reiniciar}>
            Reiniciar demonstração
          </Button>
        </Stack>
      )}
    </Stack>
  )
}

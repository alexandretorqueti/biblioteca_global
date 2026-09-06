/**
 * SystemScreen (Etapa 9) — o sistema gerado do projeto selecionado.
 *
 * Renderiza o `<GeradorSistema>` da UI com a config + runtime do
 * ProjectContext. Oferece, na barra superior, troca de tema e logout.
 * Sem projeto selecionado, envia o usuário à seleção.
 * Exibe o <HelpDeskWidget> para suporte ao sistema.
 */
import { useMemo } from "react"
import type { ReactNode } from "react"
import {
  Box,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material"
import {
  AppsRounded,
  DarkModeRounded,
  LightModeRounded,
  LogoutRounded,
} from "@mui/icons-material"
import { GeradorSistema } from "@biblioteca-global/ui"
import { HelpDeskWidget } from "@biblioteca-global/ui"
import { createHelpDeskClient } from "@biblioteca-global/api-client"
import { useAuth } from "../auth/AuthContext"
import { useProject } from "../project/ProjectContext"
import { useThemeSetting } from "../theme/ThemeContext"

export default function SystemScreen(): ReactNode {
  const { logout, projeto, projetos, bundle } = useAuth()
  const { config, runtime } = useProject()
  const { toggle, themeName } = useThemeSetting()

  /** Botão de troca de projeto: aparece só quando há >1 projeto. */
  const projetoTroca = useMemo(() => {
    if (projetos.length <= 1) return null
    return (
      <Tooltip title="Trocar de projeto">
        <IconButton
          onClick={() => {
            window.location.href = "/select"
          }}
          aria-label="Trocar de projeto"
          data-testid="project-switch-button"
        >
          <AppsRounded />
        </IconButton>
      </Tooltip>
    )
  }, [projetos])

  const actions = useMemo(
    () => (
      <Stack direction="row" spacing={1} alignItems="center">
        {projetoTroca}

        <Tooltip title={themeName === "claro" ? "Modo escuro" : "Modo claro"}>
          <IconButton
            onClick={toggle}
            aria-label="Alternar tema claro/escuro"
            data-testid="theme-toggle"
          >
            {themeName === "claro" ? <DarkModeRounded /> : <LightModeRounded />}
          </IconButton>
        </Tooltip>

        <Tooltip title="Sair">
          <IconButton
            onClick={() => {
              void logout()
            }}
            aria-label="Sair"
            data-testid="logout-button"
          >
            <LogoutRounded />
          </IconButton>
        </Tooltip>

        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          {projeto?.perfil ?? ""}
        </Typography>
      </Stack>
    ),
    [toggle, themeName, logout, projeto, projetoTroca],
  )

  // HelpDesk: driver injetado quando há autenticação + projeto.
  // O HelpDesk só aparece quando há autenticação e projeto.
  const helpDeskClient = useMemo(() => {
    if (!projeto?.id) return null
    return createHelpDeskClient({
      http: bundle.http,
    })
  }, [bundle.http, projeto?.id])

  if (!config) {
    return (
      <Box sx={{ p: 4 }} data-testid="no-project-config">
        <Typography variant="h6">
          Nenhum projeto selecionado ou config indisponível.
        </Typography>
      </Box>
    )
  }

  return (
    <>
      <GeradorSistema
        config={config}
        runtime={runtime}
        actions={actions}
      />
      {helpDeskClient && (
        <HelpDeskWidget client={helpDeskClient} />
      )}
    </>
  )
}

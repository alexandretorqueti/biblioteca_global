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
  const { logout, projeto, usuario, bundle } = useAuth()
  const { config, runtime } = useProject()
  const { toggle, themeName } = useThemeSetting()

  const actions = useMemo(
    () => (
      <Stack direction="row" spacing={1} alignItems="center">
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
    [toggle, themeName, logout, projeto],
  )

  // HelpDesk: driver injetado quando há autenticação + projeto.
  const helpDeskClient = useMemo(() => {
    if (!usuario?.id || !projeto?.id) return null
    return createHelpDeskClient({
      http: bundle.http,
      usuarioId: usuario.id,
      projetoId: projeto.id,
    })
  }, [bundle.http, usuario?.id, projeto?.id])

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

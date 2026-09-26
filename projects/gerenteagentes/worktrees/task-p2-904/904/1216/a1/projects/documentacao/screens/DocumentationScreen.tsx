/**
 * DocumentationScreen — réplica do comportamento da biblioteca_old:
 * menu lateral esquerdo (Componentes + Exemplos) e, à direita, a
 * explicação (título, subtítulo, painel "Como utilizar") e o exemplo
 * executável de cada item do catálogo.
 *
 * A tela é registrada no registry do web como componentId "documentation"
 * (customScreens.tsx) e renderizada pelo GeradorSistema do projeto.
 */
import { useState } from "react"
import { Box, Chip, Paper, Stack, Typography } from "@mui/material"
import {
  AccountTreeRounded,
  DynamicFormRounded,
  GridViewRounded,
  LoginRounded,
} from "@mui/icons-material"
import type { ReactNode } from "react"
import { SistemaMenu } from "@biblioteca-global/ui"
import type { GeradorSistemaGroup } from "@biblioteca-global/ui"
import DocumentationPanel from "./DocumentationPanel"
import { demoFor } from "./demos"
import {
  componentMenuItems,
  exampleMenuItems,
  libraryContent,
  type Library,
  type MenuItemConfig,
} from "./catalog"
export const componentId = "documentation"

const iconFor = (item: MenuItemConfig): ReactNode => {
  if (item.icon === "grid") {
    return <GridViewRounded />
  }

  if (item.icon === "auth") {
    return <LoginRounded />
  }

  if (item.icon === "system") {
    return <AccountTreeRounded />
  }

  return <DynamicFormRounded />
}

const groups: GeradorSistemaGroup[] = [
  {
    id: "componentes",
    label: "Componentes",
    items: componentMenuItems.map((item) => ({
      id: item.id,
      label: item.primary,
      description: item.secondary,
      path: item.id,
      icon: iconFor(item),
      screen: { kind: "custom", content: null },
    })),
  },
  {
    id: "exemplos",
    label: "Exemplos",
    items: exampleMenuItems.map((item) => ({
      id: item.id,
      label: item.primary,
      description: item.secondary,
      path: item.id,
      icon: iconFor(item),
      screen: { kind: "custom", content: null },
    })),
  },
]

export default function DocumentationScreen(): ReactNode {
  const [activePath, setActivePath] = useState<Library>("grid")

  const content = libraryContent[activePath]

  return (
    <Stack spacing={3} data-testid="documentation-screen">
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="h3" component="h1" fontWeight={900}>
            Biblioteca Global UI
          </Typography>
          <Chip label="React 19" color="primary" />
          <Chip label="MUI 7" />
        </Stack>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          Catálogo executável dos componentes públicos. Os exemplos usam somente dados locais;
          transporte HTTP continua no api-client.
        </Typography>
      </Box>

      <Paper
        variant="outlined"
        sx={{
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "280px 1fr" },
        }}
      >
        <Box
          component="nav"
          aria-label="Navegação da documentação"
          sx={{
            borderRight: { md: "1px solid" },
            borderBottom: { xs: "1px solid", md: "none" },
            borderColor: "divider",
            bgcolor: "background.paper",
          }}
        >
          <SistemaMenu
            groups={groups}
            activePath={activePath}
            onNavigate={(path) => {
              if (path in libraryContent) {
                setActivePath(path as Library)
              }
            }}
          />
        </Box>

        <Box sx={{ p: { xs: 2, md: 4 }, minWidth: 0 }}>
          <Typography
            variant="h4"
            component="h2"
            fontWeight={900}
            sx={{ fontSize: { xs: "1.5rem", md: "2.125rem" } }}
          >
            {content.title}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 850, fontSize: "1.05rem" }}>
            {content.subtitle}
          </Typography>

          <Box sx={{ mt: 3 }}>{demoFor(activePath)}</Box>

          <Box sx={{ mt: 4 }}>
            <DocumentationPanel
              description={content.description}
              code={content.code}
            />
          </Box>
        </Box>
      </Paper>
    </Stack>
  )
}

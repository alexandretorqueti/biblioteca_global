import { useState } from "react"
import {
  Box,
  Button,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import {
  DashboardRounded,
  PeopleRounded,
  SettingsRounded,
} from "@mui/icons-material"
import {
  GeradorSistema,
  type EntityRecord,
  type GeradorSistemaConfig,
} from "@alexandretorqueti/biblioteca-global-ui"

const config: GeradorSistemaConfig<EntityRecord> = {
  app: { name: "Sistema demonstrativo", logo: <DashboardRounded color="primary" /> },
  groups: [
    {
      id: "principal",
      label: "Principal",
      items: [
        {
          id: "painel",
          label: "Painel",
          path: "/painel",
          icon: <DashboardRounded />,
          screen: { kind: "custom", content: <Typography variant="h4" fontWeight={800}>Painel configurado por JSON</Typography> },
        },
        {
          id: "pessoas",
          label: "Pessoas",
          path: "/pessoas",
          icon: <PeopleRounded />,
          screen: { kind: "custom", content: <Typography variant="h4" fontWeight={800}>Tela de pessoas</Typography> },
        },
      ],
    },
    {
      id: "administracao",
      label: "Administração",
      items: [
        {
          id: "configuracoes",
          label: "Configurações",
          path: "/configuracoes",
          icon: <SettingsRounded />,
          screen: { kind: "custom", content: <Typography variant="h4" fontWeight={800}>Configurações do sistema</Typography> },
        },
      ],
    },
  ],
}

export default function GeradorSistemaDemoPage() {
  const [open, setOpen] = useState(false)

  return (
    <Stack spacing={2}>
      <Typography color="text.secondary">
        Este exemplo abre uma prévia isolada do sistema. Cada item configura a própria tela; telas CRUD usam `kind: "cadastro"` e um data source injetado.
      </Typography>
      <Button variant="contained" onClick={() => setOpen(true)} sx={{ alignSelf: "flex-start" }}>
        Abrir prévia do sistema
      </Button>
      {open && (
        <Paper elevation={4} sx={{ overflow: "hidden", height: { xs: 540, md: 620 }, position: "relative" }}>
          <Box sx={{ transform: "scale(.78)", transformOrigin: "top left", width: "128.21%", height: "128.21%" }}>
            <GeradorSistema config={config} actions={<Button onClick={() => setOpen(false)}>Fechar prévia</Button>} />
          </Box>
        </Paper>
      )}
    </Stack>
  )
}

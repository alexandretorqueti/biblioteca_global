import { useState } from "react"
import {
  Box,
  Button,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import { AddRounded } from "@mui/icons-material"
import {
  SistemaBarraSuperior,
  type SistemaBreadcrumbItem,
} from "@alexandretorqueti/biblioteca-global-ui"

const breadcrumbs: SistemaBreadcrumbItem[] = [
  { id: "cadastros", label: "Cadastros" },
  { id: "clientes", label: "Clientes" },
]

export default function SistemaBarraSuperiorDemoPage() {
  const [menuOpened, setMenuOpened] = useState(false)

  return (
    <Stack spacing={2}>
      <Paper elevation={0} sx={{ position: "relative", overflow: "hidden", border: "1px solid", borderColor: "divider" }}>
        <SistemaBarraSuperior
          appName="Sistema exemplo"
          breadcrumbs={breadcrumbs}
          desktop={false}
          drawerWidth={280}
          onOpenMenu={() => setMenuOpened(true)}
          actions={<Button startIcon={<AddRounded />} variant="contained">Novo</Button>}
        />
        <Box sx={{ height: 64 }} />
      </Paper>
      <Typography color="text.secondary">
        {menuOpened ? "O botão de menu foi acionado." : "Em telas pequenas, o botão abre o menu lateral."}
      </Typography>
    </Stack>
  )
}

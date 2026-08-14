import { useState } from "react"
import {
  Box,
  Paper,
  Typography,
} from "@mui/material"
import {
  GroupsRounded,
  HomeRounded,
  SettingsRounded,
} from "@mui/icons-material"
import {
  SistemaMenu,
  type EntityRecord,
  type GeradorSistemaGroup,
} from "@alexandretorqueti/biblioteca-global-ui"

const groups: GeradorSistemaGroup<EntityRecord>[] = [
  {
    id: "principal",
    label: "Principal",
    items: [
      { id: "inicio", label: "Início", path: "/inicio", icon: <HomeRounded />, screen: { kind: "custom", content: null } },
      { id: "pessoas", label: "Pessoas", description: "Alunos e responsáveis", path: "/pessoas", icon: <GroupsRounded />, screen: { kind: "custom", content: null } },
    ],
  },
  {
    id: "administracao",
    label: "Administração",
    items: [
      { id: "configuracoes", label: "Configurações", path: "/configuracoes", icon: <SettingsRounded />, screen: { kind: "custom", content: null } },
    ],
  },
]

export default function SistemaMenuDemoPage() {
  const [activePath, setActivePath] = useState("/inicio")

  return (
    <Paper elevation={0} sx={{ border: "1px solid", borderColor: "divider", overflow: "hidden" }}>
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "280px 1fr" }, minHeight: 340 }}>
        <Box sx={{ borderRight: { sm: "1px solid" }, borderColor: "divider" }}>
          <SistemaMenu groups={groups} activePath={activePath} onNavigate={setActivePath} />
        </Box>
        <Box sx={{ p: 3, display: "grid", placeItems: "center", textAlign: "center" }}>
          <Box>
            <Typography variant="overline" color="text.secondary">Rota ativa</Typography>
            <Typography variant="h5" fontWeight={800}>{activePath}</Typography>
          </Box>
        </Box>
      </Box>
    </Paper>
  )
}

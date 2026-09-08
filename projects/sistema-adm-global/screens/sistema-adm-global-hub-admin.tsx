/**
 * Hub Admin (Configurações Admin) — cards de acesso rápido do módulo
 * Configurações Admin.
 *
 * Cards:
 * - Usuários → navega para a tela de usuários
 * - Empresa → navega para a tela de configuração da empresa
 * - Departamentos → navega para a tela de departamentos
 *
 * O card "Infraestrutura" do sistema original foi omitido de propósito
 * (a rota original retornava erro 500).
 *
 * Navegação via custom event `bg:navigate` consumido pelo GeradorSistema.
 */
import type { ReactNode } from "react"
import {
  Box,
  Card,
  CardActionArea,
  Grid,
  Stack,
  Typography,
} from "@mui/material"
import {
  ManageAccountsRounded,
  BusinessRounded,
  ApartmentRounded,
} from "@mui/icons-material"
export const componentId = "sistema-adm-global-hub-admin"

interface HubCard {
  label: string
  icon: ReactNode
  path: string
}

const cards: HubCard[] = [
  {
    label: "Usuários",
    icon: <ManageAccountsRounded sx={{ fontSize: 48 }} />,
    path: "usuarios",
  },
  {
    label: "Empresa",
    icon: <BusinessRounded sx={{ fontSize: 48 }} />,
    path: "config-empresa",
  },
  {
    label: "Departamentos",
    icon: <ApartmentRounded sx={{ fontSize: 48 }} />,
    path: "departamento",
  },
]

function navegarPara(path: string): void {
  window.dispatchEvent(
    new CustomEvent("bg:navigate", { detail: { path } }),
  )
}

export default function SistemaAdmGlobalHubAdmin(): ReactNode {
  return (
    <Stack spacing={3} data-testid="hub-admin">
      <Box>
        <Typography variant="h4" fontWeight={600}>
          Configurações Admin
        </Typography>
        <Typography color="text.secondary">
          Acesse os módulos de configuração do sistema.
        </Typography>
      </Box>

      <Grid container spacing={3}>
        {cards.map((card) => (
          <Grid key={card.label} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card
              sx={{
                height: "100%",
                transition: "transform 0.15s, box-shadow 0.15s",
                "&:hover": {
                  transform: "translateY(-2px)",
                  boxShadow: 4,
                },
              }}
            >
              <CardActionArea
                onClick={() => navegarPara(card.path)}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  py: 5,
                  gap: 1.5,
                  height: "100%",
                }}
              >
                <Box sx={{ color: "primary.main" }}>{card.icon}</Box>
                <Typography variant="subtitle1" fontWeight={600}>
                  {card.label}
                </Typography>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </Stack>
  )
}

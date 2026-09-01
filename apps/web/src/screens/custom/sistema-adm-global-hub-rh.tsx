/**
 * Hub RH — cards de acesso rápido do módulo RH.
 *
 * Cards:
 * - Circulares → navega para a tela de circulares
 * - Colaboradores → desabilitado (Em breve)
 * - Treinamentos → desabilitado (Em breve)
 *
 * Navegação via custom event `bg:navigate` consumido pelo GeradorSistema.
 */
import type { ReactNode } from "react"
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Grid,
  Stack,
  Typography,
} from "@mui/material"
import {
  CampaignRounded,
  GroupsRounded,
  SchoolRounded,
} from "@mui/icons-material"

interface HubCard {
  label: string
  icon: ReactNode
  path?: string
  disabled?: boolean
  badge?: string
}

const cards: HubCard[] = [
  {
    label: "Circulares",
    icon: <CampaignRounded sx={{ fontSize: 48 }} />,
    path: "circular",
  },
  {
    label: "Colaboradores",
    icon: <GroupsRounded sx={{ fontSize: 48 }} />,
    disabled: true,
    badge: "Em breve",
  },
  {
    label: "Treinamentos",
    icon: <SchoolRounded sx={{ fontSize: 48 }} />,
    disabled: true,
    badge: "Em breve",
  },
]

function navegarPara(path: string): void {
  window.dispatchEvent(
    new CustomEvent("bg:navigate", { detail: { path } }),
  )
}

export default function SistemaAdmGlobalHubRh(): ReactNode {
  return (
    <Stack spacing={3} data-testid="hub-rh">
      <Box>
        <Typography variant="h4" fontWeight={600}>
          RH
        </Typography>
        <Typography color="text.secondary">
          Acesse os módulos de Recursos Humanos.
        </Typography>
      </Box>

      <Grid container spacing={3}>
        {cards.map((card) => (
          <Grid key={card.label} size={{ xs: 12, sm: 6, md: 4 }}>
            <Card
              sx={{
                height: "100%",
                position: "relative",
                opacity: card.disabled ? 0.6 : 1,
                transition: "transform 0.15s, box-shadow 0.15s",
                "&:hover": card.disabled
                  ? {}
                  : {
                      transform: "translateY(-2px)",
                      boxShadow: 4,
                    },
              }}
            >
              {card.disabled ? (
                <CardContent
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    py: 5,
                    gap: 1.5,
                  }}
                >
                  <Box sx={{ color: "text.disabled" }}>{card.icon}</Box>
                  <Typography variant="subtitle1" fontWeight={600} color="text.disabled">
                    {card.label}
                  </Typography>
                  {card.badge && (
                    <Chip label={card.badge} size="small" color="default" />
                  )}
                </CardContent>
              ) : (
                <CardActionArea
                  onClick={() => card.path && navegarPara(card.path)}
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
              )}
            </Card>
          </Grid>
        ))}
      </Grid>
    </Stack>
  )
}

import type { ReactNode } from "react"
import {
  AppBar,
  Breadcrumbs,
  Box,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material"
import { MenuRounded } from "@mui/icons-material"
import type { SistemaBreadcrumbItem } from "../utils/system"

export interface SistemaBarraSuperiorProps {
  appName: string
  breadcrumbs: SistemaBreadcrumbItem[]
  desktop: boolean
  drawerWidth: number
  actions?: ReactNode
  onOpenMenu: () => void
}

export default function SistemaBarraSuperior({
  appName,
  breadcrumbs,
  desktop,
  drawerWidth,
  actions,
  onOpenMenu,
}: SistemaBarraSuperiorProps) {
  const currentPage = breadcrumbs.at(-1)?.label

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        bgcolor: "background.paper",
        color: "text.primary",
        borderBottom: "1px solid",
        borderColor: "divider",
        width: desktop ? `calc(100% - ${drawerWidth}px)` : "100%",
        ml: desktop ? `${drawerWidth}px` : 0,
      }}
    >
      <Toolbar>
        {!desktop && (
          <Tooltip title="Abrir menu">
            <IconButton edge="start" onClick={onOpenMenu} sx={{ mr: 1 }} aria-label="Abrir menu">
              <MenuRounded />
            </IconButton>
          </Tooltip>
        )}

        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Breadcrumbs aria-label="Localização atual" sx={{ display: { xs: "none", sm: "flex" } }}>
            {breadcrumbs.map((item, index) => (
              <Typography
                key={item.id}
                color={index === breadcrumbs.length - 1 ? "text.primary" : "text.secondary"}
                fontWeight={index === breadcrumbs.length - 1 ? 800 : 400}
              >
                {item.label}
              </Typography>
            ))}
          </Breadcrumbs>
          <Typography fontWeight={800} noWrap sx={{ display: { xs: "block", sm: "none" } }}>
            {currentPage ?? appName}
          </Typography>
        </Box>

        {actions}
      </Toolbar>
    </AppBar>
  )
}

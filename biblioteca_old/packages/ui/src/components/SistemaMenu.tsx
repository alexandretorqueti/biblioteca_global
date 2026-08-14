import type { ReactNode } from "react"
import {
  Box,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
} from "@mui/material"
import type { EntityRecord, GeradorSistemaGroup } from "../types"

export interface SistemaMenuProps<T extends EntityRecord> {
  groups: GeradorSistemaGroup<T>[]
  activePath: string
  header?: ReactNode
  onNavigate: (path: string) => void
}

export default function SistemaMenu<T extends EntityRecord>({
  groups,
  activePath,
  header,
  onNavigate,
}: SistemaMenuProps<T>) {
  return (
    <Box sx={{ height: "100%", bgcolor: "background.paper" }}>
      {header && (
        <>
          {header}
          <Divider />
        </>
      )}

      <List sx={{ px: 1.5, py: 2 }}>
        {groups.map((group) => (
          <Box component="li" key={group.id} sx={{ listStyle: "none" }}>
            <ListSubheader
              disableSticky
              sx={{ bgcolor: "transparent", px: 1, fontWeight: 800 }}
            >
              {group.label}
            </ListSubheader>

            {group.items.map((item) => (
              <ListItemButton
                key={item.id}
                selected={activePath === item.path}
                onClick={() => onNavigate(item.path)}
                sx={{ borderRadius: 2, mb: 0.5, minHeight: 48 }}
              >
                {item.icon && <ListItemIcon>{item.icon}</ListItemIcon>}
                <ListItemText primary={item.label} secondary={item.description} />
              </ListItemButton>
            ))}
          </Box>
        ))}
      </List>
    </Box>
  )
}

import type { ReactNode } from "react"
import { Box, type BoxProps } from "@mui/material"
import {
  createGridSpan,
  type ResponsiveValue,
} from "../utils/layout"

export interface LayoutItemProps
  extends Omit<BoxProps, "children"> {
  children: ReactNode
  span?: ResponsiveValue<number>
  order?: ResponsiveValue<number>
}

export default function LayoutItem({
  children,
  span = 1,
  order,
  sx,
  ...boxProps
}: LayoutItemProps) {
  return (
    <Box
      {...boxProps}
      sx={[
        {
          gridColumn: createGridSpan(span),
          order,
          minWidth: 0,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  )
}

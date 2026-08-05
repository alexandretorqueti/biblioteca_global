import type { CSSProperties, ReactNode } from "react"
import { Box, type BoxProps } from "@mui/material"
import { useTheme } from "@mui/material/styles"
import {
  createFlexBasis,
  createGridTemplateColumns,
  mapResponsiveValue,
  type ResponsiveValue,
} from "../utils/layout"

export type LayoutMode = "grid" | "columns"
export type LayoutSpacing = ResponsiveValue<number | string>

export interface LayoutContainerProps
  extends Omit<BoxProps, "children" | "display"> {
  children: ReactNode
  mode?: LayoutMode
  columns?: ResponsiveValue<number>
  gap?: LayoutSpacing
  rowGap?: LayoutSpacing
  columnGap?: LayoutSpacing
  minColumnWidth?: number | string
  wrap?: boolean
  fullWidth?: boolean
  alignItems?: CSSProperties["alignItems"]
  justifyContent?: CSSProperties["justifyContent"]
}

export default function LayoutContainer({
  children,
  mode = "grid",
  columns = 1,
  gap = 2,
  rowGap,
  columnGap,
  minColumnWidth,
  wrap = true,
  fullWidth = true,
  alignItems,
  justifyContent,
  sx,
  ...boxProps
}: LayoutContainerProps) {
  const theme = useTheme()
  const gridMode = mode === "grid"
  const effectiveColumnGap = columnGap ?? gap
  const columnGapCss = effectiveColumnGap
    ? mapResponsiveValue(effectiveColumnGap, (value) =>
        typeof value === "number" ? theme.spacing(value) : value,
      )
    : "0px"

  return (
    <Box
      {...boxProps}
      sx={[
        {
          display: gridMode ? "grid" : "flex",
          width: fullWidth ? "100%" : undefined,
          gap,
          rowGap,
          columnGap,
          alignItems,
          justifyContent,
          minWidth: 0,
          "--layout-column-gap": columnGapCss,
          ...(gridMode
            ? {
                gridTemplateColumns: createGridTemplateColumns(
                  columns,
                  minColumnWidth,
                ),
              }
            : {
                flexDirection: "row",
                flexWrap: wrap ? "wrap" : "nowrap",
                "& > *": {
                  flexGrow: 1,
                  flexShrink: 1,
                  flexBasis: createFlexBasis(columns),
                  minWidth: 0,
                },
              }),
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {children}
    </Box>
  )
}

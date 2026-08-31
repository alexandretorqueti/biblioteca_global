import type { Breakpoint } from "@mui/material/styles"

export type ResponsiveValue<T> =
  | T
  | Partial<Record<Breakpoint, T>>

const isResponsiveObject = <T>(
  value: ResponsiveValue<T>,
): value is Partial<Record<Breakpoint, T>> =>
  typeof value === "object" && value !== null

export function mapResponsiveValue<T, R>(
  value: ResponsiveValue<T>,
  mapper: (item: T) => R,
): ResponsiveValue<R> {
  if (!isResponsiveObject(value)) {
    return mapper(value)
  }

  return Object.fromEntries(
    Object.entries(value).map(([breakpoint, item]) => [
      breakpoint,
      mapper(item as T),
    ]),
  ) as Partial<Record<Breakpoint, R>>
}

export function createGridTemplateColumns(
  columns: ResponsiveValue<number>,
  minColumnWidth?: number | string,
): ResponsiveValue<string> {
  if (minColumnWidth !== undefined) {
    const width =
      typeof minColumnWidth === "number"
        ? `${minColumnWidth}px`
        : minColumnWidth

    return `repeat(auto-fit, minmax(min(100%, ${width}), 1fr))`
  }

  return mapResponsiveValue(
    columns,
    (count) => `repeat(${Math.max(1, count)}, minmax(0, 1fr))`,
  )
}

export function createFlexBasis(
  columns: ResponsiveValue<number>,
): ResponsiveValue<string> {
  return mapResponsiveValue(columns, (count) => {
    const normalizedCount = Math.max(1, count)

    if (normalizedCount === 1) {
      return "100%"
    }

    return `calc((100% - ${normalizedCount - 1} * var(--layout-column-gap, 0px)) / ${normalizedCount})`
  })
}

export function createGridSpan(
  span: ResponsiveValue<number>,
): ResponsiveValue<string> {
  return mapResponsiveValue(
    span,
    (count) => `span ${Math.max(1, count)}`,
  )
}

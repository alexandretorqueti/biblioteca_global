import { useMemo, useState } from "react"
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  InputAdornment,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from "@mui/material"
import {
  DeleteRounded,
  EditRounded,
  SearchRounded,
} from "@mui/icons-material"
import FieldGridData, {
  type GridDateFormat,
} from "./fields/FieldGridData"
import FieldGridText from "./fields/FieldGridText"
import FieldGridMoney from "./fields/FieldGridMoney"

type JsonValue = string | number | boolean | null | object | undefined
type SortDirection = "asc" | "desc"

export type JsonRecord = Record<string, JsonValue>

export interface JsonGridColumnConfig {
  type?: "text" | "date" | "boolean" | "json" | "money"
  label?: string
  dateFormat?: GridDateFormat
  hidden?: boolean
  sortable?: boolean
  searchable?: boolean
  currency?: string
  currencyLocale?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
}

interface JsonGridProps<T extends JsonRecord = JsonRecord> {
  data: T[]
  title?: string
  emptyMessage?: string
  loading?: boolean
  hiddenColumns?: string[]
  columnLabels?: Record<string, string>
  columns?: Record<string, JsonGridColumnConfig>
  getRowId?: (row: T, index: number) => string | number
  onEdit?: (row: T) => void
  onDelete?: (row: T) => void
  searchable?: boolean
  sortable?: boolean
  pagination?: boolean
  initialPageSize?: number
  pageSizeOptions?: number[]
}

const formatHeader = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())

const comparableValue = (value: JsonValue): string | number => {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0
  }

  if (value === null || value === undefined) {
    return ""
  }

  if (typeof value === "object") {
    return JSON.stringify(value)
  }

  return String(value).toLocaleLowerCase()
}

const searchableValue = (value: JsonValue): string => {
  if (value === null || value === undefined) {
    return ""
  }

  if (typeof value === "object") {
    return JSON.stringify(value)
  }

  return String(value)
}

const renderValue = (
  value: JsonValue,
  config?: JsonGridColumnConfig,
) => {
  if (config?.type === "date") {
    return (
      <FieldGridData
        value={value}
        format={config.dateFormat ?? "DD/MM/YYYY"}
      />
    )
  }

  if (config?.type === "money") {
    return (
      <FieldGridMoney
        value={value}
        currency={config.currency}
        locale={config.currencyLocale}
        minimumFractionDigits={config.minimumFractionDigits}
        maximumFractionDigits={config.maximumFractionDigits}
      />
    )
  }

  if (config?.type === "text") {
    return <FieldGridText value={value} />
  }

  if (value === null || value === undefined) {
    return <Chip label="Nulo" size="small" variant="outlined" />
  }

  if (config?.type === "boolean" || typeof value === "boolean") {
    return (
      <Chip
        label={Boolean(value) ? "Sim" : "Não"}
        size="small"
        color={Boolean(value) ? "success" : "default"}
      />
    )
  }

  if (config?.type === "json" || typeof value === "object") {
    return (
      <Typography
        component="code"
        variant="body2"
        sx={{ fontFamily: "monospace", whiteSpace: "nowrap" }}
      >
        {JSON.stringify(value)}
      </Typography>
    )
  }

  return <FieldGridText value={value} />
}

export default function JsonGrid<T extends JsonRecord>({
  data,
  title,
  emptyMessage = "Nenhum registro encontrado.",
  loading = false,
  hiddenColumns = [],
  columnLabels = {},
  columns: columnConfig = {},
  getRowId,
  onEdit,
  onDelete,
  searchable = true,
  sortable = true,
  pagination = true,
  initialPageSize = 10,
  pageSizeOptions = [5, 10, 25, 50],
}: JsonGridProps<T>) {
  const [search, setSearch] = useState("")
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] =
    useState<SortDirection>("asc")
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(initialPageSize)

  const visibleColumns = useMemo(
    () =>
      Array.from(
        new Set(data.flatMap((item) => Object.keys(item))),
      ).filter(
        (column) =>
          !hiddenColumns.includes(column) &&
          !columnConfig[column]?.hidden,
      ),
    [columnConfig, data, hiddenColumns],
  )

  const filteredRows = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()

    if (!normalizedSearch) {
      return data
    }

    return data.filter((row) =>
      visibleColumns.some((column) => {
        if (columnConfig[column]?.searchable === false) {
          return false
        }

        return searchableValue(row[column])
          .toLocaleLowerCase()
          .includes(normalizedSearch)
      }),
    )
  }, [columnConfig, data, search, visibleColumns])

  const sortedRows = useMemo(() => {
    if (!sortColumn) {
      return filteredRows
    }

    return [...filteredRows].sort((left, right) => {
      const leftValue = comparableValue(left[sortColumn])
      const rightValue = comparableValue(right[sortColumn])

      if (leftValue < rightValue) {
        return sortDirection === "asc" ? -1 : 1
      }

      if (leftValue > rightValue) {
        return sortDirection === "asc" ? 1 : -1
      }

      return 0
    })
  }, [filteredRows, sortColumn, sortDirection])

  const displayedRows = pagination
    ? sortedRows.slice(page * pageSize, page * pageSize + pageSize)
    : sortedRows

  const hasActions = Boolean(onEdit || onDelete)

  const handleSort = (column: string) => {
    if (!sortable || columnConfig[column]?.sortable === false) {
      return
    }

    if (sortColumn === column) {
      setSortDirection((current) =>
        current === "asc" ? "desc" : "asc",
      )
    } else {
      setSortColumn(column)
      setSortDirection("asc")
    }

    setPage(0)
  }

  return (
    <Paper
      elevation={0}
      sx={{
        border: "1px solid",
        borderColor: "divider",
        overflow: "hidden",
      }}
    >
      {(title || searchable) && (
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", sm: "center" }}
          justifyContent="space-between"
          sx={{
            px: 3,
            py: 2,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          {title && (
            <Typography variant="h6" fontWeight={700}>
              {title}
            </Typography>
          )}

          {searchable && (
            <TextField
              size="small"
              value={search}
              placeholder="Filtrar registros..."
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(0)
              }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded fontSize="small" />
                  </InputAdornment>
                ),
              }}
              sx={{ minWidth: { sm: 280 } }}
            />
          )}
        </Stack>
      )}

      {loading ? (
        <Box sx={{ p: 6, display: "grid", placeItems: "center" }}>
          <CircularProgress />
        </Box>
      ) : data.length === 0 ? (
        <Box sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">{emptyMessage}</Typography>
        </Box>
      ) : filteredRows.length === 0 ? (
        <Box sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">
            Nenhum registro encontrado.
          </Typography>
        </Box>
      ) : (
        <>
          <TableContainer sx={{ maxWidth: "100%", overflowX: "auto" }}>
            <Table stickyHeader aria-label={title ?? "Grade de dados"}>
              <TableHead>
                <TableRow>
                  {visibleColumns.map((column) => {
                    const canSort =
                      sortable &&
                      columnConfig[column]?.sortable !== false

                    return (
                      <TableCell
                        key={column}
                        sortDirection={
                          sortColumn === column ? sortDirection : false
                        }
                        sx={{
                          bgcolor: "grey.100",
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {canSort ? (
                          <TableSortLabel
                            active={sortColumn === column}
                            direction={
                              sortColumn === column
                                ? sortDirection
                                : "asc"
                            }
                            onClick={() => handleSort(column)}
                          >
                            {columnConfig[column]?.label ??
                              columnLabels[column] ??
                              formatHeader(column)}
                          </TableSortLabel>
                        ) : (
                          columnConfig[column]?.label ??
                          columnLabels[column] ??
                          formatHeader(column)
                        )}
                      </TableCell>
                    )
                  })}

                  {hasActions && (
                    <TableCell
                      align="right"
                      sx={{
                        bgcolor: "grey.100",
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Ações
                    </TableCell>
                  )}
                </TableRow>
              </TableHead>

              <TableBody>
                {displayedRows.map((row, rowIndex) => (
                  <TableRow
                    key={
                      getRowId?.(
                        row,
                        pagination
                          ? page * pageSize + rowIndex
                          : rowIndex,
                      ) ?? rowIndex
                    }
                    hover
                  >
                    {visibleColumns.map((column) => (
                      <TableCell key={column}>
                        {renderValue(
                          row[column],
                          columnConfig[column],
                        )}
                      </TableCell>
                    ))}

                    {hasActions && (
                      <TableCell align="right">
                        <Stack
                          direction="row"
                          spacing={1}
                          justifyContent="flex-end"
                        >
                          {onEdit && (
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<EditRounded />}
                              onClick={() => onEdit(row)}
                            >
                              Editar
                            </Button>
                          )}

                          {onDelete && (
                            <Button
                              size="small"
                              color="error"
                              variant="outlined"
                              startIcon={<DeleteRounded />}
                              onClick={() => onDelete(row)}
                            >
                              Excluir
                            </Button>
                          )}
                        </Stack>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {pagination && (
            <TablePagination
              component="div"
              count={sortedRows.length}
              page={Math.min(
                page,
                Math.max(0, Math.ceil(sortedRows.length / pageSize) - 1),
              )}
              rowsPerPage={pageSize}
              rowsPerPageOptions={pageSizeOptions}
              labelRowsPerPage="Registros por página"
              labelDisplayedRows={({ from, to, count }) =>
                `${from}–${to} de ${count}`
              }
              onPageChange={(_event, nextPage) => setPage(nextPage)}
              onRowsPerPageChange={(event) => {
                setPageSize(Number(event.target.value))
                setPage(0)
              }}
            />
          )}
        </>
      )}
    </Paper>
  )
}

import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material"
import { DeleteRounded, EditRounded } from "@mui/icons-material"
import FieldGridData, {
  type GridDateFormat,
} from "./fields/FieldGridData"
import FieldGridText from "./fields/FieldGridText"

type JsonValue = string | number | boolean | null | object | undefined

export type JsonRecord = Record<string, JsonValue>

export interface JsonGridColumnConfig {
  type?: "text" | "date" | "boolean" | "json"
  label?: string
  dateFormat?: GridDateFormat
  hidden?: boolean
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
}

const formatHeader = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())

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
}: JsonGridProps<T>) {
  const columns = Array.from(
    new Set(data.flatMap((item) => Object.keys(item))),
  ).filter(
    (column) =>
      !hiddenColumns.includes(column) &&
      !columnConfig[column]?.hidden,
  )

  const hasActions = Boolean(onEdit || onDelete)

  return (
    <Paper
      elevation={0}
      sx={{
        border: "1px solid",
        borderColor: "divider",
        overflow: "hidden",
      }}
    >
      {title && (
        <Box
          sx={{
            px: 3,
            py: 2,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography variant="h6" fontWeight={700}>
            {title}
          </Typography>
        </Box>
      )}

      {loading ? (
        <Box sx={{ p: 6, display: "grid", placeItems: "center" }}>
          <CircularProgress />
        </Box>
      ) : data.length === 0 ? (
        <Box sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">{emptyMessage}</Typography>
        </Box>
      ) : (
        <TableContainer sx={{ maxWidth: "100%", overflowX: "auto" }}>
          <Table stickyHeader aria-label={title ?? "Grade de dados"}>
            <TableHead>
              <TableRow>
                {columns.map((column) => (
                  <TableCell
                    key={column}
                    sx={{
                      bgcolor: "grey.100",
                      fontWeight: 700,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {columnConfig[column]?.label ??
                      columnLabels[column] ??
                      formatHeader(column)}
                  </TableCell>
                ))}

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
              {data.map((row, rowIndex) => (
                <TableRow
                  key={getRowId?.(row, rowIndex) ?? rowIndex}
                  hover
                >
                  {columns.map((column) => (
                    <TableCell key={column}>
                      {renderValue(row[column], columnConfig[column])}
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
      )}
    </Paper>
  )
}

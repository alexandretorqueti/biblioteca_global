import {
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material"

type JsonValue = string | number | boolean | null | object

export type JsonRecord = Record<string, JsonValue>

interface JsonGridProps {
  data: JsonRecord[]
  title?: string
  emptyMessage?: string
}

const formatHeader = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())

const renderValue = (value: JsonValue) => {
  if (value === null) {
    return <Chip label="Nulo" size="small" variant="outlined" />
  }

  if (typeof value === "boolean") {
    return (
      <Chip
        label={value ? "Sim" : "Não"}
        size="small"
        color={value ? "success" : "default"}
      />
    )
  }

  if (typeof value === "object") {
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

  return String(value)
}

export default function JsonGrid({
  data,
  title,
  emptyMessage = "Nenhum registro encontrado.",
}: JsonGridProps) {
  const columns = Array.from(
    new Set(data.flatMap((item) => Object.keys(item))),
  )

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
        <Box sx={{ px: 3, py: 2, borderBottom: "1px solid", borderColor: "divider" }}>
          <Typography variant="h6" fontWeight={700}>
            {title}
          </Typography>
        </Box>
      )}

      {data.length === 0 ? (
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
                    {formatHeader(column)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>

            <TableBody>
              {data.map((row, rowIndex) => (
                <TableRow key={rowIndex} hover>
                  {columns.map((column) => (
                    <TableCell key={column}>
                      {renderValue(row[column] ?? null)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  )
}

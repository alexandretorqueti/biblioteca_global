import { Box, Paper, Typography } from "@mui/material"

interface ResultPanelProps {
  title?: string
  value: unknown
}

export default function ResultPanel({
  title = "Resultado enviado",
  value,
}: ResultPanelProps) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 3,
        border: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography variant="h6" fontWeight={800} mb={2}>
        {title}
      </Typography>

      <Box
        component="pre"
        sx={{
          m: 0,
          p: 2,
          overflowX: "auto",
          borderRadius: 2,
          bgcolor: "#0f172a",
          color: "#e2e8f0",
        }}
      >
        {JSON.stringify(value, null, 2)}
      </Box>
    </Paper>
  )
}

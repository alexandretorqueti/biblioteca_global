import { Box, Paper, Stack, Typography } from "@mui/material"
import { CodeRounded } from "@mui/icons-material"

interface DocumentationPanelProps {
  description: string
  code: string
}

/**
 * Painel "Como utilizar" — réplica do DocumentationPanel da biblioteca_old:
 * descrição do componente + bloco de código de exemplo.
 */
export default function DocumentationPanel({
  description,
  code,
}: DocumentationPanelProps) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: { xs: 2, md: 3 },
        border: "1px solid",
        borderColor: "divider",
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" mb={2}>
        <CodeRounded color="primary" />
        <Typography variant="h6" fontWeight={800}>
          Como utilizar
        </Typography>
      </Stack>

      <Typography color="text.secondary" mb={2}>
        {description}
      </Typography>

      <Box
        component="pre"
        sx={{
          m: 0,
          p: 2.5,
          overflowX: "auto",
          borderRadius: 2,
          bgcolor: "#0f172a",
          color: "#e2e8f0",
          fontFamily: "monospace",
          fontSize: "0.875rem",
          lineHeight: 1.7,
        }}
      >
        <code>{code}</code>
      </Box>
    </Paper>
  )
}

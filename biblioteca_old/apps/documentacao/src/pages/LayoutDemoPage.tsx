import {
  Box,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import {
  LayoutContainer,
  LayoutItem,
} from "@alexandretorqueti/biblioteca-global-ui"

const Item = ({ label }: { label: string }) => (
  <Paper
    variant="outlined"
    sx={{
      p: 2,
      minHeight: 90,
      display: "grid",
      placeItems: "center",
      bgcolor: "background.default",
    }}
  >
    <Typography fontWeight={800}>{label}</Typography>
  </Paper>
)

export default function LayoutDemoPage() {
  return (
    <Stack spacing={5}>
      <Box>
        <Typography variant="h5" fontWeight={900} sx={{ mb: 2 }}>
          Grade responsiva
        </Typography>

        <LayoutContainer
          mode="grid"
          columns={{ xs: 1, sm: 2, md: 3 }}
        >
          <Item label="Coluna 1" />
          <Item label="Coluna 2" />
          <Item label="Coluna 3" />
        </LayoutContainer>
      </Box>

      <Box>
        <Typography variant="h5" fontWeight={900} sx={{ mb: 2 }}>
          Itens ocupando várias colunas
        </Typography>

        <LayoutContainer
          mode="grid"
          columns={{ xs: 1, md: 3 }}
        >
          <LayoutItem span={{ xs: 1, md: 2 }}>
            <Item label="Ocupa duas colunas" />
          </LayoutItem>

          <LayoutItem>
            <Item label="Ocupa uma coluna" />
          </LayoutItem>

          <LayoutItem span={{ xs: 1, md: 3 }}>
            <Item label="Ocupa toda a linha" />
          </LayoutItem>
        </LayoutContainer>
      </Box>

      <Box>
        <Typography variant="h5" fontWeight={900} sx={{ mb: 2 }}>
          Colunas automáticas
        </Typography>

        <LayoutContainer
          mode="grid"
          minColumnWidth={220}
        >
          <Item label="Automática 1" />
          <Item label="Automática 2" />
          <Item label="Automática 3" />
          <Item label="Automática 4" />
        </LayoutContainer>
      </Box>

      <Box>
        <Typography variant="h5" fontWeight={900} sx={{ mb: 2 }}>
          Modo colunas
        </Typography>

        <LayoutContainer
          mode="columns"
          columns={{ xs: 1, md: 3 }}
        >
          <Item label="Flex 1" />
          <Item label="Flex 2" />
          <Item label="Flex 3" />
        </LayoutContainer>
      </Box>
    </Stack>
  )
}

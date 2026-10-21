import { Box, Button, Card, CardContent, Stack, Typography } from "@mui/material"
import type { CustomScreenProps } from "@biblioteca-global/ui"

export const componentId = "gestao-de-tarefas-global-dashboard"

export default function DashboardScreen(props: CustomScreenProps) {
  void props
  return (
    <Stack spacing={3} data-testid="gestao-de-tarefas-global-dashboard">
      <Box>
        <Typography variant="h4" component="h1" fontWeight={700}>
          Minhas tarefas
        </Typography>
        <Typography color="text.secondary">
          Acompanhe as tarefas atribuídas a você e conclua o que está em andamento.
        </Typography>
      </Box>
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
            <Box>
              <Typography variant="h6">Nenhuma tarefa carregada</Typography>
              <Typography color="text.secondary">
                As tarefas serão exibidas aqui quando forem atribuídas.
              </Typography>
            </Box>
            <Button variant="outlined" disabled>Atualizar</Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  )
}

/**
 * CalculadoraScreen — placeholder mínimo da rota custom `/calculadora`.
 *
 * Plano macro #6 (posição 1/9, subtarefa 3): o menu 'Investimentos' precisa
 * da rota custom existir no build do web com tela registrável. Cotação
 * (SGS/BrasilAPI), conversão anual→mensal (RF-6), projeção e gráfico (RF-7)
 * estão FORA deste escopo — entram em subtarefas posteriores do plano.
 *
 * Regra da plataforma (PoC §7): UI sem HTTP — esta tela não busca dados;
 * quando a calculadora real nascer, substitui o placeholder mantendo o
 * mesmo `componentId` (a config.ts não muda).
 */
import { Paper, Stack, Typography } from "@mui/material"

export const componentId = "calculadora-de-investimentos-gabriel-calculadora"

export default function CalculadoraScreen() {
  return (
    <Stack spacing={2} sx={{ p: { xs: 2, md: 3 }, maxWidth: 720 }}>
      <Typography variant="h5" fontWeight={800}>
        Calculadora
      </Typography>
      <Paper
        elevation={0}
        variant="outlined"
        sx={{ p: 3, borderRadius: 2 }}
      >
        <Typography color="text.secondary">
          A calculadora de projeção de investimentos será habilitada nas
          próximas etapas do plano (cotação automática dos índices e cálculo
          de rendimento). Enquanto isso, cadastre e mantenha os índices em
          Investimentos → Índices.
        </Typography>
      </Paper>
    </Stack>
  )
}

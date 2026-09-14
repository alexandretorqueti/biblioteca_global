import type { ReactNode } from "react"
import { Box, Container, Link, Paper, Stack, Typography } from "@mui/material"

export default function PoliticaPrivacidadeScreen(): ReactNode {
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Paper component="article" sx={{ p: { xs: 3, md: 6 } }}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h3" component="h1" gutterBottom>
              Política de Privacidade
            </Typography>
            <Typography color="text.secondary">Versão 1.0 — vigente desde 1º de setembro de 2026</Typography>
          </Box>
          <Typography>
            A Global Tecnologia respeita a privacidade e trata dados pessoais de acordo com a Lei Geral de Proteção de Dados (LGPD).
          </Typography>
          <Box>
            <Typography variant="h5" component="h2">Dados coletados</Typography>
            <Typography>Podemos coletar nome, e-mail, telefone, CPF, identificadores de acesso, senha protegida e dados técnicos de segurança, como endereço IP e registros de acesso.</Typography>
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Finalidades e bases legais</Typography>
            <Typography component="div">
              <ul>
                <li>Nome, e-mail e telefone: execução de contrato, conforme Art. 7º, V.</li>
                <li>CPF: consentimento explícito, conforme Art. 11, I, ou obrigação legal, conforme Art. 11, III.</li>
                <li>Senha: execução de contrato, conforme Art. 7º, V; armazenada somente em formato protegido.</li>
                <li>Logs e IP: exercício regular de direitos e segurança da plataforma.</li>
              </ul>
            </Typography>
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Retenção e segurança</Typography>
            <Typography>Adotamos criptografia, controle de acesso por perfil e logs de auditoria. Os dados são mantidos pelo período necessário às finalidades informadas e às obrigações legais; contas sem atividade serão avaliadas para exclusão após cinco anos.</Typography>
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Direitos do titular</Typography>
            <Typography>Você pode solicitar confirmação, acesso, correção, portabilidade, anonimização, eliminação e informações sobre o tratamento dos seus dados. Solicitações podem ser feitas pelo canal abaixo.</Typography>
          </Box>
          <Box>
            <Typography variant="h5" component="h2">Encarregado e contato</Typography>
            <Typography>Para exercer seus direitos, contate o Encarregado (DPO) em <Link href="mailto:privacidade@globaltecnologia.com.br">privacidade@globaltecnologia.com.br</Link>.</Typography>
          </Box>
          <Typography variant="caption" color="text.secondary">Esta política se aplica à plataforma Biblioteca Global e aos sistemas que ela gera.</Typography>
        </Stack>
      </Paper>
    </Container>
  )
}

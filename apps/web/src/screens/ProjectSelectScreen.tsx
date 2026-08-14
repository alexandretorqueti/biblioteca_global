/**
 * ProjectSelectScreen (Etapa 9) — escolha do projeto quando há mais de um.
 *
 * A lista de `projetos` vem da sessão autenticada (login/refresh). Ao
 * clicar, `selectProject(projetoId)` troca o access token (escopo do
 * refresh) e o roteador segue para o sistema do projeto.
 */
import { useState, type ReactNode } from "react"
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Container,
  Stack,
  Typography,
} from "@mui/material"
import { FolderRounded } from "@mui/icons-material"
import type { ProjetoResumo } from "@biblioteca-global/shared"
import { useAuth } from "../auth/AuthContext"

export default function ProjectSelectScreen(): ReactNode {
  const { projetos, usuario, selectProject } = useAuth()
  const [erro, setErro] = useState<string | null>(null)
  const [selecionando, setSelecionando] = useState<number | null>(null)

  const handleSelect = async (projeto: ProjetoResumo): Promise<void> => {
    setErro(null)
    setSelecionando(projeto.id)
    try {
      await selectProject(projeto.id)
    } catch (e: unknown) {
      setErro(
        e instanceof Error ? e.message : "Falha ao selecionar o projeto.",
      )
      setSelecionando(null)
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        p: { xs: 2, md: 4 },
      }}
    >
      <Container maxWidth="sm">
        <Stack spacing={3} alignItems="center" textAlign="center">
          <Avatar sx={{ bgcolor: "primary.main", width: 64, height: 64 }}>
            <FolderRounded />
          </Avatar>

          <Box>
            <Typography variant="h4" fontWeight={900}>
              Escolha um projeto
            </Typography>
            <Typography color="text.secondary">
              {usuario?.nome
                ? `Olá, ${usuario.nome}. Selecione o sistema que deseja acessar.`
                : "Selecione o sistema que deseja acessar."}
            </Typography>
          </Box>

          {erro && (
            <Alert severity="error" data-testid="project-select-error">
              {erro}
            </Alert>
          )}

          <Stack spacing={2} width="100%">
            {projetos.map((projeto) => {
              const carregando = selecionando === projeto.id
              return (
                <Card key={projeto.id} variant="outlined">
                  <CardActionArea
                    onClick={() => {
                      void handleSelect(projeto)
                    }}
                    disabled={selecionando !== null}
                    data-testid={`project-option-${projeto.slug}`}
                  >
                    <CardContent>
                      <Stack
                        direction="row"
                        alignItems="center"
                        justifyContent="space-between"
                      >
                        <Box>
                          <Typography variant="h6" fontWeight={700}>
                            {projeto.nome}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {projeto.slug}
                          </Typography>
                        </Box>
                        <Stack alignItems="flex-end" spacing={0.5}>
                          <Button
                            size="small"
                            variant="contained"
                            disabled={carregando}
                            sx={{ minWidth: 120 }}
                          >
                            {carregando ? "Entrando..." : "Acessar"}
                          </Button>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            perfil: {projeto.perfil}
                          </Typography>
                        </Stack>
                      </Stack>
                    </CardContent>
                  </CardActionArea>
                </Card>
              )
            })}
          </Stack>
        </Stack>
      </Container>
    </Box>
  )
}

/**
 * VitrinePublica — página pública da Vitrine IA (macro #10, posição 2/11).
 *
 * Replica seção a seção o layout de referência (globalsolucoesti.com.br/chatbot):
 * hero, métricas, dores, benefícios, como-funciona, segmentos, planos, FAQ e
 * CTA final. Regras da subtarefa 2:
 * - TODO o texto vem de `GET /api/vitrine/conteudo` em runtime (contrato
 *   `vitrinePublicaConteudoSchema`) — nenhum copy comercial hardcoded e
 *   nenhum fallback estático que mascare ausência de dados;
 * - todo botão de WhatsApp usa o link da chave `whatsapp_link` do conteúdo
 *   (ausente → botão não renderizado; zero número no código);
 * - UI não fala HTTP: consumo via `VitrinePublicaClient` (api-client);
 * - seções sem dados são omitidas; loading/erro/vazio são explícitos;
 * - responsivo MUI Grid (xs 1 coluna → md/lg várias), sem overflow em 375px.
 *
 * O único elemento estático é o mock visual do chat da ISA no hero —
 * device-frame decorativo (aria-hidden) autorizado pela subtarefa; não
 * veicula copy comercial, planos ou dados.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Grid,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import ExpandMoreIcon from "@mui/icons-material/ExpandMore"
import WhatsAppIcon from "@mui/icons-material/WhatsApp"
import { VitrinePublicaClient } from "@biblioteca-global/api-client"
import type {
  VitrinePublicaConteudo,
  VitrinePublicaSecao,
  VitrinePublicaTexto,
} from "@biblioteca-global/shared"
import { useApi } from "../../../apps/web/src/hooks/useApi"

type EstadoCarregamento = "carregando" | "pronto" | "erro" | "vazio"

/** Índice chave→conteúdo dos textos livres (hero_*, cta_*, whatsapp_link…). */
export function indexarTextos(textos: readonly VitrinePublicaTexto[]): Map<string, string> {
  const indice = new Map<string, string>()
  for (const texto of textos) indice.set(texto.chave, texto.conteudo)
  return indice
}

/** Textos de uma seção, na ordem devolvida pela API. */
export function textosDaSecao(
  textos: readonly VitrinePublicaTexto[],
  secao: VitrinePublicaSecao,
): VitrinePublicaTexto[] {
  return textos.filter((texto) => texto.secao === secao)
}

/**
 * Divide o texto do card em título + corpo quando o autor escreve
 * "Título: descrição" (padrão dos passos de como-funciona); sem marcador,
 * o texto inteiro é o corpo. 100% derivado do conteúdo — nada inventado.
 */
export function dividirTitulo(conteudo: string): { titulo: string | null; corpo: string } {
  const doisPontos = conteudo.indexOf(": ")
  if (doisPontos > 0 && doisPontos <= 70) {
    const titulo = conteudo.slice(0, doisPontos).trim()
    const corpo = conteudo.slice(doisPontos + 2).trim()
    if (titulo.length > 0 && corpo.length > 0) return { titulo, corpo }
  }
  return { titulo: null, corpo: conteudo }
}

/** Preço em BRL pt-BR; valores inteiros sem centavos (R$ 297, R$ 1.200). */
export function formatarBRL(valor: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: Number.isInteger(valor) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(valor)
}

function TituloSecao({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return (
    <Typography id={id} variant="h4" component="h2" align="center" sx={{ mb: 1, fontWeight: 700 }}>
      {children}
    </Typography>
  )
}

/** Mock estático do chat da ISA (device-frame decorativo do hero). */
function MockChat(): ReactNode {
  const mensagens: ReadonlyArray<{ de: "isa" | "cliente"; texto: string }> = [
    { de: "isa", texto: "Olá! Sou a assistente virtual. Como posso ajudar? 😊" },
    { de: "cliente", texto: "Quero saber mais sobre o atendimento 24h" },
    { de: "isa", texto: "Posso responder na hora, a qualquer horário!" },
  ]
  return (
    <Paper
      elevation={8}
      aria-hidden
      sx={{
        p: 2,
        width: "100%",
        maxWidth: 360,
        borderRadius: 4,
        bgcolor: "background.paper",
        mx: "auto",
      }}
    >
      <Stack spacing={1.25}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              bgcolor: "primary.main",
              color: "primary.contrastText",
              display: "grid",
              placeItems: "center",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            IA
          </Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Atendente virtual
          </Typography>
        </Box>
        <Divider />
        {mensagens.map((mensagem, indice) => (
          <Box
            key={indice}
            sx={{
              alignSelf: mensagem.de === "cliente" ? "flex-end" : "flex-start",
              bgcolor: mensagem.de === "cliente" ? "primary.light" : "action.hover",
              color: mensagem.de === "cliente" ? "primary.contrastText" : "text.primary",
              px: 1.5,
              py: 0.75,
              borderRadius: 3,
              maxWidth: "85%",
            }}
          >
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              {mensagem.texto}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  )
}

export default function VitrinePublica(): ReactNode {
  const bundle = useApi()
  const cliente = useMemo(
    () => (bundle ? new VitrinePublicaClient(bundle.http) : undefined),
    [bundle],
  )
  const [estado, setEstado] = useState<EstadoCarregamento>("carregando")
  const [conteudo, setConteudo] = useState<VitrinePublicaConteudo | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const carregar = useCallback(() => {
    if (!cliente) {
      setEstado("erro")
      setErro("Serviço indisponível no momento.")
      return
    }
    let vivo = true
    setEstado("carregando")
    setErro(null)
    cliente
      .obterConteudo()
      .then((dados) => {
        if (!vivo) return
        const temConteudo = Object.values(dados).some((lista) => lista.length > 0)
        setConteudo(dados)
        setEstado(temConteudo ? "pronto" : "vazio")
      })
      .catch(() => {
        if (!vivo) return
        setEstado("erro")
        setErro("Não foi possível carregar o conteúdo da vitrine. Tente novamente em instantes.")
      })
    return () => {
      vivo = false
    }
  }, [cliente])

  useEffect(() => carregar(), [carregar])

  const textos = conteudo?.textos ?? []
  const indices = useMemo(() => indexarTextos(textos), [textos])
  const texto = (chave: string): string | null => indices.get(chave) ?? null
  const whatsappLink = texto("whatsapp_link")

  const dores = textosDaSecao(textos, "dores")
  const beneficios = textosDaSecao(textos, "beneficios")
  const passos = textosDaSecao(textos, "como_funciona")
  const metricas = conteudo?.metricas ?? []
  const segmentos = conteudo?.segmentos ?? []
  const planos = conteudo?.planos ?? []
  const faq = conteudo?.faq ?? []

  const heroTitulos = [texto("hero_titulo"), texto("hero_subtitulo")].filter(
    (valor): valor is string => valor !== null && valor.length > 0,
  )
  const heroCta = texto("hero_cta")
  const ctaBotao = texto("cta_botao") ?? "Comprar agora"
  const ctaCorpo = [texto("cta_texto"), texto("contato_texto")].filter(
    (valor): valor is string => valor !== null && valor.length > 0,
  )
  const ctaTextos = [texto("cta_titulo"), ...ctaCorpo].filter(
    (valor): valor is string => valor !== null && valor.length > 0,
  )
  const botaoWhatsapp = (rotulo: string, key?: string): ReactNode =>
    whatsappLink ? (
      <Button
        key={key}
        href={whatsappLink}
        target="_blank"
        rel="noopener noreferrer"
        variant="contained"
        size="large"
        startIcon={<WhatsAppIcon />}
        sx={{ borderRadius: 999, px: 3, py: 1, fontWeight: 700 }}
      >
        {rotulo}
      </Button>
    ) : null

  /**
   * Botão de compra (subtarefa 3): plano/CTA linkam ao formulário público de
   * pedido (`/vitrine-ia/pedido`), com o plano pré-selecionado por NOME via
   * query — sempre o nome publicado no conteúdo, nunca copy/telefone
   * hardcoded. O rótulo segue dirigido pelo conteúdo (`textoBotao`).
   */
  const botaoComprar = (rotulo: string, key?: string, planoNome?: string): ReactNode => (
    <Button
      key={key}
      component={Link}
      to={planoNome ? `/vitrine-ia/pedido?plano=${encodeURIComponent(planoNome)}` : "/vitrine-ia/pedido"}
      variant="contained"
      size="large"
      sx={{ borderRadius: 999, px: 3, py: 1, fontWeight: 700 }}
    >
      {rotulo}
    </Button>
  )

  if (estado === "carregando") {
    return (
      <Box
        data-testid="vitrine-loading"
        sx={{ minHeight: "60vh", display: "grid", placeItems: "center" }}
      >
        <CircularProgress aria-label="Carregando vitrine" />
      </Box>
    )
  }

  if (estado === "erro") {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert data-testid="vitrine-erro" severity="error">
          {erro}
        </Alert>
      </Container>
    )
  }

  if (estado === "vazio" || !conteudo) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Alert data-testid="vitrine-vazio" severity="info">
          Nenhum conteúdo publicado no momento.
        </Alert>
      </Container>
    )
  }

  return (
    <Box component="main" sx={{ pb: 8 }}>
      {/* 1 — Hero */}
      {heroTitulos.length > 0 && (
        <Box
          data-testid="secao-hero"
          sx={{
            background: (tema) =>
              `linear-gradient(160deg, ${tema.palette.primary.dark} 0%, ${tema.palette.secondary?.main ?? tema.palette.primary.main} 100%)`,
            color: "primary.contrastText",
            py: { xs: 6, md: 10 },
          }}
        >
          <Container maxWidth="lg">
            <Grid container spacing={5} alignItems="center">
              <Grid size={{ xs: 12, md: 7 }}>
                <Stack spacing={2.5} alignItems={{ xs: "stretch", md: "flex-start" }}>
                  {texto("hero_eyebrow") && (
                    <Chip
                      label={texto("hero_eyebrow")}
                      size="small"
                      sx={{ bgcolor: "rgba(255,255,255,0.15)", color: "inherit" }}
                    />
                  )}
                  {texto("hero_titulo") && (
                    <Typography
                      variant="h3"
                      component="h1"
                      sx={{ fontWeight: 800, fontSize: { xs: 30, md: 44 }, lineHeight: 1.15 }}
                    >
                      {texto("hero_titulo")}
                    </Typography>
                  )}
                  {texto("hero_subtitulo") && (
                    <Typography variant="h6" sx={{ fontWeight: 400, opacity: 0.92 }}>
                      {texto("hero_subtitulo")}
                    </Typography>
                  )}
                  {heroCta && botaoWhatsapp(heroCta, "hero-cta")}
                </Stack>
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <MockChat />
              </Grid>
            </Grid>
          </Container>
        </Box>
      )}

      {/* 2 — Métricas de destaque */}
      {metricas.length > 0 && (
        <Container maxWidth="lg" sx={{ py: { xs: 5, md: 7 } }}>
          <Grid container spacing={2} data-testid="secao-metricas">
            {metricas.map((metrica, indice) => (
              <Grid key={`${metrica.valor}-${indice}`} size={{ xs: 6, md: 3 }}>
                <Card variant="outlined" sx={{ p: 2.5, textAlign: "center", height: "100%" }}>
                  <Typography variant="h4" sx={{ fontWeight: 800, color: "primary.main" }}>
                    {metrica.valor}
                  </Typography>
                  {metrica.rotulo && (
                    <Typography variant="body2" color="text.secondary">
                      {metrica.rotulo}
                    </Typography>
                  )}
                </Card>
              </Grid>
            ))}
          </Grid>
        </Container>
      )}

      {/* 3 — Dores */}
      {dores.length > 0 && (
        <Container maxWidth="lg" sx={{ py: { xs: 5, md: 7 } }}>
          <TituloSecao id="titulo-dores">Por que um atendente virtual?</TituloSecao>
          <Grid container spacing={3} sx={{ mt: 2 }} data-testid="secao-dores">
            {dores.map((item, indice) => {
              const { titulo, corpo } = dividirTitulo(item.conteudo)
              return (
                <Grid key={`${item.chave}-${indice}`} size={{ xs: 12, md: 4 }}>
                  <Card variant="outlined" sx={{ p: 3, height: "100%" }}>
                    {titulo && (
                      <Typography variant="h6" component="h3" sx={{ fontWeight: 700, mb: 1 }}>
                        {titulo}
                      </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                      {corpo}
                    </Typography>
                  </Card>
                </Grid>
              )
            })}
          </Grid>
        </Container>
      )}

      {/* 4 — Benefícios */}
      {beneficios.length > 0 && (
        <Box sx={{ bgcolor: "action.hover", py: { xs: 5, md: 7 } }}>
          <Container maxWidth="lg">
            <TituloSecao id="titulo-beneficios">O que você recebe</TituloSecao>
            <Grid container spacing={3} sx={{ mt: 2 }} data-testid="secao-beneficios">
              {beneficios.map((item, indice) => {
                const { titulo, corpo } = dividirTitulo(item.conteudo)
                return (
                  <Grid key={`${item.chave}-${indice}`} size={{ xs: 12, sm: 6, md: 4 }}>
                    <Card elevation={0} sx={{ p: 3, height: "100%", borderRadius: 3 }}>
                      {titulo && (
                        <Typography variant="h6" component="h3" sx={{ fontWeight: 700, mb: 1 }}>
                          {titulo}
                        </Typography>
                      )}
                      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                        {corpo}
                      </Typography>
                    </Card>
                  </Grid>
                )
              })}
            </Grid>
          </Container>
        </Box>
      )}

      {/* 5 — Como funciona */}
      {passos.length > 0 && (
        <Container maxWidth="lg" sx={{ py: { xs: 5, md: 7 } }}>
          <TituloSecao id="titulo-como-funciona">Como funciona</TituloSecao>
          <Grid container spacing={3} sx={{ mt: 2 }} data-testid="secao-como-funciona">
            {passos.map((item, indice) => {
              const { titulo, corpo } = dividirTitulo(item.conteudo)
              return (
                <Grid key={`${item.chave}-${indice}`} size={{ xs: 12, md: 4 }}>
                  <Card variant="outlined" sx={{ p: 3, height: "100%" }}>
                    <Box
                      sx={{
                        width: 40,
                        height: 40,
                        borderRadius: "50%",
                        bgcolor: "primary.main",
                        color: "primary.contrastText",
                        display: "grid",
                        placeItems: "center",
                        fontWeight: 800,
                        mb: 1.5,
                      }}
                    >
                      {indice + 1}
                    </Box>
                    {titulo && (
                      <Typography variant="h6" component="h3" sx={{ fontWeight: 700, mb: 1 }}>
                        {titulo}
                      </Typography>
                    )}
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                      {corpo}
                    </Typography>
                  </Card>
                </Grid>
              )
            })}
          </Grid>
        </Container>
      )}

      {/* 6 — Segmentos */}
      {segmentos.length > 0 && (
        <Box sx={{ bgcolor: "action.hover", py: { xs: 5, md: 7 } }}>
          <Container maxWidth="lg">
            <TituloSecao id="titulo-segmentos">Para quem é</TituloSecao>
            <Grid container spacing={2} sx={{ mt: 2 }} data-testid="secao-segmentos">
              {segmentos.map((segmento, indice) => (
                <Grid key={`${segmento.titulo}-${indice}`} size={{ xs: 12, sm: 6, md: 3 }}>
                  <Card elevation={0} sx={{ p: 2.5, height: "100%", borderRadius: 3 }}>
                    {segmento.icone && (
                      <Typography variant="h5" sx={{ mb: 0.5 }}>
                        {segmento.icone}
                      </Typography>
                    )}
                    <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700 }}>
                      {segmento.titulo}
                    </Typography>
                    {segmento.descricao && (
                      <Typography variant="body2" color="text.secondary">
                        {segmento.descricao}
                      </Typography>
                    )}
                  </Card>
                </Grid>
              ))}
            </Grid>
          </Container>
        </Box>
      )}

      {/* 7 — Planos */}
      {planos.length > 0 && (
        <Container maxWidth="lg" sx={{ py: { xs: 5, md: 7 } }}>
          <TituloSecao id="titulo-planos">Planos</TituloSecao>
          <Grid container spacing={3} sx={{ mt: 2 }} data-testid="secao-planos">
            {planos.map((plano, indice) => (
              <Grid key={`${plano.nome}-${indice}`} size={{ xs: 12, md: 4 }}>
                <Card
                  variant="outlined"
                  sx={{
                    p: 3,
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.5,
                    borderColor: plano.maisPopular ? "primary.main" : "divider",
                    borderWidth: plano.maisPopular ? 2 : 1,
                    position: "relative",
                  }}
                >
                  {plano.maisPopular && (
                    <Chip
                      label="Mais popular"
                      color="primary"
                      size="small"
                      sx={{ position: "absolute", top: -12, left: 16, fontWeight: 700 }}
                    />
                  )}
                  <Typography variant="h5" component="h3" sx={{ fontWeight: 800 }}>
                    {plano.nome}
                  </Typography>
                  {plano.tagline && (
                    <Typography variant="body2" color="text.secondary">
                      {plano.tagline}
                    </Typography>
                  )}
                  <Box>
                    <Typography variant="h4" sx={{ fontWeight: 800 }}>
                      {formatarBRL(plano.precoMensal)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      por mês
                    </Typography>
                  </Box>
                  {plano.precoSetup !== null && (
                    <Typography variant="body2" color="text.secondary">
                      Setup único: {formatarBRL(plano.precoSetup)}
                    </Typography>
                  )}
                  {plano.beneficios.length > 0 && (
                    <Box component="ul" sx={{ m: 0, pl: 2, display: "grid", gap: 0.5 }}>
                      {plano.beneficios.map((beneficio, i) => (
                        <Typography
                          key={`${beneficio}-${i}`}
                          component="li"
                          variant="body2"
                          sx={{ overflowWrap: "anywhere" }}
                        >
                          {beneficio}
                        </Typography>
                      ))}
                    </Box>
                  )}
                  <Box sx={{ mt: "auto" }}>
                    {botaoComprar(
                      plano.textoBotao ?? "Comprar neste plano",
                      `plano-${plano.nome}-${indice}`,
                      plano.nome,
                    )}
                  </Box>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Container>
      )}

      {/* 8 — FAQ */}
      {faq.length > 0 && (
        <Box sx={{ bgcolor: "action.hover", py: { xs: 5, md: 7 } }}>
          <Container maxWidth="md">
            <TituloSecao id="titulo-faq">Perguntas frequentes</TituloSecao>
            <Stack spacing={1.5} sx={{ mt: 2 }} data-testid="secao-faq">
              {faq.map((item, indice) => (
                <Accordion key={`${item.pergunta}-${indice}`} variant="outlined" sx={{ bgcolor: "background.paper" }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography sx={{ fontWeight: 600 }}>{item.pergunta}</Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                      {item.resposta}
                    </Typography>
                  </AccordionDetails>
                </Accordion>
              ))}
            </Stack>
          </Container>
        </Box>
      )}

      {/* 9 — CTA final */}
      {ctaTextos.length > 0 && (
        <Box
          data-testid="secao-cta"
          sx={{
            background: (tema) =>
              `linear-gradient(160deg, ${tema.palette.primary.dark} 0%, ${tema.palette.secondary?.main ?? tema.palette.primary.main} 100%)`,
            color: "primary.contrastText",
            py: { xs: 6, md: 8 },
          }}
        >
          <Container maxWidth="md" sx={{ textAlign: "center" }}>
            <Stack spacing={2} alignItems="center">
              {texto("cta_titulo") && (
                <Typography variant="h4" component="h2" sx={{ fontWeight: 800 }}>
                  {texto("cta_titulo")}
                </Typography>
              )}
              {ctaCorpo.length > 0 && (
                <Typography variant="h6" sx={{ fontWeight: 400, opacity: 0.92 }}>
                  {ctaCorpo.join(" ")}
                </Typography>
              )}
              {botaoComprar(ctaBotao, "cta-final")}
            </Stack>
          </Container>
        </Box>
      )}
    </Box>
  )
}

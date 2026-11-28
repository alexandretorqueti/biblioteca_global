/**
 * PedidoAcompanhamento — acompanhamento público do pedido da Vitrine IA
 * (macro #10, posição 3/11 — subtarefa 2; REQ-F-004/REQ-F-015).
 *
 * Carrega EXCLUSIVAMENTE o pedido do token da rota
 * (`GET /vitrine/pedidos/:token` via `VitrinePublicaClient.obterPedidoPorToken`,
 * auth "none") — o backend é a fonte única e só devolve o pedido daquele
 * token; nenhuma listagem existe. Estados honestos:
 * - carregando: spinner;
 * - 404 (token inexistente/fora do formato): mensagem clara de link
 *   inválido, sem distinguir os casos (o servidor também não distingue);
 * - outro erro: falha genérica com opção de tentar de novo;
 * - pronto: status, dados do próprio pedido e metadados dos documentos
 *   (nome, tipo, tamanho) — texto livre aparece como documento
 *   `texto_livre`; lista vazia tem mensagem própria.
 *
 * Nenhum dado é inventado quando a resposta vem fora do contrato: o
 * api-client converte em `ApiClientError` (INVALID_RESPONSE) e a tela
 * mostra o estado de erro.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link, useParams } from "react-router-dom"
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Stack,
  Typography,
} from "@mui/material"
import { ApiClientError, VitrinePublicaClient } from "@biblioteca-global/api-client"
import type {
  VitrinePedidoAcompanhamento,
  VitrinePedidoStatus,
} from "@biblioteca-global/shared"
import { useApi } from "../../../apps/web/src/hooks/useApi"

type Estado = "carregando" | "pronto" | "invalido" | "erro"

/** Rótulos funcionais por status (espelham o enum do contrato; UI fixa). */
export const ROTULOS_STATUS: Record<
  VitrinePedidoStatus,
  { rotulo: string; cor: "default" | "info" | "success" | "warning" | "error" }
> = {
  criado: { rotulo: "Pedido recebido", cor: "info" },
  aguardando_pagamento: { rotulo: "Aguardando pagamento", cor: "warning" },
  pago: { rotulo: "Pagamento confirmado", cor: "success" },
  provisionando: { rotulo: "Provisionando seu atendente", cor: "info" },
  entregue: { rotulo: "Atendente entregue", cor: "success" },
  falha: { rotulo: "Falha no processamento", cor: "error" },
}

/** Data/hora pt-BR; string fora do formato ISO não é inventada — sai como veio. */
export function formatarDataHora(iso: string): string {
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return iso
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" }).format(data)
}

/** Tamanho legível (KB/MB) — null vira traço, sem número inventado. */
export function formatarBytes(tamanho: number | null): string {
  if (tamanho === null) return "—"
  if (tamanho < 1024) return `${tamanho} B`
  if (tamanho < 1024 * 1024) {
    return `${(tamanho / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`
  }
  return `${(tamanho / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`
}

/** Rótulo de documento sem nome (texto livre) — derivado do tipo do contrato. */
export function rotuloDocumento(nomeOriginal: string | null): string {
  return nomeOriginal ?? "Texto livre enviado no formulário"
}

export default function PedidoAcompanhamento(): ReactNode {
  const { token } = useParams<{ token: string }>()
  const bundle = useApi()
  const cliente = useMemo(
    () => (bundle ? new VitrinePublicaClient(bundle.http) : undefined),
    [bundle],
  )

  const [estado, setEstado] = useState<Estado>("carregando")
  const [pedido, setPedido] = useState<VitrinePedidoAcompanhamento | null>(null)
  const [reprocessar, setReprocessar] = useState(0)

  useEffect(() => {
    if (!token || !cliente) {
      setEstado(token ? "erro" : "invalido")
      return
    }
    let vivo = true
    setEstado("carregando")
    cliente
      .obterPedidoPorToken(token)
      .then((dados) => {
        if (!vivo) return
        setPedido(dados)
        setEstado("pronto")
      })
      .catch((erro: unknown) => {
        if (!vivo) return
        setEstado(erro instanceof ApiClientError && erro.status === 404 ? "invalido" : "erro")
      })
    return () => {
      vivo = false
    }
  }, [token, cliente, reprocessar])

  const tentarNovamente = useCallback(() => setReprocessar((t) => t + 1), [])

  if (estado === "carregando") {
    return (
      <Box
        data-testid="acompanhamento-loading"
        sx={{ minHeight: "50vh", display: "grid", placeItems: "center" }}
      >
        <CircularProgress aria-label="Carregando pedido" />
      </Box>
    )
  }

  if (estado === "invalido") {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Stack spacing={2}>
          <Alert severity="warning" data-testid="acompanhamento-invalido">
            Link inválido ou pedido não encontrado. Confira o código de
            acompanhamento que você recebeu ao enviar o pedido — ele é a única
            forma de consultar o status.
          </Alert>
          <Button component={Link} to="/vitrine-ia" color="inherit" sx={{ alignSelf: "flex-start" }}>
            Voltar para a vitrine
          </Button>
        </Stack>
      </Container>
    )
  }

  if (estado === "erro" || !pedido) {
    return (
      <Container maxWidth="sm" sx={{ py: 6 }}>
        <Stack spacing={2}>
          <Alert severity="error" data-testid="acompanhamento-erro">
            Não foi possível carregar o seu pedido agora. Tente novamente em
            instantes.
          </Alert>
          <Button
            variant="outlined"
            onClick={tentarNovamente}
            sx={{ alignSelf: "flex-start", borderRadius: 999 }}
            data-testid="botao-tentar-de-novo"
          >
            Tentar de novo
          </Button>
        </Stack>
      </Container>
    )
  }

  const status = ROTULOS_STATUS[pedido.status]

  return (
    <Container maxWidth="sm" sx={{ py: 6 }}>
      <Card variant="outlined" sx={{ p: { xs: 3, md: 4 } }}>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 800, mb: 1 }}>
              {pedido.nomeNegocio}
            </Typography>
            <Chip
              label={status.rotulo}
              color={status.cor}
              data-testid="chip-status"
              sx={{ fontWeight: 700 }}
            />
          </Box>

          <Divider />

          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Pedido recebido em {formatarDataHora(pedido.criadoEm)}
            </Typography>
            <Typography variant="body2">
              <strong>Contato:</strong> {pedido.nomeContato} · {pedido.email} ·{" "}
              {pedido.telefone}
            </Typography>
            <Typography variant="body2">
              <strong>Plano:</strong> {pedido.planoNome} (cobrança{" "}
              {pedido.ciclo === "anual" ? "anual" : "mensal"})
            </Typography>
          </Stack>

          {pedido.informacoesNegocio !== null && (
            <Box
              sx={{ p: 2, borderRadius: 2, bgcolor: "action.hover" }}
              data-testid="bloco-informacoes"
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                Informações do negócio
              </Typography>
              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {pedido.informacoesNegocio}
              </Typography>
            </Box>
          )}

          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              Documentos do pedido
            </Typography>
            {pedido.documentos.length === 0 ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 1 }}
                data-testid="documentos-vazio"
              >
                Nenhum documento foi anexado a este pedido.
              </Typography>
            ) : (
              <Stack spacing={1} sx={{ mt: 1 }} data-testid="lista-documentos">
                {pedido.documentos.map((documento, indice) => (
                  <Card key={`${documento.nomeOriginal}-${indice}`} variant="outlined" sx={{ px: 1.5, py: 1 }}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                      <Chip label={documento.tipoConteudo} size="small" variant="outlined" />
                      <Typography variant="body2" sx={{ flexGrow: 1, wordBreak: "break-all" }}>
                        {rotuloDocumento(documento.nomeOriginal)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatarBytes(documento.tamanhoBytes)}
                      </Typography>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            )}
          </Box>

          <Button component={Link} to="/vitrine-ia" color="inherit" sx={{ alignSelf: "flex-start" }}>
            Voltar para a vitrine
          </Button>
        </Stack>
      </Card>
    </Container>
  )
}

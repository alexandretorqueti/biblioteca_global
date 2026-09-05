/**
 * HelpDeskWidget — botão flutuante + chat estilo MSN para suporte ao sistema.
 *
 * Fluxo:
 *   1. Usuário clica no robô → abre painel de chat (320×480).
 *   2. Ao abrir, tenta criar/retomar sessão HelpDesk via driver injetado.
 *   3. Mensagens fluem pelo backend (bridge BFF com fallback em cadeia de agentes).
 *   4. Se a bridge retornar offline: exibe "Suporte indisponível no momento — tente novamente mais tarde".
 */
import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import { Box, IconButton, Paper, Stack, TextField, Typography, CircularProgress, Alert, Avatar } from "@mui/material"
import CloseIcon from "@mui/icons-material/Close"
import SendIcon from "@mui/icons-material/Send"
import type { HelpDeskDriver } from "@biblioteca-global/api-client"

/** SVG inline do robô animado — sem dependência de asset pipeline. */
const ROBOT_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <style>
    .antena-pulse { animation: antenaPulse 1.5s ease-in-out infinite; }
    .olho-esq { animation: piscarEsq 3s ease-in-out infinite; }
    .olho-dir { animation: piscarDir 3s ease-in-out infinite; }
    @keyframes antenaPulse {
      0%, 100% { opacity: 1; r: 4; }
      50% { opacity: 0.4; r: 2.5; }
    }
    @keyframes piscarEsq {
      0%, 42%, 48%, 100% { opacity: 1; }
      45% { opacity: 0; }
    }
    @keyframes piscarDir {
      0%, 43%, 49%, 100% { opacity: 1; }
      46% { opacity: 0; }
    }
  </style>
  <line x1="32" y1="8" x2="32" y2="16" stroke="#5a67d8" stroke-width="2.5" stroke-linecap="round"/>
  <circle class="antena-pulse" cx="32" cy="6" r="4" fill="#9f7aea"/>
  <rect x="14" y="16" width="36" height="28" rx="6" fill="#4c51bf" stroke="#2d3748" stroke-width="1.5"/>
  <circle class="olho-esq" cx="26" cy="29" r="4" fill="#fff"/>
  <circle cx="26" cy="29" r="2" fill="#2d3748"/>
  <circle class="olho-dir" cx="42" cy="29" r="4" fill="#fff"/>
  <circle cx="42" cy="29" r="2" fill="#2d3748"/>
  <rect x="24" y="36" width="16" height="4" rx="2" fill="#e2e8f0"/>
  <rect x="18" y="46" width="28" height="14" rx="4" fill="#4c51bf" stroke="#2d3748" stroke-width="1.5"/>
  <circle cx="32" cy="53" r="3" fill="#9f7aea"/>
  <rect x="6" y="48" width="10" height="6" rx="3" fill="#718096"/>
  <rect x="48" y="48" width="10" height="6" rx="3" fill="#718096"/>
  <text x="52" y="18" font-size="10" fill="#f6ad55" font-weight="bold">?</text>
</svg>`;

export interface HelpDeskWidgetProps {
  /** Cliente HelpDesk injetado pelo provedor (apps/web monta o driver com http + credenciais). */
  client: HelpDeskDriver
  children?: ReactNode
}

// ── Estados do chat ────────────────────────────────────────────────────

type ChatState = "conectando" | "online" | "offline"

/** Bolha de mensagem na UI (lado cliente). */
interface UIMessage {
  id: string
  role: "user" | "agent"
  text: string
  createdAt: string
}

export default function HelpDeskWidget({
  client,
}: HelpDeskWidgetProps) {
  const [open, setOpen] = useState(false)
  const [chatState, setChatState] = useState<ChatState>("conectando")
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null)
  const [agentName, setAgentName] = useState<string>("")
  const chatBottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll para a última mensagem
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ---- inicialização da sessão (lazy, só ao abrir) ----

  const initSession = useCallback(async () => {
    setChatState("conectando")

    try {
      const sessao = await client.obterSessao()
      if (!sessao) {
        throw new Error("Sessão HelpDesk indisponível")
      } else {
        // Carrega histórico da sessão existente.
        const history = await client.obterHistorico(sessao.sessaoId)
        setAgentName(sessao.agenteId)
        setMessages(
          history.mensagens.map((m, i) => ({
            id: `server-${m.id}-${i}`,
            role: m.role === "user" ? "user" : "agent",
            text: m.text,
            createdAt: m.createdAt,
          })),
        )
      }
      setChatState("online")
    } catch {
      setChatState("offline")
      setOfflineMessage("Suporte indisponível no momento — tente novamente mais tarde")
    }
  }, [client])

  // ---- ao abrir o painel, inicializa a sessão ----

  const handleToggle = useCallback(() => {
    if (!open) {
      initSession()
    }
    setOpen((v) => !v)
  }, [open, initSession])

  // ---- envio de mensagem ----

  const send = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const text = draft.trim()
      if (!text || sending || chatState !== "online") return

      const optimistic: UIMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, optimistic])
      setDraft("")
      setSending(true)
      setOfflineMessage(null)

      const sessaoId = client.sessaoId
      if (!sessaoId) {
        setSending(false)
        return
      }

      const result = await client.enviarMensagem({ sessaoId, text })

      if (!result.ok) {
        // Offline permanente: marca o estado e exibe mensagem.
        if (result.reason === "offline" || result.retryable === false) {
          setChatState("offline")
          setOfflineMessage("Suporte indisponível no momento — tente novamente mais tarde")
        } else {
          setOfflineMessage("Falha ao enviar a mensagem.")
        }
      } else {
        // Busca a resposta do agente.
        try {
          const history = await client.obterHistorico(sessaoId)
          const novaMsg = history.mensagens[history.mensagens.length - 1]
          if (novaMsg && novaMsg.role === "agent") {
            setMessages((prev) => [
              ...prev,
              {
                id: `server-${novaMsg.id}-${Date.now()}`,
                role: "agent",
                text: novaMsg.text,
                createdAt: novaMsg.createdAt,
              },
            ])
          }
        } catch {
          /* silencioso */
        }
      }

      setSending(false)
    },
    [draft, sending, chatState, client],
  )

  // ---- renderização do widget flutuante (botão) ----

  const floatingBtn = (
    <Box
      sx={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 1400,
        cursor: "pointer",
        transition: "transform 0.2s",
        filter: open ? "brightness(0.8)" : "none",
        "&:hover": { transform: "scale(1.15)" },
      }}
      onClick={handleToggle}
      role="button"
      aria-label="Abrir HelpDesk"
    >
      <Box component="img" src={`data:image/svg+xml,${encodeURIComponent(ROBOT_SVG)}`} width={64} height={64} sx={{ display: "block" }} />
    </Box>
  )

  // ---- renderização do chat MSN-style ----

  if (!open) return floatingBtn

  function formatTime(value?: string): string {
    if (!value) return ""
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  }

  const chatPainel = (
    <Box
      sx={{
        position: "fixed",
        bottom: 100,
        right: 24,
        width: 320,
        height: 480,
        zIndex: 1500,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Paper
        elevation={8}
        sx={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
          border: 1,
          borderColor: "divider",
        }}
        data-testid="helpdesk-chat"
      >
        {/* Header estilo MSN */}
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{ p: 1.5, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}
        >
          <Avatar sx={{ width: 36, height: 36, bgcolor: "#9f7aea" }}>🤖</Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" fontWeight={600}>HelpDesk</Typography>
            <Typography variant="caption" color="text.secondary">
              {chatState === "conectando" && "Conectando..."}
              {chatState === "online" && `Agente: ${agentName}`}
              {chatState === "offline" && "Offline"}
            </Typography>
          </Box>
          <IconButton size="small" onClick={() => setOpen(false)} aria-label="Fechar chat">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* Área de mensagens */}
        <Box sx={{ flex: 1, overflow: "auto", p: 2, display: "flex", flexDirection: "column", gap: 1 }}>
          {chatState === "conectando" ? (
            <Box sx={{ py: 6, textAlign: "center" }}>
              <CircularProgress size={24} />
            </Box>
          ) : offlineMessage ? (
            <Alert severity="error" sx={{ mt: 1 }} onClose={() => setOfflineMessage(null)}>
              {offlineMessage}
            </Alert>
          ) : messages.length === 0 ? (
            <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: 4 }}>
              Olá! Sou o assistente do sistema. Como posso ajudar?
            </Typography>
          ) : (
            <>
              {messages.map((msg) => {
                const isUser = msg.role === "user"
                return (
                  <Box
                    key={msg.id}
                    sx={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}
                  >
                    <Box sx={{ maxWidth: "78%" }}>
                      <Paper
                        elevation={0}
                        sx={{
                          px: 2,
                          py: 1,
                          bgcolor: isUser ? "primary.main" : "background.paper",
                          color: isUser ? "primary.contrastText" : "text.primary",
                          border: isUser ? 0 : 1,
                          borderColor: "divider",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        <Typography variant="body2">{msg.text}</Typography>
                      </Paper>
                      {msg.createdAt && (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: "block", mt: 0.25, textAlign: isUser ? "right" : "left" }}
                        >
                          {formatTime(msg.createdAt)}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                )
              })}
              <div ref={chatBottomRef} />
            </>
          )}
        </Box>

        {/* Input + botão enviar */}
        {chatState === "online" && (
          <Box component="form" onSubmit={(e) => void send(e)} sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}>
            <Stack direction="row" spacing={1}>
              <TextField
                fullWidth
                size="small"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Digite sua mensagem..."
                disabled={sending}
                inputProps={{ "aria-label": "Mensagem" }}
              />
              <IconButton type="submit" color="primary" disabled={sending || !draft.trim()}>
                {sending ? <CircularProgress size={20} /> : <SendIcon />}
              </IconButton>
            </Stack>
          </Box>
        )}
      </Paper>
    </Box>
  )

  return (
    <>
      {floatingBtn}
      {chatPainel}
    </>
  )
}

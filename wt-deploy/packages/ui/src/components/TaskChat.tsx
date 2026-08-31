/**
 * TaskChat — componente de chat da tarefa.
 *
 * GET /task/:id/chat → lista mensagens (role + text)
 * POST /task/:id/chat { role: 'admin', text } → envia mensagem
 * Após envio, reenvia (refresh) a lista completa.
 */
import { useEffect, useRef, useState } from "react"
import {
  Alert,
  Box,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material"

// ============================================================================
// Tipos
// ============================================================================

/** Representação de uma mensagem de chat armazenada no back-end. */
export interface TaskChatMessage {
  id: string | number
  /** Quem enviou: 'admin' (agente) ou 'user' (usuário). */
  role: "admin" | "user"
  /** Corpo da mensagem. */
  text: string
  /** timestamp opcional vinda do back-end. */
  createdAt?: string
}

/** Props públicas do TaskChat. */
export interface TaskChatProps {
  /** URL base da API (ex.: "/api"). O component concatena com path para montar a URL completa. */
  baseUrl: string
  /** ID da tarefa vinculada ao chat. */
  taskId: string | number
  /** Mensagem de erro do back-end quando a carga falha. */
  errorMessage?: string
}

// ============================================================================
// Componente
// ============================================================================

export default function TaskChat({
  baseUrl,
  taskId,
}: TaskChatProps) {
  const [messages, setMessages] = useState<TaskChatMessage[]>([])
  const [inputText, setInputText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  // Ref para scroll automático ao final da lista.
  const scrollRef = useRef<HTMLDivElement>(null)

  const isNearBottom = () => {
    if (!scrollRef.current) return true
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    return scrollHeight - scrollTop - clientHeight < 100
  }

  const handleScroll = () => {
    if (!scrollRef.current) return
    const nearBottom = isNearBottom()
    setUserScrolledUp(!nearBottom)
  }

  // --- carregar lista inicial -----------------------------------------------
  useEffect(() => {
    let cancelled = false

    async function carregar() {
      setError(null)
      try {
        const url = `${baseUrl}/task/${taskId}/chat`
        const resposta = await fetch(url, {
          headers: { Accept: "application/json" },
        })
        if (!resposta.ok) {
          let detalhe: string
          try {
            const corpo = await resposta.json()
            detalhe =
              typeof corpo === "object" &&
              corpo !== null &&
              "message" in corpo
                ? String((corpo as { message?: string }).message)
                : `HTTP ${resposta.status}`
          } catch {
            detalhe = `HTTP ${resposta.status}`
          }
          throw new Error(detalhe)
        }
        const dados = (await resposta.json()) as TaskChatMessage[]
        if (!cancelled) setMessages(dados)
      } catch (erro: unknown) {
        if (!cancelled) setError(erro instanceof Error ? erro.message : "Erro ao carregar chat")
      }
    }

    carregar()
    return () => { cancelled = true }
  }, [baseUrl, taskId])

  // scroll automático para o fim (só se o usuário não fez scroll para cima)
  useEffect(() => {
    if (scrollRef.current && !userScrolledUp) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, userScrolledUp])

  // Resetar userScrolledUp quando o usuário envia uma mensagem
  useEffect(() => {
    if (sending) {
      setUserScrolledUp(false)
    }
  }, [sending])

  // --- enviar mensagem -------------------------------------------------------
  const handleMessageSend = async () => {
    const texto = inputText.trim()
    if (!texto || sending) return

    setSending(true)
    setError(null)

    try {
      const url = `${baseUrl}/task/${taskId}/chat`
      const resposta = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" as const, text: texto }),
      })

      if (!resposta.ok) {
        let detalhe: string
        try {
          const corpo = await resposta.json()
          detalhe =
            typeof corpo === "object" &&
            corpo !== null &&
            "message" in corpo
              ? String((corpo as { message?: string }).message)
              : `HTTP ${resposta.status}`
        } catch {
          detalhe = `HTTP ${resposta.status}`
        }
        throw new Error(detalhe)
      }

      // Reenviar a lista completa após o POST (garante estado consistente).
      await carregarLista()

      setInputText("")
    } catch (erro: unknown) {
      setError(erro instanceof Error ? erro.message : "Erro ao enviar mensagem")
    } finally {
      setSending(false)
    }
  }

  // --- refresh da lista (chamado após POST e manualmente) ---------------------
  const carregarLista = async () => {
    try {
      const url = `${baseUrl}/task/${taskId}/chat`
      const resposta = await fetch(url, {
        headers: { Accept: "application/json" },
      })
      if (!resposta.ok) {
        let detalhe: string
        try {
          const corpo = await resposta.json()
          detalhe =
            typeof corpo === "object" &&
            corpo !== null &&
            "message" in corpo
              ? String((corpo as { message?: string }).message)
              : `HTTP ${resposta.status}`
        } catch {
          detalhe = `HTTP ${resposta.status}`
        }
        throw new Error(detalhe)
      }
      const dados = (await resposta.json()) as TaskChatMessage[]
      setMessages(dados)
    } catch (erro: unknown) {
      setError(erro instanceof Error ? erro.message : "Erro ao recarregar chat")
    }
  }

  // --- tratar Enter no TextField --------------------------------------------
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleMessageSend()
    }
  }

  // --- renderização ----------------------------------------------------------
  return (
    <Paper
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        maxHeight: "600px",
        overflow: "hidden",
      }}
      data-testid="taskchat-root"
    >
      {/* Lista de mensagens */}
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        sx={{
          flexGrow: 1,
          overflow: "auto",
          p: 2,
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        {error && (
          <Alert severity="error" sx={{ py: 0 }}>
            {error}
          </Alert>
        )}

        {messages.length === 0 && !error && (
          <Typography color="text.secondary" align="center" sx={{ mt: 4 }}>
            Nenhuma mensagem ainda. Inicie a conversa!
          </Typography>
        )}

        {messages.map((msg) => {
          const éAdmin = msg.role === "admin"
          return (
            <Stack
              key={msg.id}
              direction="row"
              justifyContent={éAdmin ? "flex-end" : "flex-start"}
            >
              <Paper
                elevation={1}
                sx={{
                  maxWidth: "70%",
                  px: 2,
                  py: 1,
                  bgcolor: éAdmin ? "primary.light" : "grey.100",
                  color: éAdmin ? "#fff" : "text.primary",
                  borderRadius: 2,
                }}
                data-testid={`taskchat-message-${msg.role}`}
              >
                <Typography variant="body2">{msg.text}</Typography>
                {msg.createdAt && (
                  <Typography
                    variant="caption"
                    sx={{ opacity: 0.6, display: "block", textAlign: "right", mt: 0.5 }}
                  >
                    {new Date(msg.createdAt).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Typography>
                )}
              </Paper>
            </Stack>
          )
        })}

        {/* Skeleton de carregamento */}
        {messages.length === 0 && !error && sending && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <Typography color="text.secondary">Enviando...</Typography>
          </Box>
        )}
      </Box>

      {/* Input de mensagem */}
      <Box sx={{ p: 2, borderTop: "1px solid", borderColor: "divider" }}>
        <Stack direction="row" spacing={1}>
          <TextField
            fullWidth
            size="small"
            placeholder="Digite uma mensagem..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            data-testid="taskchat-input"
          />
          <IconButton
            onClick={handleMessageSend}
            disabled={!inputText.trim() || sending}
            color="primary"
            aria-label="Enviar mensagem"
            data-testid="taskchat-send-button"
          >
            {/* Ícone de enviar */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2L11 13" />
              <path d="M22 2L15 22l-4-10-10-4z" />
            </svg>
          </IconButton>
        </Stack>
      </Box>
    </Paper>
  )
}

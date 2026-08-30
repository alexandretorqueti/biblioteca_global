import { useCallback, useEffect, useRef, useState } from "react"
import type { ChangeEvent, FormEvent, ReactNode } from "react"
import AttachFileIcon from "@mui/icons-material/AttachFile"
import CloseIcon from "@mui/icons-material/Close"
import SendIcon from "@mui/icons-material/Send"
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material"
import type {
  AgentChatDataSource,
  AgentInfo,
  ChatAttachment,
  ChatMessage,
} from "@biblioteca-global/shared"

export interface AgentChatProps {
  agent: AgentInfo
  client: AgentChatDataSource
  welcomeMessage?: string
  placeholder?: string
  emptyMessage?: string
  offlineMessage?: string
  allowAttachments?: boolean
  acceptedFileTypes?: string
  /** Intervalo para atualizar respostas assíncronas do agente; 0 desativa. */
  historyRefreshIntervalMs?: number
  maxHeight?: number | string
  onNewConversation?: () => void
  newConversationLabel?: string
  status?: ReactNode
  renderHeader?: (agent: AgentInfo) => ReactNode
  renderMessage?: (message: ChatMessage) => ReactNode
  renderSidebar?: (context: { agent: AgentInfo; messages: ChatMessage[]; metadata?: Record<string, unknown> }) => ReactNode
}

interface LocalAttachment extends ChatAttachment {
  id: number
}

let localSequence = 0

function formatTime(value?: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
}

function readAttachment(file: File): Promise<LocalAttachment> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    const base = {
      id: ++localSequence,
      name: file.name,
      size: file.size > 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${file.size} B`,
      mime: file.type || undefined,
    }
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : ""
      const separator = raw.indexOf(",")
      resolve({ ...base, base64: separator >= 0 ? raw.slice(separator + 1) : raw })
    }
    reader.onerror = () => resolve(base)
    reader.readAsDataURL(file)
  })
}

function mergeHistory(serverMessages: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  const serverUserTexts = new Set(
    serverMessages.filter((message) => message.role === "user").map((message) => message.text),
  )
  const optimistic = current.filter(
    (message) => message.id.startsWith("local-") && !(message.role === "user" && serverUserTexts.has(message.text)),
  )
  return [...serverMessages, ...optimistic]
}

export default function AgentChat({
  agent,
  client,
  welcomeMessage = `Olá! Eu sou ${agent.name}. Como posso ajudar?`,
  placeholder = "Digite sua mensagem...",
  emptyMessage = "Nenhuma mensagem ainda. Inicie a conversa!",
  offlineMessage = "Não foi possível conectar ao agente. Tente novamente em instantes.",
  allowAttachments = false,
  acceptedFileTypes,
  historyRefreshIntervalMs = 0,
  maxHeight = 640,
  onNewConversation,
  newConversationLabel = "Nova conversa",
  status,
  renderHeader,
  renderMessage,
  renderSidebar,
}: AgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(true)
  const [sessionReady, setSessionReady] = useState(false)
  const [sending, setSending] = useState(false)
  const [waitingAgent, setWaitingAgent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [metadata, setMetadata] = useState<Record<string, unknown> | undefined>()
  const chatRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const waitingAgentRef = useRef(false)
  const agentReplyCountRef = useRef(0)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  const isNearBottom = useCallback(() => {
    if (!chatRef.current) return true
    const { scrollTop, scrollHeight, clientHeight } = chatRef.current
    return scrollHeight - scrollTop - clientHeight < 100
  }, [])

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      if (chatRef.current && !userScrolledUp) {
        chatRef.current.scrollTop = chatRef.current.scrollHeight
      }
    })
  }, [userScrolledUp])

  const handleScroll = useCallback(() => {
    if (!chatRef.current) return
    const nearBottom = isNearBottom()
    setUserScrolledUp(!nearBottom)
  }, [isNearBottom])

  const load = useCallback(async () => {
    const history = await client.loadHistory()
    setMessages((current) => {
      const merged = mergeHistory(history.messages, current)
      // Conta quantas mensagens do agente existem
      const currentAgentCount = merged.filter((m) => m.role === "agent").length
      // Se aumentou a contagem de mensagens do agente, chegou resposta
      if (waitingAgentRef.current && currentAgentCount > agentReplyCountRef.current) {
        waitingAgentRef.current = false
        agentReplyCountRef.current = currentAgentCount
        setWaitingAgent(false)
      }
      return merged
    })
    setMetadata(history.metadata)
    scrollDown()
    return history
  }, [client, scrollDown])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await client.recordVisit?.()
        await client.startSession()
        const history = await client.loadHistory()
        if (cancelled) return
        setMetadata(history.metadata)
        setMessages(history.messages.length > 0 ? history.messages : [{ id: `local-${++localSequence}`, role: "agent", text: welcomeMessage }])
      } catch {
        if (!cancelled) {
          setError(offlineMessage)
          setMessages([{ id: `local-${++localSequence}`, role: "agent", text: welcomeMessage }])
        }
      } finally {
        if (!cancelled) {
          setSessionReady(true)
          setLoading(false)
        }
      }
    })()
    return () => { cancelled = true }
  }, [client, offlineMessage, welcomeMessage])

  useEffect(() => {
    if (!sessionReady || historyRefreshIntervalMs <= 0) return
    const intervalId = window.setInterval(() => {
      void load().catch(() => undefined)
    }, historyRefreshIntervalMs)
    return () => window.clearInterval(intervalId)
  }, [historyRefreshIntervalMs, load, sessionReady])

  useEffect(() => {
    // Só faz scroll automático se o usuário não fez scroll para cima
    if (!userScrolledUp) {
      scrollDown()
    }
  }, [messages, scrollDown, userScrolledUp])

  // Resetar userScrolledUp quando o usuário envia uma mensagem
  useEffect(() => {
    if (sending) {
      setUserScrolledUp(false)
    }
  }, [sending])

  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    const text = draft.trim()
    const validAttachments = attachments.filter((item): item is LocalAttachment & { base64: string } => Boolean(item.base64))
    if (sending || (!text && validAttachments.length === 0)) return

    const optimistic: ChatMessage = {
      id: `local-${++localSequence}`,
      role: "user",
      text: text || "[anexo]",
    }
    setMessages((current) => [...current, optimistic])
    setDraft("")
    setAttachments([])
    setSending(true)
    setError(null)
    waitingAgentRef.current = true
    setWaitingAgent(true)
    // Conta quantas mensagens do agente existem antes do envio
    const currentAgentCount = messages.filter((m) => m.role === "agent").length
    agentReplyCountRef.current = currentAgentCount
    try {
      const result = await client.sendMessage(text, validAttachments)
      if (!result.ok) {
        setError(result.reason === "offline" ? offlineMessage : "Não foi possível enviar a mensagem.")
        waitingAgentRef.current = false
        setWaitingAgent(false)
      }
      // Recarrega o histórico sempre (a mensagem pode ter sido persistida mesmo com erro)
      await load().catch(() => undefined)
    } finally {
      setSending(false)
    }
  }

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return
    void Promise.all(Array.from(files).map(readAttachment)).then(setAttachments)
    event.target.value = ""
  }

  return (
    <Paper
      data-testid="agent-chat-root"
      sx={{ display: "flex", flexDirection: "column", height: "100%", maxHeight, overflow: "hidden" }}
    >
      {renderHeader ? renderHeader(agent) : (
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
          <Avatar src={agent.avatarUrl} alt={agent.name}>{agent.name.charAt(0).toUpperCase()}</Avatar>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="subtitle1" fontWeight={600}>{agent.name}</Typography>
            {agent.domain && <Typography variant="caption" color="text.secondary">{agent.domain}</Typography>}
          </Box>
          {status}
          {onNewConversation && <Button size="small" onClick={onNewConversation}>{newConversationLabel}</Button>}
        </Stack>
      )}

      {error && <Alert severity="warning" onClose={() => setError(null)}>{error}</Alert>}
      <Box ref={chatRef} onScroll={handleScroll} sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2, position: "relative" }}>
        {loading ? (
          <Stack alignItems="center" sx={{ py: 4 }}><CircularProgress size={24} aria-label="Carregando conversa" /></Stack>
        ) : messages.length === 0 ? (
          <Typography color="text.secondary" align="center" sx={{ mt: 4 }}>{emptyMessage}</Typography>
        ) : (
          <Stack spacing={1}>
            {messages.map((message) => {
              if (renderMessage) return <Box key={message.id}>{renderMessage(message)}</Box>
              const isAgent = message.role !== "user"
              return (
                <Stack key={message.id} direction="row" justifyContent={isAgent ? "flex-start" : "flex-end"}>
                  <Box sx={{ maxWidth: "78%" }}>
                    <Paper
                      elevation={0}
                      sx={{
                        px: 2,
                        py: 1,
                        bgcolor: isAgent ? "background.paper" : "primary.main",
                        color: isAgent ? "text.primary" : "primary.contrastText",
                        border: isAgent ? 1 : 0,
                        borderColor: "divider",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      <Typography variant="body2">{message.text}</Typography>
                      {message.attachments?.map((attachment) => <Chip key={attachment.name} size="small" label={attachment.name} sx={{ mt: 1 }} />)}
                    </Paper>
                    {message.createdAt && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25, textAlign: isAgent ? "left" : "right" }}>{formatTime(message.createdAt)}</Typography>}
                  </Box>
                </Stack>
              )
            })}
            {waitingAgent && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
                <CircularProgress size={18} aria-label="Agente respondendo" />
                <Typography variant="body2" color="text.secondary">Digitando…</Typography>
              </Stack>
            )}
          </Stack>
        )}
      </Box>

      <Box component="form" onSubmit={(event) => void send(event)} sx={{ p: 2, borderTop: 1, borderColor: "divider" }}>
        {attachments.length > 0 && <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 1 }}>{attachments.map((attachment) => <Chip key={attachment.id} label={`${attachment.name} (${attachment.size})`} onDelete={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))} deleteIcon={<CloseIcon />} />)}</Stack>}
        <Stack direction="row" spacing={1}>
          <TextField fullWidth size="small" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholder} disabled={loading || sending} inputProps={{ "aria-label": placeholder }} />
          {allowAttachments && <IconButton type="button" aria-label="Anexar arquivo" onClick={() => fileRef.current?.click()} disabled={loading || sending}><AttachFileIcon /></IconButton>}
          <IconButton type="submit" color="primary" aria-label="Enviar mensagem" disabled={loading || sending || (!draft.trim() && attachments.length === 0)}><SendIcon /></IconButton>
        </Stack>
        {allowAttachments && <input ref={fileRef} hidden type="file" multiple accept={acceptedFileTypes} onChange={onPickFiles} />}
      </Box>
      {renderSidebar && (
        <Box component="aside" sx={{ borderTop: 1, borderColor: "divider", p: 2 }}>
          {renderSidebar({ agent, messages, metadata })}
        </Box>
      )}
    </Paper>
  )
}

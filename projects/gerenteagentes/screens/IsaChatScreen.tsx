import { useMemo, type ReactNode } from "react"
import { Alert, Box } from "@mui/material"
import { AgentChat } from "@biblioteca-global/ui"
import { createAgentChatClient } from "@biblioteca-global/api-client"
import { useApi } from "../../../apps/web/src/hooks/useApi"

function getVisitorKey(): string {
  const storageKey = "isa.chatId"
  const current = window.localStorage.getItem(storageKey)
  if (current) return current
  const generated = `visitor-${safeUuid()}`
  window.localStorage.setItem(storageKey, generated)
  return generated
}

function safeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Tela do subsistema Gerente Agentes que configura o chat compartilhado para a Isa. */
export default function IsaChatScreen(): ReactNode {
  const bundle = useApi()
  const visitorKey = useMemo(() => getVisitorKey(), [])
  const client = useMemo(() => {
    if (!bundle) return undefined
    return createAgentChatClient({
      http: bundle.http,
      agentId: "isa",
      visitorKey,
      endpoints: {
        sessionPath: "/session",
        sendPath: "/chat/send",
        historyPath: (chatId) => `/chat/${encodeURIComponent(chatId)}/history`,
        visitPath: "/site-visit",
        buildSessionBody: ({ visitorKey: key }) => ({ chatKey: key }),
        buildSendBody: ({ chatId, text, attachments }) => ({
          chatId,
          text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      },
    })
  }, [bundle, visitorKey])

  if (!client) {
    return <Alert severity="info">A conexão com a API ainda não está disponível.</Alert>
  }

  return (
    <Box sx={{ height: "calc(100vh - 160px)", minHeight: 480 }}>
      <AgentChat
        agent={{ id: "isa", name: "Isa", domain: "isa.globaltecnologia.net" }}
        client={client}
        welcomeMessage="Olá! 👋 Sou a Isa, da Global Tecnologia. Envie sua mensagem para eu te ajudar a construir o sistema que você precisa."
        placeholder="Digite sua mensagem..."
        allowAttachments
        acceptedFileTypes=".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.zip"
      />
    </Box>
  )
}

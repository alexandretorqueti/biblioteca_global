import type { TenantConfig } from "./types"

export const isaTenant: TenantConfig = {
  slug: "isa",
  agent: { id: "isa", name: "Isa", domain: "isa.globaltecnologia.net" },
  storage: { chatId: "isa.chatId", loginEmail: "isa.loginEmail" },
  title: "Isa - Global Tecnologia",
  description: "Isa, assistente virtual da Global Tecnologia",
  primary: "#003366",
  secondary: "#2e8bc0",
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  welcomeMessage: "Olá! 👋 Sou a Isa, da Global Tecnologia. Envie sua mensagem para eu te ajudar a construir o sistema que você precisa.",
  placeholder: "Digite sua mensagem...",
  sidebarTitle: "Projeto",
  buildSessionBody: (chatKey) => ({ chatKey }),
  buildSendBody: ({ chatId, text, attachments }) => ({
    chatId,
    text,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  }),
}

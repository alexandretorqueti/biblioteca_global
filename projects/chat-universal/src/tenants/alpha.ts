import type { TenantConfig } from "./types"

export const alphaTenant: TenantConfig = {
  slug: "alpha",
  agent: { id: "alpha", name: "Alpha", domain: "alpha.globaltecnologia.net" },
  storage: { chatId: "alpha.chatId", loginEmail: "alpha.loginEmail" },
  title: "Alpha | Alphaville Rio Costa do Sol",
  description: "Assistente virtual do Alphaville Rio Costa do Sol - Alto padrão em empreendimentos imobiliários",
  primary: "#1a3a5c",
  secondary: "#c9a961",
  fontFamily: '"Lato", "Helvetica", "Arial", sans-serif',
  welcomeMessage: "Olá! 👋 Sou a Alpha, assistente virtual do Alphaville Rio Costa do Sol. Estou aqui para ajudar você a descobrir o empreendimento ideal para seu perfil, apresentar nossos projetos de alto padrão e tirar todas as suas dúvidas sobre segurança, lazer e qualidade de vida. Como posso ajudar você hoje?",
  placeholder: "Digite sua mensagem...",
  sidebarTitle: "Seu Projeto",
  avatar: "/alpha-avatar.png",
  buildSessionBody: (chatKey) => ({ chatKey, agentId: "alpha" }),
  buildSendBody: ({ chatId, text, attachments }) => ({
    chatId,
    text,
    agentId: "alpha",
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  }),
}

export type TenantSlug = "isa" | "alpha"

export type TenantConfig = {
  slug: TenantSlug
  agent: { id: string; name: string; domain: string }
  storage: { chatId: string; loginEmail: string }
  title: string
  description: string
  primary: string
  secondary: string
  fontFamily: string
  welcomeMessage: string
  placeholder: string
  sidebarTitle: string
  avatar?: string
  buildSessionBody: (chatKey: string) => Record<string, unknown>
  buildSendBody: (input: { chatId: string; text: string; attachments?: unknown[] }) => Record<string, unknown>
}

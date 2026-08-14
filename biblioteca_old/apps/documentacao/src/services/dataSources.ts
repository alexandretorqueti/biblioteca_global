import {
  createCrudDataSource,
  createFileUploader,
  createRestEntityClient,
  type ApiRecord,
} from "@global/api-client"

export interface Cliente extends ApiRecord {
  id: number
  razaoSocial: string
  nomeFantasia: string
  cnpj: string
  data: string
  simplesNacional: boolean
  createdAt: string
  updatedAt: string
}

export interface Venda extends ApiRecord {
  id: number
  idCliente: number
  clienteRazaoSocial: string
  valor: number
  createdAt: string
  updatedAt: string
}

export interface Usuario extends ApiRecord {
  id: number
  nome: string
  email: string
  perfil: string
  ativo: boolean
  createdAt: string
  updatedAt: string
}

export type UsuarioPerfil =
  | "admin"
  | "gerente"
  | "operador"
  | "visualizador"

export const usuarioPerfilOptions: {
  label: string
  value: UsuarioPerfil
}[] = [
  { label: "Administrador", value: "admin" },
  { label: "Gerente", value: "gerente" },
  { label: "Operador", value: "operador" },
  { label: "Visualizador", value: "visualizador" },
]

export const usuarioPerfilLabel = (perfil: string): string =>
  usuarioPerfilOptions.find((option) => option.value === perfil)?.label ??
  perfil

export interface Projeto extends ApiRecord {
  id: string
  nome: string
  descricao?: string
}

const apiBaseUrl = "http://localhost:3003"

export const clientesClient = createRestEntityClient<Cliente>({
  baseUrl: apiBaseUrl,
  resource: "/api/clientes",
})

export const vendasClient = createRestEntityClient<Venda>({
  baseUrl: apiBaseUrl,
  resource: "/api/vendas",
})

export const clientesDataSource = createCrudDataSource(
  clientesClient,
  (cliente) => cliente.id,
)

export const vendasDataSource = createCrudDataSource(
  vendasClient,
  (venda) => venda.id,
)

export const usuariosClient = createRestEntityClient<Usuario>({
  baseUrl: apiBaseUrl,
  resource: "/api/usuarios",
})

export const usuariosDataSource = createCrudDataSource(
  usuariosClient,
  (usuario) => usuario.id,
)

export const loadUsuarios = (search: string) =>
  usuariosClient.list(
    search ? { nome: search } : {},
  )

export const loadClientes = (search: string) =>
  clientesClient.list(
    search ? { razaoSocial: search } : {},
  )

export const uploadPhoto = createFileUploader({
  url: `${apiBaseUrl}/api/uploads/photos`,
})

// Dados de projetos para demo (simulando fonte remota)
const projetosBase: Projeto[] = [
  { id: "proj-alfa", nome: "Projeto Alfa", descricao: "Módulo principal da plataforma" },
  { id: "proj-beta", nome: "Projeto Beta", descricao: "Integrações e APIs" },
  { id: "proj-gamma", nome: "Projeto Gamma", descricao: "Relatórios e dashboards" },
  { id: "proj-delta", nome: "Projeto Delta", descricao: "Ambiente de homologação" },
]

/**
 * Simula carregamento assíncrono remoto de projetos.
 * Aceita filtro por nome (case-insensitive).
 * Inclui pequeno delay para demonstrar estado de loading do FieldMultipleChoice.
 */
export const loadProjetos = async (search: string): Promise<Projeto[]> => {
  // Simula latência de rede
  await new Promise((resolve) => setTimeout(resolve, 280))

  const termo = (search || "").toLowerCase().trim()

  if (!termo) {
    return [...projetosBase]
  }

  return projetosBase.filter(
    (p) =>
      p.nome.toLowerCase().includes(termo) ||
      (p.descricao && p.descricao.toLowerCase().includes(termo)),
  )
}

// Export para uso em outros lugares do demo
export { projetosBase }

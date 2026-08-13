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

export const loadClientes = (search: string) =>
  clientesClient.list(
    search ? { razaoSocial: search } : {},
  )

export const uploadPhoto = createFileUploader({
  url: `${apiBaseUrl}/api/uploads/photos`,
})

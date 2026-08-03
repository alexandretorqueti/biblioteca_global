import Cadastro from "../components/Cadastro"
import type { DynamicField } from "../components/DynamicForm"
import type { EntityRecord } from "../api/entityApi"

interface Venda extends EntityRecord {
  id: number
  idCliente: number
  clienteRazaoSocial: string
  valor: number
  createdAt: string
  updatedAt: string
}

const fields: DynamicField[] = [
  {
    name: "idCliente",
    label: "Cliente",
    type: "multipleChoice",
    required: true,
    fullWidth: true,
    multipleChoice: {
      entity: "clientes",
      idField: "id",
      displayField: "razaoSocial",
      filterField: "razaoSocial",
      minimumSearchLength: 0,
      debounceMs: 300,
      noOptionsText: "Nenhum cliente encontrado",
    },
  },
  {
    name: "valor",
    label: "Valor da venda",
    type: "number",
    required: true,
    min: 0,
  },
]

export default function VendasExample() {
  return (
    <Cadastro<Venda>
      entity="vendas"
      title="Cadastro de Vendas"
      fields={fields}
      columns={2}
      newLabel="Nova venda"
      hiddenColumns={[
        "idCliente",
        "createdAt",
        "updatedAt",
      ]}
      gridColumns={{
        id: {
          type: "text",
          label: "ID da venda",
        },
        clienteRazaoSocial: {
          type: "text",
          label: "Cliente",
        },
        valor: {
          type: "text",
          label: "Valor",
        },
      }}
    />
  )
}

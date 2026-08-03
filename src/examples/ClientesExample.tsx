import Cadastro from "../components/Cadastro"
import type { DynamicField } from "../components/DynamicForm"
import type { EntityRecord } from "../api/entityApi"

interface Cliente extends EntityRecord {
  id: number
  razaoSocial: string
  nomeFantasia: string
  cnpj: string
  data: string
  createdAt: string
  updatedAt: string
}

const fields: DynamicField[] = [
  {
    name: "razaoSocial",
    label: "Razão Social",
    type: "text",
    required: true,
    fullWidth: true,
    minLength: 3,
    maxLength: 150,
  },
  {
    name: "nomeFantasia",
    label: "Nome Fantasia",
    type: "text",
    required: true,
    minLength: 2,
    maxLength: 100,
  },
  {
    name: "cnpj",
    label: "CNPJ",
    type: "text",
    required: true,
    placeholder: "00.000.000/0000-00",
    minLength: 14,
    maxLength: 18,
  },
  {
    name: "data",
    label: "Data",
    type: "date",
    required: true,
  },
]

export default function ClientesExample() {
  return (
    <Cadastro<Cliente>
      entity="clientes"
      title="Cadastro de Clientes"
      fields={fields}
      columns={2}
      newLabel="Novo cliente"
      hiddenColumns={["createdAt", "updatedAt"]}
      gridColumns={{
        id: {
          type: "text",
          label: "Código",
        },
        razaoSocial: {
          type: "text",
          label: "Razão Social",
        },
        nomeFantasia: {
          type: "text",
          label: "Nome Fantasia",
        },
        cnpj: {
          type: "text",
          label: "CNPJ",
        },
        data: {
          type: "date",
          label: "Data",
          dateFormat: "DD/MM/YYYY",
        },
      }}
    />
  )
}

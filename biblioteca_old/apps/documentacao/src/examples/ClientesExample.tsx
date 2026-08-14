import { useMemo } from "react"
import { Cadastro, type DynamicField } from "@alexandretorqueti/biblioteca-global-ui"
import {
  clientesDataSource,
  type Cliente,
} from "../services/dataSources"
import { useProject } from "../context/ProjectContext"

export const baseClienteFields: DynamicField[] = [
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
    minLength: 18,
    maxLength: 18,
    mask: "cnpj",
    validator: "cnpj",
  },
  {
    name: "data",
    label: "Data",
    type: "date",
    required: true,
  },
  {
    name: "simplesNacional",
    label: "Simples Nacional",
    type: "boolean",
    booleanStyle: "select",
    trueLabel: "Sim",
    falseLabel: "Não",
    defaultValue: false,
  },
]

export default function ClientesExample() {
  const { selectedProject, isProjectSelected } = useProject()

  const fields: DynamicField[] = useMemo(() => {
    const extraFields: DynamicField[] = []

    if (isProjectSelected && selectedProject) {
      extraFields.push({
        name: "contextoProjeto",
        label: "Contexto / Projeto",
        type: "text",
        required: false,
        helperText: "Preenchido automaticamente pelo projeto selecionado após autenticação",
        defaultValue: selectedProject.nome,
        // visual hint
      })
    }

    return [...baseClienteFields, ...extraFields]
  }, [selectedProject, isProjectSelected])

  return (
    <Cadastro<Cliente>
      dataSource={clientesDataSource}
      title={selectedProject 
        ? `Cadastro de Clientes — ${selectedProject.nome}` 
        : "Cadastro de Clientes"}
      fields={fields}
      columns={2}
      newLabel="Novo cliente"
      hiddenColumns={["createdAt", "updatedAt", "contextoProjeto"]}
      gridColumns={{
        id: { type: "text", label: "Código" },
        razaoSocial: { type: "text", label: "Razão Social" },
        nomeFantasia: { type: "text", label: "Nome Fantasia" },
        cnpj: { type: "text", label: "CNPJ" },
        data: { type: "date", label: "Data", dateFormat: "DD/MM/YYYY" },
        simplesNacional: { type: "boolean", label: "Simples Nacional" },
      }}
    />
  )
}

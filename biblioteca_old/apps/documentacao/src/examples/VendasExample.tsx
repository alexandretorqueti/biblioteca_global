import { useMemo } from "react"
import { Cadastro, type DynamicField } from "@alexandretorqueti/biblioteca-global-ui"
import {
  loadClientes,
  vendasDataSource,
  type Venda,
} from "../services/dataSources"
import { useProject } from "../context/ProjectContext"

export const baseVendaFields: DynamicField[] = [
  {
    name: "idCliente",
    label: "Cliente",
    type: "multipleChoice",
    required: true,
    fullWidth: true,
    multipleChoice: {
      loadOptions: loadClientes,
      idField: "id",
      displayField: "razaoSocial",
      minimumSearchLength: 0,
      debounceMs: 300,
      noOptionsText: "Nenhum cliente encontrado",
    },
  },
  {
    name: "valor",
    label: "Valor da venda",
    type: "money",
    required: true,
    min: 0,
    currency: "BRL",
    currencyLocale: "pt-BR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  },
]

export default function VendasExample() {
  const { selectedProject, isProjectSelected } = useProject()

  const fields: DynamicField[] = useMemo(() => {
    const extra: DynamicField[] = []

    if (isProjectSelected && selectedProject) {
      extra.push({
        name: "contextoProjeto",
        label: "Contexto / Projeto",
        type: "text",
        required: false,
        helperText: "Herdado do projeto selecionado após autenticação",
        defaultValue: selectedProject.nome,
      })
    }

    return [...baseVendaFields, ...extra]
  }, [selectedProject, isProjectSelected])

  return (
    <Cadastro<Venda>
      dataSource={vendasDataSource}
      title={selectedProject 
        ? `Cadastro de Vendas — ${selectedProject.nome}` 
        : "Cadastro de Vendas"}
      fields={fields}
      columns={2}
      newLabel="Nova venda"
      hiddenColumns={["idCliente", "createdAt", "updatedAt", "contextoProjeto"]}
      gridColumns={{
        id: { type: "text", label: "ID da venda" },
        clienteRazaoSocial: { type: "text", label: "Cliente" },
        valor: {
          type: "money",
          label: "Valor",
          currency: "BRL",
          currencyLocale: "pt-BR",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        },
      }}
    />
  )
}

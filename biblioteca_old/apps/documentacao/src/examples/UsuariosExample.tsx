import { useMemo } from "react"
import { Cadastro, type DynamicField } from "@alexandretorqueti/biblioteca-global-ui"
import {
  usuariosDataSource,
  usuarioPerfilOptions,
  type Usuario,
} from "../services/dataSources"
import { useProject } from "../context/ProjectContext"

export const baseUsuarioFields: DynamicField[] = [
  {
    name: "nome",
    label: "Nome completo",
    type: "text",
    required: true,
    fullWidth: true,
    placeholder: "Ex.: Maria da Silva",
    minLength: 3,
    maxLength: 120,
  },
  {
    name: "email",
    label: "E-mail",
    type: "email",
    required: true,
    fullWidth: true,
    placeholder: "maria.silva@empresa.com.br",
    maxLength: 150,
  },
  {
    name: "perfil",
    label: "Perfil de acesso",
    type: "select",
    required: true,
    options: usuarioPerfilOptions,
    defaultValue: "operador",
  },
  {
    name: "ativo",
    label: "Usuário ativo",
    type: "boolean",
    booleanStyle: "select",
    trueLabel: "Sim",
    falseLabel: "Não",
    defaultValue: true,
  },
]

export default function UsuariosExample() {
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
      })
    }

    return [...baseUsuarioFields, ...extraFields]
  }, [selectedProject, isProjectSelected])

  return (
    <Cadastro<Usuario>
      dataSource={usuariosDataSource}
      title={selectedProject
        ? `Cadastro de Usuários — ${selectedProject.nome}`
        : "Cadastro de Usuários"}
      fields={fields}
      columns={2}
      newLabel="Novo usuário"
      hiddenColumns={["createdAt", "updatedAt", "contextoProjeto"]}
      gridColumns={{
        id: { type: "text", label: "Código" },
        nome: { type: "text", label: "Nome" },
        email: { type: "text", label: "E-mail" },
        perfil: { type: "text", label: "Perfil" },
        ativo: { type: "boolean", label: "Ativo" },
      }}
    />
  )
}

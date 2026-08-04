import { useState } from "react"
import { Stack } from "@mui/material"
import DynamicForm, {
  type DynamicField,
  type DynamicFormValues,
} from "../components/DynamicForm"
import ResultPanel from "../components/ResultPanel"

const fields: DynamicField[] = [
  {
    name: "nome",
    label: "Nome completo",
    type: "text",
    required: true,
    minLength: 3,
  },
  {
    name: "email",
    label: "E-mail",
    type: "email",
    required: true,
  },
  {
    name: "cnpj",
    label: "CNPJ",
    type: "text",
    mask: "cnpj",
    validator: "cnpj",
    maxLength: 18,
  },
  {
    name: "idade",
    label: "Idade",
    type: "number",
    min: 0,
    max: 120,
  },
]

export default function FormDemoPage() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Cadastro de usuário"
        fields={fields}
        columns={2}
        submitLabel="Salvar usuário"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

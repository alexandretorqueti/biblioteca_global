import { useState } from "react"
import { Stack } from "@mui/material"
import {
  DynamicForm,
  type DynamicField,
  type DynamicFormValues,
} from "@alexandretorqueti/biblioteca-global-ui"
import ResultPanel from "../components/ResultPanel"

const fields: DynamicField[] = [
  {
    name: "valor",
    label: "Valor",
    type: "money",
    required: true,
    currency: "BRL",
    currencyLocale: "pt-BR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    min: 0,
  },
]

export default function MoneyDemoPage() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de campo monetário"
        fields={fields}
        columns={1}
        submitLabel="Salvar valor"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

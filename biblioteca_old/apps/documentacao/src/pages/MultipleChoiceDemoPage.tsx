import { useState } from "react"
import { Stack } from "@mui/material"
import {
  DynamicForm,
  type DynamicField,
  type DynamicFormValues,
} from "@alexandretorqueti/biblioteca-global-ui"
import ResultPanel from "../components/ResultPanel"
import { loadClientes } from "../services/dataSources"

const fields: DynamicField[] = [
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
    },
  },
]

export default function MultipleChoiceDemoPage() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de seleção de cliente"
        fields={fields}
        columns={1}
        submitLabel="Selecionar"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

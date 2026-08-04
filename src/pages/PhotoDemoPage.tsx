import { useState } from "react"
import { Stack } from "@mui/material"
import DynamicForm, {
  type DynamicField,
  type DynamicFormValues,
} from "../components/DynamicForm"
import ResultPanel from "../components/ResultPanel"

const fields: DynamicField[] = [
  {
    name: "foto",
    label: "Foto do perfil",
    type: "photo",
    required: true,
    fullWidth: true,
    accept: "image/png,image/jpeg,image/webp",
    maxFileSizeMb: 5,
    uploadUrl: "http://localhost:3001/api/uploads/photos",
    helperText:
      "Arraste uma imagem para a área ou clique para selecionar.",
  },
]

export default function PhotoDemoPage() {
  const [result, setResult] = useState<DynamicFormValues | null>(null)

  return (
    <Stack spacing={3}>
      <DynamicForm
        title="Exemplo de upload de foto"
        fields={fields}
        columns={1}
        submitLabel="Salvar foto"
        onSubmit={setResult}
      />
      {result && <ResultPanel value={result} />}
    </Stack>
  )
}

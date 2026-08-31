/**
 * useApi — hook para telas custom acessarem o bundle HTTP autenticado.
 *
 * Telas custom em `projects/<slug>/screens/` podem importar este hook
 * para fazer requisições autenticadas via api-client.
 */
import { useContext } from "react"
import { ProjectContext } from "../project/ProjectContext"

export function useApi() {
  const ctx = useContext(ProjectContext)
  return ctx?.bundle
}

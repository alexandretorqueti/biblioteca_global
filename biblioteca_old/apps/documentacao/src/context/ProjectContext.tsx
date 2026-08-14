import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { Projeto } from "../services/dataSources"

interface ProjectContextValue {
  selectedProjectId: string | number | null
  selectedProject: Projeto | null
  setSelectedProject: (projeto: Projeto | null) => void
  clearProject: () => void
  isProjectSelected: boolean
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined)

const STORAGE_KEY = "biblioteca-global:selected-project-id"

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | number | null>(null)
  const [selectedProject, setSelectedProjectState] = useState<Projeto | null>(null)

  // Carregar do localStorage ao montar
  useEffect(() => {
    try {
      const savedId = localStorage.getItem(STORAGE_KEY)
      if (savedId) {
        setSelectedProjectId(savedId)
      }
    } catch {
      // localStorage pode estar indisponível
    }
  }, [])

  // Persistir quando mudar
  useEffect(() => {
    try {
      if (selectedProjectId != null) {
        localStorage.setItem(STORAGE_KEY, String(selectedProjectId))
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      // ignore
    }
  }, [selectedProjectId])

  const setSelectedProject = (projeto: Projeto | null) => {
    setSelectedProjectState(projeto)
    setSelectedProjectId(projeto ? projeto.id : null)
  }

  const clearProject = () => {
    setSelectedProjectState(null)
    setSelectedProjectId(null)
  }

  return (
    <ProjectContext.Provider
      value={{
        selectedProjectId,
        selectedProject,
        setSelectedProject,
        clearProject,
        isProjectSelected: selectedProjectId != null,
      }}
    >
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error("useProject deve ser usado dentro de ProjectProvider")
  }
  return context
}

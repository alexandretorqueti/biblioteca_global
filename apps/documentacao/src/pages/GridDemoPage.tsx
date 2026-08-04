import { JsonGrid, type JsonRecord } from "@global/ui"

const exampleData: JsonRecord[] = [
  {
    id: 1,
    nome: "Clean Code",
    autor: "Robert C. Martin",
    categoria: "Engenharia de software",
    disponivel: true,
  },
  {
    id: 2,
    nome: "Refactoring",
    autor: "Martin Fowler",
    categoria: "Desenvolvimento",
    disponivel: false,
  },
  {
    id: 3,
    nome: "Domain-Driven Design",
    autor: "Eric Evans",
    categoria: "Arquitetura",
    disponivel: true,
  },
]

export default function GridDemoPage() {
  return <JsonGrid title="Livros cadastrados" data={exampleData} />
}

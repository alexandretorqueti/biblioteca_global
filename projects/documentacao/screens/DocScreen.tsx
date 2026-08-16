import React from "react"

/**
 * Tela de documentação do projeto "documentacao".
 *
 * Por enquanto exibimos um placeholder estático. Em produção poderia carregar
 * o HTML gerado em `apps/documentacao/index.html` ou renderizar Markdown.
 */
export default function DocumentationScreen() {
  return (
    <div style={{ padding: "2rem" }}>
      <h1>Documentação do Projeto</h1>
      <p>
        Esta é a tela de documentação para o projeto <strong>documentacao</strong>.
        O conteúdo futuro poderá ser carregado dinamicamente a partir de arquivos
        estáticos ou de um serviço de renderização Markdown.
      </p>
    </div>
  )
}

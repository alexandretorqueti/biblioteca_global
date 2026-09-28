/**
 * Testes unitários do DiffViewer.
 *
 * Valida a conversão de patch unificado para oldValue/newValue e
 * o comportamento do componente DiffViewer.
 */
import { describe, expect, it } from 'vitest'
import { parsePatchToOldNew } from '../screens/DiffViewer'

// ─── Testes de parsePatchToOldNew ─────────────────────────────────────────────

describe('parsePatchToOldNew', () => {
  // Caso 1: Patch unificado com linhas removidas, adicionadas e de contexto
  it('converte patch unificado com linhas removidas, adicionadas e de contexto', () => {
    const patch = `diff --git a/src/example.ts b/src/example.ts
index 1234567..89abcde 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,5 +1,5 @@
 console.log("Hello, World!")
-const a = 10
+const a = 20
 const b = 20
-const c = 30
+const c = 40
 const d = 40
`
    const { oldValue, newValue } = parsePatchToOldNew(patch)

    expect(oldValue).toBe('console.log("Hello, World!")\nconst a = 10\nconst b = 20\nconst c = 30\nconst d = 40')
    expect(newValue).toBe('console.log("Hello, World!")\nconst a = 20\nconst b = 20\nconst c = 40\nconst d = 40')
  })

  // Caso 2: Patch com apenas linhas removidas (arquivo sendo deletado)
  it('converte patch com apenas linhas removidas (arquivo deletado)', () => {
    const patch = `diff --git a/src/deleted.ts b/src/deleted.ts
index abcdef1..0000000 100644
--- a/src/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-console.log("Este arquivo será deletado")
-console.log("Linha 2")
-console.log("Linha 3")
`
    const { oldValue, newValue } = parsePatchToOldNew(patch)

    expect(oldValue).toBe('console.log("Este arquivo será deletado")\nconsole.log("Linha 2")\nconsole.log("Linha 3")')
    expect(newValue).toBe('')
  })

  // Caso 3: Patch com apenas linhas adicionadas (novo arquivo)
  it('converte patch com apenas linhas adicionadas (novo arquivo)', () => {
    const patch = `diff --git a/src/new.ts b/src/new.ts
index 0000000..1234567 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+console.log("Este é um novo arquivo")
+const x = 10
+const y = 20
`
    const { oldValue, newValue } = parsePatchToOldNew(patch)

    expect(oldValue).toBe('')
    expect(newValue).toBe('console.log("Este é um novo arquivo")\nconst x = 10\nconst y = 20')
  })

  // Caso 4: Patch sem prefixo diff --git (não é patch válido)
  it('retorna oldValue vazio e newValue como patch quando não é patch unificado', () => {
    const text = 'Este é apenas um texto, não um patch'
    const { oldValue, newValue } = parsePatchToOldNew(text)

    expect(oldValue).toBe('')
    expect(newValue).toBe(text)
  })

  // Caso 5: Patch com linhas de contexto apenas (sem alterações reais)
  it('mantém linhas de contexto iguais em oldValue e newValue', () => {
    const patch = `diff --git a/src/only-context.ts b/src/only-context.ts
index abcdef1..abcdef1 100644
--- a/src/only-context.ts
+++ b/src/only-context.ts
@@ -1,3 +1,3 @@
 const a = 1
 const b = 2
 const c = 3
`
    const { oldValue, newValue } = parsePatchToOldNew(patch)

    expect(oldValue).toBe('const a = 1\nconst b = 2\nconst c = 3')
    expect(newValue).toBe('const a = 1\nconst b = 2\nconst c = 3')
  })

  // Caso 6: Patch vazio ou null
  it('retorna oldValue e newValue vazios para patch vazio', () => {
    const { oldValue, newValue } = parsePatchToOldNew('')

    expect(oldValue).toBe('')
    expect(newValue).toBe('')
  })

  // Caso 7: Patch com multiple hunks
  it('converte patch com múltiplos hunks', () => {
    const patch = `diff --git a/src/multi.ts b/src/multi.ts
index 1111111..2222222 100644
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1,2 +1,2 @@
-const x = 1
+const x = 10
 const y = 2
@@ -5,2 +5,2 @@
-const a = 5
+const a = 50
 const b = 6
`
    const { oldValue, newValue } = parsePatchToOldNew(patch)

    expect(oldValue).toBe('const x = 1\nconst y = 2\nconst a = 5\nconst b = 6')
    expect(newValue).toBe('const x = 10\nconst y = 2\nconst a = 50\nconst b = 6')
  })

  // Caso 8: Patch com linhas mescladas (remoção seguida de adição no mesmo hunk)
  it('preserva ordem relativa de remoções e adições', () => {
    const patch = `diff --git a/src/ordered.ts b/src/ordered.ts
index abcdef1..1234567 100644
--- a/src/ordered.ts
+++ b/src/ordered.ts
@@ -1,5 +1,5 @@
 const a = 1
-const b = 2
+const b = 20
 const c = 3
-const d = 4
 const e = 5
+const f = 6
`
    const { oldValue, newValue } = parsePatchToOldNew(patch)

    expect(oldValue).toBe('const a = 1\nconst b = 2\nconst c = 3\nconst d = 4\nconst e = 5')
    expect(newValue).toBe('const a = 1\nconst b = 20\nconst c = 3\nconst e = 5\nconst f = 6')
  })
})

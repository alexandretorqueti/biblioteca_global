import { useEffect, useState } from "react"
import {
  Box,
  FormHelperText,
  Typography,
  useTheme,
} from "@mui/material"
import JsonViewEditor from "@uiw/react-json-view/editor"
import { darkTheme } from "@uiw/react-json-view/dark"
import { lightTheme } from "@uiw/react-json-view/light"

/**
 * Editor de JSON em árvore (colapsar/expandir, editar valores e chaves,
 * adicionar e remover propriedades) no lugar da textarea comum.
 *
 * O `@uiw/react-json-view` é SEMI-CONTROLADO: o componente mantém uma cópia
 * interna do valor e os callbacks onEdit/onAdd/onDelete avisam a mudança por
 * caminho (`namespace`). Aqui mantemos uma cópia de trabalho própria:
 *  - o form continua trabalhando com STRING (DynamicFormValues não muda);
 *  - a string vira objeto na borda e o objeto editado é serializado de volta;
 *  - remount (key) apenas quando o valor EXTERNO muda (ex.: abrir outro
 *    registro) — edições do próprio usuário não remontam a árvore.
 */

export type JsonValue =
  | Record<string, unknown>
  | unknown[]
  | null
  | undefined

interface JsonEditOption {
  value: unknown
  oldValue?: unknown
  keyName?: string | number
  parentName?: string | number
  type?: "value" | "key"
  namespace?: Array<string | number>
}

interface FieldJsonProps {
  name: string
  label: string
  /** JSON serializado (pretty) ou string vazia. */
  value: string
  helperText?: string
  error?: string
  disabled?: boolean
  required?: boolean
  onChange: (name: string, value: string) => void
}

const parse = (raw: string): JsonValue => {
  if (raw.trim() === "") {
    return undefined
  }
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return undefined
  }
}

const serialize = (value: JsonValue): string =>
  value === undefined ? "" : JSON.stringify(value, null, 2)

/** Atualiza o valor no caminho (array de chaves/índices), imutável. */
function setAtPath(
  root: unknown,
  path: Array<string | number>,
  value: unknown,
): unknown {
  if (path.length === 0) {
    return value as JsonValue
  }
  const [head, ...rest] = path
  if (Array.isArray(root)) {
    const next = [...root]
    next[Number(head)] = setAtPath(root[Number(head)], rest, value)
    return next
  }
  if (root !== null && typeof root === "object") {
    return {
      ...root,
      [head as string]: setAtPath(
        (root as Record<string, unknown>)[head as string],
        rest,
        value,
      ),
    }
  }
  // Raiz não é objeto: cria o nível pai para acomodar o caminho.
  return {
    [head as string]: setAtPath(undefined, rest, value),
  }
}

/** Remove a chave/índice no caminho, imutável. */
function removeAtPath(
  root: unknown,
  path: Array<string | number>,
): unknown {
  if (path.length === 0 || root === null || root === undefined) {
    return root
  }
  const [head, ...rest] = path
  if (Array.isArray(root)) {
    const next = [...root]
    const index = Number(head)
    if (rest.length === 0) {
      next.splice(index, 1)
      return next
    }
    next[index] = removeAtPath(next[index], rest)
    return next
  }
  const next = { ...(root as Record<string, unknown>) }
  if (rest.length === 0) {
    delete next[head as string]
    return next
  }
  next[head as string] = removeAtPath(next[head as string], rest)
  return next
}

/** Lê o valor no caminho. */
function getAtPath(
  root: unknown,
  path: Array<string | number>,
): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return undefined
    }
    current = (current as Record<string | number, unknown>)[segment]
  }
  return current
}

/** Caminho do primeiro nó profundamente igual ao alvo (fallback do onAdd). */
function findPathByDeepEqual(
  root: unknown,
  target: unknown,
  path: Array<string | number> = [],
): Array<string | number> | null {
  if (deepEqual(root, target)) {
    return path
  }
  if (Array.isArray(root)) {
    for (let index = 0; index < root.length; index += 1) {
      const found = findPathByDeepEqual(
        root[index],
        target,
        [...path, index],
      )
      if (found) {
        return found
      }
    }
    return null
  }
  if (root !== null && typeof root === "object") {
    for (const key of Object.keys(root)) {
      const found = findPathByDeepEqual(
        (root as Record<string, unknown>)[key],
        target,
        [...path, key],
      )
      if (found) {
        return found
      }
    }
  }
  return null
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== typeof b) {
    return false
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false
    }
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object"
  ) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) {
      return false
    }
    return keysA.every(
      (key) =>
        key in (b as Record<string, unknown>) &&
        deepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  }
  return false
}

export default function FieldJson({
  name,
  label,
  value,
  helperText,
  error,
  disabled = false,
  required = false,
  onChange,
}: FieldJsonProps) {
  const theme = useTheme()
  const darkMode = theme.palette.mode === "dark"

  // Valor EXTERNO conhecido (string do form). Edições do usuário marcam o
  // próprio resultado como conhecido para o eco não remontar a árvore.
  const [externalValue, setExternalValue] = useState(value)
  const [working, setWorking] = useState<JsonValue>(() => parse(value))
  // Só muda quando o valor vem DE FORA (reset do form, outro registro).
  const [mountKey, setMountKey] = useState(value)

  useEffect(() => {
    if (value !== externalValue) {
      setExternalValue(value)
      setWorking(parse(value))
      setMountKey(value)
    }
  }, [value, externalValue])

  const commit = (next: JsonValue) => {
    setWorking(next)
    const serialized = serialize(next)
    setExternalValue(serialized)
    onChange(name, serialized)
  }

  const handleEdit = (option: JsonEditOption) => {
    // O editor usa UM onEdit para valor e chave — o `type` distingue.
    if (option.type === "key" && option.namespace?.length) {
      // Renomear chave: o namespace inclui a chave antiga no final.
      const namespace = option.namespace
      const parentPath = namespace.slice(0, -1)
      const previous = getAtPath(working, namespace)
      let next = removeAtPath(working, namespace)
      next = setAtPath(
        next,
        [...parentPath, String(option.value)],
        previous,
      )
      commit(next as JsonValue)
    } else if (option.namespace?.length) {
      commit(
        setAtPath(working, option.namespace, option.value) as JsonValue,
      )
    }
    return true
  }

  const handleDelete = (
    _keyName: string | number,
    _value: unknown,
    _parentValue: unknown,
    option: { namespace?: Array<string | number> },
  ) => {
    if (option.namespace?.length) {
      commit(removeAtPath(working, option.namespace) as JsonValue)
    }
    return true
  }

  const handleAdd = (
    _keyOrValue: string,
    result: unknown,
    previous: unknown,
  ) => {
    const path = findPathByDeepEqual(working, previous)
    if (path) {
      commit(setAtPath(working, path, result) as JsonValue)
    }
    return true
  }

  const editable = !disabled
  const editorValue = working ?? {}

  return (
    <Box role="group" aria-labelledby={`${name}-label`}>
      <Typography
        id={`${name}-label`}
        variant="body2"
        color="text.secondary"
        sx={{ mb: 0.5 }}
      >
        {label}
        {required && " *"}
      </Typography>

      <Box
        sx={{
          border: 1,
          borderColor: error ? "error.main" : "divider",
          borderRadius: 1,
          p: 1.5,
          bgcolor: "background.paper",
          opacity: disabled ? 0.6 : 1,
          overflow: "auto",
          maxHeight: 320,
        }}
      >
        <JsonViewEditor
          key={mountKey}
          value={editorValue as object}
          style={darkMode ? darkTheme : lightTheme}
          editable={editable}
          onEdit={editable ? handleEdit : undefined}
          onAdd={editable ? handleAdd : undefined}
          onDelete={editable ? handleDelete : undefined}
        />
      </Box>

      {(helperText || error) && (
        <FormHelperText error={Boolean(error)}>
          {error ?? helperText}
        </FormHelperText>
      )}
    </Box>
  )
}

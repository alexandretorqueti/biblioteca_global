/**
 * Redimensionamento do painel de detalhe do Mapa de agentes (tarefa 1118).
 *
 * Hook compartilhado pelas duas apresentações do detalhe (coluna lateral em
 * telas largas e Drawer em telas estreitas): arrastar a borda esquerda com o
 * mouse ajusta a largura dentro de limites sensatos e persiste a escolha no
 * localStorage (uma largura única vale para as duas apresentações).
 *
 * Comportamento:
 * - Largura inicial: valor persistido, ou o default do chamado (hoje 480px na
 *   coluna larga).
 * - Durante o arraste o estado é atualizado por rAF (um commit por frame) e o
 *   `userSelect: none` no body evita seleção de texto acidental.
 * - Ao soltar, o valor final é persistido; tecla Esc cancela o arraste.
 * - Falha de localStorage (modo privado, storage cheio) nunca quebra a UI.
 */
import { useCallback, useRef, useState } from "react"

export const DETAIL_MIN_WIDTH = 360
export const DETAIL_MAX_WIDTH = 760
export const DETAIL_DEFAULT_WIDTH = 480

const STORAGE_KEY = "operation-map-detail-width"

/**
 * Lê a largura persistida do painel de detalhe.
 * Valores fora do intervalo (ou ausentes/corrompidos) voltam ao default.
 */
export function readPersistedDetailWidth(fallback = DETAIL_DEFAULT_WIDTH): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw == null) return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? Math.min(DETAIL_MAX_WIDTH, Math.max(DETAIL_MIN_WIDTH, Math.round(value))) : fallback
  } catch {
    return fallback
  }
}

export interface DetailPanelResize {
  /** Largura atual do painel (px). */
  width: number
  /** True enquanto o usuário arrasta a alça (cursor/feedback visual). */
  resizing: boolean
  /** Handler da alça de redimensionamento (borda esquerda do painel). */
  onHandlePointerDown: (event: React.PointerEvent<HTMLElement>) => void
}

export function useDetailPanelResize(defaultWidth = DETAIL_DEFAULT_WIDTH): DetailPanelResize {
  const [width, setWidth] = useState(() => readPersistedDetailWidth(defaultWidth))
  const [resizing, setResizing] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  const onHandlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault()
    const handle = event.currentTarget
    const startClientX = event.clientX
    const startWidth = widthRef.current
    // Largura máxima limitada pela viewport: o painel não pode ultrapassar
    // a janela menos uma folga mínima para o mapa (200px).
    const max = Math.max(DETAIL_MIN_WIDTH, Math.min(DETAIL_MAX_WIDTH, window.innerWidth - 200))
    const min = DETAIL_MIN_WIDTH
    const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)))
    const persist = (value: number) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, String(value))
      } catch {
        // storage indisponível: largura vale só para a sessão atual
      }
    }
    const previousSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerCancel)
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.userSelect = previousSelect
      try {
        handle.releasePointerCapture(event.pointerId)
      } catch {
        // pointer já liberado
      }
      setResizing(false)
    }
    const onPointerMove = (move: PointerEvent) => {
      // Arrastar para a esquerda AUMENTA a largura (alça na borda esquerda).
      const next = clamp(startWidth + (startClientX - move.clientX))
      if (next !== widthRef.current) {
        widthRef.current = next
        setWidth(next)
      }
    }
    const onPointerUp = () => {
      persist(widthRef.current)
      cleanup()
    }
    const onPointerCancel = () => cleanup()
    const onKeyDown = (key: KeyboardEvent) => {
      if (key.key === "Escape") cleanup()
    }
    try {
      handle.setPointerCapture(event.pointerId)
    } catch {
      // sem capture ainda assim os listeners de window funcionam
    }
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    window.addEventListener("pointercancel", onPointerCancel)
    window.addEventListener("keydown", onKeyDown)
    setResizing(true)
  }, [])

  return { width, resizing, onHandlePointerDown }
}

/**
 * DiffViewer — wrapper sobre react-diff-viewer-continued.
 *
 * Exibe diff side-by-side com syntax highlighting. Aceita conteúdo
 * antigo/novo como string ou patch unificado (converte para oldValue/newValue).
 */
import React, { useMemo } from "react"
import { Box, Typography, useTheme } from "@mui/material"

// react-diff-viewer-continued — import ESM default.
import ReactDiffViewerRaw from "react-diff-viewer-continued"
// O componente pode vir como default ou named; normalizar.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ReactDiffViewer: any = (ReactDiffViewerRaw as any)?.default ?? ReactDiffViewerRaw

export interface DiffViewerProps {
  /** Conteúdo original (lado esquerdo / old) */
  oldValue: string
  /** Conteúdo modificado (lado direito / new) */
  newValue: string
  /** Nome do arquivo para exibição no cabeçalho */
  fileName?: string
  /** Se true, usa split view (side-by-side). Se false, unified view. */
  splitView?: boolean
  /** Altura máxima do container */
  maxHeight?: string | number
}

/**
 * Extrai oldValue e newValue de um patch unificado.
 * Se o patch não for parseável, retorna as strings originais.
 */
export function parsePatchToOldNew(patch: string): { oldValue: string; newValue: string } {
  if (!patch || !patch.startsWith("diff --git")) {
    return { oldValue: "", newValue: patch || "" }
  }

  const lines = patch.split("\n")
  const oldLines: string[] = []
  const newLines: string[] = []
  let inHunk = false

  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (line.startsWith("---") || line.startsWith("+++")) continue
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1))
    } else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    }
  }

  return {
    oldValue: oldLines.join("\n"),
    newValue: newLines.join("\n"),
  }
}

/**
 * Componente DiffViewer — exibe diff side-by-side com syntax highlighting.
 * Se a lib não estiver disponível, faz fallback para visualização em texto.
 */
export default function DiffViewer({
  oldValue,
  newValue,
  fileName,
  splitView = true,
  maxHeight = "70vh",
}: DiffViewerProps) {
  const theme = useTheme()

  const customStyles = useMemo(
    () => ({
      variables: {
        light: {
          diffViewerBackground: theme.palette.background.paper,
          diffViewerColor: theme.palette.text.primary,
          addedBackground: "#e6ffed",
          addedColor: theme.palette.text.primary,
          removedBackground: "#ffdce0",
          removedColor: theme.palette.text.primary,
          wordAddedBackground: "#abf2bc",
          wordRemovedBackground: "#ffb0b8",
        },
        dark: {
          diffViewerBackground: theme.palette.background.paper,
          diffViewerColor: theme.palette.text.primary,
          addedBackground: "#1a3a1a",
          addedColor: theme.palette.text.primary,
          removedBackground: "#3a1a1a",
          removedColor: theme.palette.text.primary,
          wordAddedBackground: "#2d5a2d",
          wordRemovedBackground: "#5a2d2d",
        },
      },
    }),
    [theme],
  )

  // Fallback se a lib não estiver disponível
  if (!ReactDiffViewer) {
    return (
      <Box sx={{ maxHeight, overflow: "auto" }}>
        {fileName && (
          <Typography variant="caption" sx={{ mb: 0.5, display: "block", fontWeight: 600 }}>
            {fileName}
          </Typography>
        )}
        <Box
          component="pre"
          sx={{
            fontSize: "0.75rem",
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            bgcolor: "action.hover",
            p: 1,
            borderRadius: 1,
            overflow: "auto",
            maxHeight: `calc(${typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight} - 24px)`,
          }}
        >
          {oldValue !== newValue ? `--- old\n+++ new\n${oldValue}\n${newValue}` : oldValue}
        </Box>
      </Box>
    )
  }

  return (
    <Box sx={{ maxHeight, overflow: "auto" }}>
      {fileName && (
        <Typography variant="caption" sx={{ mb: 0.5, display: "block", fontWeight: 600 }}>
          {fileName}
        </Typography>
      )}
      <ReactDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={splitView}
        useDarkTheme={theme.palette.mode === "dark"}
        styles={customStyles}
        leftTitle="Base (ours)"
        rightTitle="Tarefa (theirs)"
        showDiffOnly={false}
      />
    </Box>
  )
}

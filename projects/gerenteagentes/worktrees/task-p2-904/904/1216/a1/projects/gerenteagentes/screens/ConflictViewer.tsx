/**
 * ConflictViewer — exibe conflitos de merge com marcações ours/theirs.
 *
 * Recebe a lista de conflitos do endpoint merge-simulation e permite
 * navegar entre arquivos conflitantes, visualizando o conteúdo de cada lado.
 */
import React, { useState, useMemo } from "react"
import {
  Alert, Box, Chip, List, ListItemButton, ListItemText, Paper, Stack,
  Tab, Tabs, Typography,
} from "@mui/material"
import {
  WarningAmberRounded, CheckCircleRounded,
} from "@mui/icons-material"
import DiffViewer from "./DiffViewer"

export interface MergeConflict {
  path: string
  ours: string | null
  theirs: string | null
  base: string | null
}

export interface MergeSimulationResult {
  success: boolean
  conflicts: MergeConflict[]
  filesChanged: number
  baseBranch: string
  taskBranch: string
}

export interface ConflictViewerProps {
  result: MergeSimulationResult | null
  loading?: boolean
  error?: string | null
}

/**
 * ConflictViewer — exibe resultado da simulação de merge.
 * Se não há conflitos, mostra mensagem de sucesso.
 * Se há conflitos, permite navegar entre os arquivos e ver o diff ours/theirs.
 */
export default function ConflictViewer({ result, loading, error }: ConflictViewerProps) {
  const [selectedConflictIndex, setSelectedConflictIndex] = useState(0)
  const [viewTab, setViewTab] = useState(0) // 0 = diff ours/theirs, 1 = base

  const selectedConflict = useMemo(
    () => result?.conflicts[selectedConflictIndex] ?? null,
    [result, selectedConflictIndex],
  )

  if (loading) {
    return (
      <Box sx={{ p: 2, textAlign: "center" }}>
        <Typography color="text.secondary">Simulando merge…</Typography>
      </Box>
    )
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>
  }

  if (!result) {
    return (
      <Typography color="text.secondary">
        Clique em "Ver Conflitos" para simular o merge com a branch base.
      </Typography>
    )
  }

  // Merge sem conflitos
  if (result.success) {
    return (
      <Stack spacing={2} alignItems="center" sx={{ py: 4 }}>
        <CheckCircleRounded sx={{ fontSize: 48, color: "success.main" }} />
        <Typography variant="h6" color="success.main">
          Merge limpo — sem conflitos
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {result.filesChanged} arquivo(s) seriam alterados na integração com{" "}
          <code>{result.baseBranch}</code>.
        </Typography>
      </Stack>
    )
  }

  // Há conflitos
  return (
    <Stack spacing={1} sx={{ height: "100%" }}>
      <Alert severity="warning" icon={<WarningAmberRounded />}>
        <Typography variant="body2">
          <strong>{result.conflicts.length} conflito(s)</strong> detectado(s) ao tentar
          integrar <code>{result.taskBranch}</code> → <code>{result.baseBranch}</code>.
        </Typography>
      </Alert>

      <Stack direction="row" spacing={1} sx={{ minHeight: 0, flex: 1 }}>
        {/* Lista de arquivos conflitantes */}
        <Paper variant="outlined" sx={{ width: 260, overflow: "auto", flexShrink: 0 }}>
          <List dense disablePadding>
            {result.conflicts.map((conflict, index) => (
              <ListItemButton
                key={conflict.path}
                selected={index === selectedConflictIndex}
                onClick={() => setSelectedConflictIndex(index)}
              >
                <ListItemText
                  primary={conflict.path.split("/").pop() ?? conflict.path}
                  secondary={conflict.path}
                  secondaryTypographyProps={{
                    noWrap: true,
                    fontSize: "0.65rem",
                  }}
                  primaryTypographyProps={{ fontSize: "0.8rem" }}
                />
                <Chip
                  size="small"
                  label="conflict"
                  color="error"
                  variant="outlined"
                  sx={{ ml: 0.5, height: 18, fontSize: "0.6rem" }}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>

        {/* Painel de diff do conflito selecionado */}
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {selectedConflict ? (
            <>
              <Tabs
                value={viewTab}
                onChange={(_, v) => setViewTab(v)}
                sx={{ minHeight: 32, "& .MuiTab-root": { minHeight: 32, py: 0 } }}
              >
                <Tab label="Ours ↔ Theirs" />
                <Tab label="Base" />
              </Tabs>

              <Box sx={{ flex: 1, overflow: "auto", mt: 0.5 }}>
                {viewTab === 0 && (
                  <DiffViewer
                    oldValue={selectedConflict.ours ?? "(arquivo não existe)"}
                    newValue={selectedConflict.theirs ?? "(arquivo não existe)"}
                    fileName={selectedConflict.path}
                    splitView
                    maxHeight="50vh"
                  />
                )}
                {viewTab === 1 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
                      Conteúdo na base comum (merge-base):
                    </Typography>
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
                        maxHeight: "50vh",
                      }}
                    >
                      {selectedConflict.base ?? "(arquivo não existe na base)"}
                    </Box>
                  </Box>
                )}
              </Box>
            </>
          ) : (
            <Typography color="text.secondary" sx={{ p: 2 }}>
              Selecione um arquivo conflitante.
            </Typography>
          )}
        </Box>
      </Stack>
    </Stack>
  )
}

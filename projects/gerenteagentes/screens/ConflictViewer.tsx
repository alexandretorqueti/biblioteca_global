/**
 * ConflictViewer — exibe conflitos de merge com marcações ours/theirs.
 *
 * Recebe a lista de conflitos do endpoint merge-simulation e permite
 * navegar entre arquivos conflitantes, visualizando o conteúdo de cada lado.
 * Suporta também dados persistidos de promotion_conflict_analyses.
 */
import React, { useState, useMemo, useCallback } from "react"
import {
  Alert, Box, Button, Chip, List, ListItemButton, ListItemText, Paper, Stack,
  Tab, Tabs, Typography,
} from "@mui/material"
import {
  WarningAmberRounded, CheckCircleRounded, CheckCircleOutlineRounded,
} from "@mui/icons-material"
import DiffViewer from "./DiffViewer"

export interface MergeConflict {
  path: string
  ours: string | null
  theirs: string | null
  base: string | null
  /** Indica se é conflito real (ours ≠ theirs ≠ base) ou apenas modificação simultânea */
  isRealConflict?: boolean
}

export interface MergeSimulationResult {
  success: boolean
  conflicts: MergeConflict[]
  filesChanged: number
  baseBranch: string
  taskBranch: string
}

export interface PromotionConflictData {
  id: number
  status: string
  confidence: string | null
  recommendation: string | null
  report: string | null
  errorMessage: string | null
  baseBranch: string
  taskBranch: string
  baseCommit: string
  taskCommit: string
  mergeBaseCommit: string
  conflictFiles: string[]
  evidence: {
    conflictFiles?: Array<{
      path: string
      kind: string
      baseExcerpt: string
      taskExcerpt: string
      ancestorExcerpt: string
    }>
    resolutions?: Record<string, 'ours' | 'theirs' | 'both'>
    resolvedAt?: string
  } | null
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface ConflictViewerProps {
  result?: MergeSimulationResult | null
  persistedData?: PromotionConflictData | null
  loading?: boolean
  error?: string | null
  onResolveConflict?: (path: string, decision: 'ours' | 'theirs' | 'both') => Promise<void>
}

/**
 * ConflictViewer — exibe resultado da simulação de merge ou dados persistidos.
 * Se não há conflitos, mostra mensagem de sucesso.
 * Se há conflitos, permite navegar entre os arquivos, ver o diff ours/theirs,
 * e resolver conflitos com botões "Aceitar Ours", "Aceitar Theirs", "Aceitar Both".
 */
export default function ConflictViewer({ result, persistedData, loading, error, onResolveConflict }: ConflictViewerProps) {
  const [selectedConflictIndex, setSelectedConflictIndex] = useState(0)
  const [viewTab, setViewTab] = useState(0) // 0 = diff ours/theirs, 1 = base
  const [resolvingPath, setResolvingPath] = useState<string | null>(null)

  // Converter persistedData para formato de conflitos se disponível
  const conflicts: MergeConflict[] = useMemo(() => {
    if (persistedData?.evidence?.conflictFiles) {
      return persistedData.evidence.conflictFiles.map((file) => ({
        path: file.path,
        ours: file.taskExcerpt,
        theirs: file.baseExcerpt,
        base: file.ancestorExcerpt,
        isRealConflict: file.kind === 'mechanical' || file.kind === 'semantic',
      }))
    }
    return result?.conflicts ?? []
  }, [persistedData, result])

  const selectedConflict = useMemo(
    () => conflicts[selectedConflictIndex] ?? null,
    [conflicts, selectedConflictIndex],
  )

  const resolutions = persistedData?.evidence?.resolutions ?? {}

  const handleResolve = useCallback(async (path: string, decision: 'ours' | 'theirs' | 'both') => {
    if (!onResolveConflict) return
    setResolvingPath(path)
    try {
      await onResolveConflict(path, decision)
    } finally {
      setResolvingPath(null)
    }
  }, [onResolveConflict])

  if (loading) {
    return (
      <Box sx={{ p: 2, textAlign: "center" }}>
        <Typography color="text.secondary">Carregando conflitos…</Typography>
      </Box>
    )
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>
  }

  if (!result && !persistedData) {
    return (
      <Typography color="text.secondary">
        Clique em "Ver Conflitos" para simular o merge com a branch base.
      </Typography>
    )
  }

  const baseBranch = persistedData?.baseBranch ?? result?.baseBranch ?? ''
  const taskBranch = persistedData?.taskBranch ?? result?.taskBranch ?? ''

  // Merge sem conflitos
  if (conflicts.length === 0) {
    return (
      <Stack spacing={2} alignItems="center" sx={{ py: 4 }}>
        <CheckCircleRounded sx={{ fontSize: 48, color: "success.main" }} />
        <Typography variant="h6" color="success.main">
          Merge limpo — sem conflitos
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {persistedData?.conflictFiles.length ?? result?.filesChanged ?? 0} arquivo(s) seriam alterados na integração com{" "}
          <code>{baseBranch}</code>.
        </Typography>
      </Stack>
    )
  }

  // Há conflitos
  const resolvedCount = Object.keys(resolutions).length
  const totalCount = conflicts.length

  return (
    <Stack spacing={1} sx={{ height: "100%" }}>
      <Alert severity="warning" icon={<WarningAmberRounded />}>
        <Typography variant="body2">
          <strong>{totalCount} conflito(s)</strong> detectado(s) ao tentar
          integrar <code>{taskBranch}</code> → <code>{baseBranch}</code>.
          {resolvedCount > 0 && (
            <Chip
              size="small"
              label={`${resolvedCount}/${totalCount} resolvidos`}
              color="success"
              sx={{ ml: 1, height: 20 }}
            />
          )}
        </Typography>
      </Alert>

      <Stack direction="row" spacing={1} sx={{ minHeight: 0, flex: 1 }}>
        {/* Lista de arquivos conflitantes */}
        <Paper variant="outlined" sx={{ width: 260, overflow: "auto", flexShrink: 0 }}>
          <List dense disablePadding>
            {conflicts.map((conflict, index) => {
              const isResolved = resolutions[conflict.path] != null
              return (
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
                  {isResolved ? (
                    <CheckCircleOutlineRounded
                      fontSize="small"
                      color="success"
                      sx={{ ml: 0.5 }}
                    />
                  ) : (
                    <Chip
                      size="small"
                      label={conflict.isRealConflict === false ? "modificado" : "conflict"}
                      color={conflict.isRealConflict === false ? "warning" : "error"}
                      variant="outlined"
                      sx={{ ml: 0.5, height: 18, fontSize: "0.6rem" }}
                    />
                  )}
                </ListItemButton>
              )
            })}
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
                  <>
                    <DiffViewer
                      oldValue={selectedConflict.ours ?? "(arquivo não existe)"}
                      newValue={selectedConflict.theirs ?? "(arquivo não existe)"}
                      fileName={selectedConflict.path}
                      splitView
                      maxHeight="40vh"
                    />
                    {/* Botões de resolução */}
                    {onResolveConflict && (
                      <Stack direction="row" spacing={1} sx={{ mt: 1, px: 1 }}>
                        <Button
                          size="small"
                          variant={resolutions[selectedConflict.path] === 'ours' ? 'contained' : 'outlined'}
                          color="primary"
                          disabled={resolvingPath === selectedConflict.path}
                          onClick={() => handleResolve(selectedConflict.path, 'ours')}
                        >
                          Aceitar Ours
                        </Button>
                        <Button
                          size="small"
                          variant={resolutions[selectedConflict.path] === 'theirs' ? 'contained' : 'outlined'}
                          color="secondary"
                          disabled={resolvingPath === selectedConflict.path}
                          onClick={() => handleResolve(selectedConflict.path, 'theirs')}
                        >
                          Aceitar Theirs
                        </Button>
                        <Button
                          size="small"
                          variant={resolutions[selectedConflict.path] === 'both' ? 'contained' : 'outlined'}
                          color="success"
                          disabled={resolvingPath === selectedConflict.path}
                          onClick={() => handleResolve(selectedConflict.path, 'both')}
                        >
                          Aceitar Both
                        </Button>
                        {resolvingPath === selectedConflict.path && (
                          <Typography variant="caption" color="text.secondary" sx={{ ml: 1, alignSelf: 'center' }}>
                            Salvando…
                          </Typography>
                        )}
                      </Stack>
                    )}
                  </>
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

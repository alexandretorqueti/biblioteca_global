/**
 * TaskCodeViewer — modal fullscreen (dentro do espaço livre) para inspeção
 * de código da tarefa: árvore de arquivos, commits, diff e conflitos de merge.
 *
 * Layout:
 * - Painel esquerdo: árvore de arquivos (TreeView) + lista de commits
 * - Painel direito: visualizador de diff/conteúdo
 * - Botão "Ver Conflitos" dispara merge simulation
 *
 * Endpoints usados:
 * - GET  /gerenteagentes/tarefas/:id/git/tree
 * - GET  /gerenteagentes/tarefas/:id/git/commits
 * - GET  /gerenteagentes/tarefas/:id/git/file?ref=...&path=...
 * - GET  /gerenteagentes/tarefas/:id/git/diff?from=...&to=...
 * - POST /gerenteagentes/tarefas/:id/git/merge-simulation
 */
import React, { useCallback, useEffect, useMemo, useState } from "react"
import {
  Alert, Box, Button, Chip, CircularProgress, Divider, IconButton,
  Paper, Stack, Tab, Tabs, Tooltip, Typography,
} from "@mui/material"
import {
  CloseRounded, CodeRounded, CommitRounded, FolderRounded,
  InsertDriveFileRounded, MergeTypeRounded, RefreshRounded,
} from "@mui/icons-material"
import { SimpleTreeView, TreeItem } from "@mui/x-tree-view"
import { useApi } from "../../../apps/web/src/hooks/useApi"
import DiffViewer from "./DiffViewer"
import ConflictViewer, { type MergeSimulationResult } from "./ConflictViewer"

// ─── Tipos ──────────────────────────────────────────────────────────────────

interface GitTreeEntry {
  path: string
  type: "blob" | "tree"
  size?: number
  mode: string
}

interface GitCommit {
  hash: string
  shortHash: string
  author: string
  authorEmail: string
  date: string
  message: string
}

interface GitDiffFile {
  path: string
  status: "added" | "modified" | "deleted" | "renamed" | "copied"
  patch: string
  oldPath?: string
  additions: number
  deletions: number
}

export interface TaskCodeViewerProps {
  taskId: number
  taskTitle: string
  /** Se a tarefa tem branch de integração (condição para mostrar o botão) */
  hasIntegrationBranch: boolean
  open: boolean
  onClose: () => void
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Converte lista plana de paths em estrutura de árvore para o TreeView.
 */
interface TreeNode {
  id: string
  label: string
  type: "blob" | "tree"
  fullPath: string
  children: Map<string, TreeNode>
}

function buildFileTree(entries: GitTreeEntry[]): TreeNode {
  const root: TreeNode = {
    id: "root",
    label: "root",
    type: "tree",
    fullPath: "",
    children: new Map(),
  }

  for (const entry of entries) {
    const parts = entry.path.split("/")
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isFile = i === parts.length - 1 && entry.type === "blob"
      const nodeId = parts.slice(0, i + 1).join("/")

      if (!current.children.has(part)) {
        current.children.set(part, {
          id: nodeId,
          label: part,
          type: isFile ? "blob" : "tree",
          fullPath: nodeId,
          children: new Map(),
        })
      }

      const child = current.children.get(part)!
      if (!isFile) {
        current = child
      }
    }
  }

  return root
}

/**
 * Renderiza recursivamente os nós da árvore como TreeItems.
 */
function renderTreeNodes(node: TreeNode): React.ReactNode {
  const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
    // Pastas primeiro, depois arquivos
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1
    return a.label.localeCompare(b.label)
  })

  return sortedChildren.map((child) => {
    const hasChildren = child.children.size > 0
    const icon = child.type === "tree"
      ? <FolderRounded fontSize="small" sx={{ color: "warning.main" }} />
      : <InsertDriveFileRounded fontSize="small" sx={{ color: "text.secondary" }} />

    if (hasChildren) {
      return (
        <TreeItem
          key={child.id}
          itemId={child.id}
          label={child.label}
          icon={icon}
        >
          {renderTreeNodes(child)}
        </TreeItem>
      )
    }

    return (
      <TreeItem
        key={child.id}
        itemId={child.id}
        label={child.label}
        icon={icon}
      />
    )
  })
}

function fileStatusColor(status: string): "success" | "error" | "warning" | "default" {
  switch (status) {
    case "added": return "success"
    case "deleted": return "error"
    case "modified": return "warning"
    default: return "default"
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  } catch {
    return iso
  }
}

// ─── Componente principal ───────────────────────────────────────────────────

export default function TaskCodeViewer({
  taskId,
  taskTitle,
  hasIntegrationBranch,
  open,
  onClose,
}: TaskCodeViewerProps) {
  const bundle = useApi()

  // Estado dos dados
  const [treeEntries, setTreeEntries] = useState<GitTreeEntry[]>([])
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  const [commitsLoading, setCommitsLoading] = useState(false)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [commitsError, setCommitsError] = useState<string | null>(null)

  // Estado da seleção
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<GitCommit | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [diffFiles, setDiffFiles] = useState<GitDiffFile[]>([])
  const [diffLoading, setDiffLoading] = useState(false)
  const [selectedDiffFile, setSelectedDiffFile] = useState<GitDiffFile | null>(null)

  // Estado do merge simulation
  const [mergeResult, setMergeResult] = useState<MergeSimulationResult | null>(null)
  const [mergeLoading, setMergeLoading] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  // Tab do painel direito
  const [rightTab, setRightTab] = useState(0) // 0=file, 1=commit diff, 2=conflicts

  // Integration branch name (convenção)
  const integrationBranch = useMemo(() => `motor-v3-work/integration-task-${taskId}`, [taskId])
  const baseBranch = "base-desenvolvimento"

  // ─── Loaders ────────────────────────────────────────────────────────────

  const loadTree = useCallback(async () => {
    if (!bundle) return
    setTreeLoading(true)
    setTreeError(null)
    try {
      const result = await bundle.http.request<{ tree: GitTreeEntry[] }>(
        "GET",
        `/gerenteagentes/tarefas/${taskId}/git/tree`,
        { auth: "access" },
      )
      setTreeEntries(result.tree ?? [])
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "Erro ao carregar árvore de arquivos")
    } finally {
      setTreeLoading(false)
    }
  }, [bundle, taskId])

  const loadCommits = useCallback(async () => {
    if (!bundle) return
    setCommitsLoading(true)
    setCommitsError(null)
    try {
      const result = await bundle.http.request<{ commits: GitCommit[] }>(
        "GET",
        `/gerenteagentes/tarefas/${taskId}/git/commits`,
        { auth: "access" },
      )
      setCommits(result.commits ?? [])
    } catch (e) {
      setCommitsError(e instanceof Error ? e.message : "Erro ao carregar commits")
    } finally {
      setCommitsLoading(false)
    }
  }, [bundle, taskId])

  const loadFileContent = useCallback(async (filePath: string, ref?: string) => {
    if (!bundle) return
    setFileLoading(true)
    try {
      const targetRef = ref || integrationBranch
      const result = await bundle.http.request<{ content: string }>(
        "GET",
        `/gerenteagentes/tarefas/${taskId}/git/file`,
        { query: { ref: targetRef, path: filePath }, auth: "access" },
      )
      setFileContent(result.content ?? "")
    } catch (e) {
      setFileContent(`Erro ao carregar arquivo: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setFileLoading(false)
    }
  }, [bundle, taskId, integrationBranch])

  const loadCommitDiff = useCallback(async (commit: GitCommit) => {
    if (!bundle) return
    setDiffLoading(true)
    setSelectedDiffFile(null)
    try {
      // Diff entre o commit pai e o commit atual
      const from = `${commit.hash}~1`
      const to = commit.hash
      const result = await bundle.http.request<{ files: GitDiffFile[] }>(
        "GET",
        `/gerenteagentes/tarefas/${taskId}/git/diff`,
        { query: { from, to }, auth: "access" },
      )
      setDiffFiles(result.files ?? [])
      if (result.files?.length) {
        setSelectedDiffFile(result.files[0]!)
      }
    } catch (e) {
      // Commit inicial não tem pai — tentar diff contra base
      try {
        const result = await bundle.http.request<{ files: GitDiffFile[] }>(
          "GET",
          `/gerenteagentes/tarefas/${taskId}/git/diff`,
          { query: { from: baseBranch, to: commit.hash }, auth: "access" },
        )
        setDiffFiles(result.files ?? [])
        if (result.files?.length) {
          setSelectedDiffFile(result.files[0]!)
        }
      } catch {
        setDiffFiles([])
      }
    } finally {
      setDiffLoading(false)
    }
  }, [bundle, taskId, baseBranch])

  const loadMergeSimulation = useCallback(async () => {
    if (!bundle) return
    setMergeLoading(true)
    setMergeError(null)
    try {
      const result = await bundle.http.request<MergeSimulationResult>(
        "POST",
        `/gerenteagentes/tarefas/${taskId}/git/merge-simulation`,
        { auth: "access" },
      )
      setMergeResult(result)
      setRightTab(2)
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : "Erro ao simular merge")
    } finally {
      setMergeLoading(false)
    }
  }, [bundle, taskId])

  // ─── Effects ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (open && hasIntegrationBranch) {
      void loadTree()
      void loadCommits()
    }
  }, [open, hasIntegrationBranch, loadTree, loadCommits])

  // Quando seleciona arquivo na árvore
  const handleFileSelect = useCallback((fileId: string) => {
    // Encontrar o path completo do arquivo
    const findFullPath = (node: TreeNode, targetId: string): string | null => {
      if (node.id === targetId && node.type === "blob") return node.fullPath
      for (const child of node.children.values()) {
        const found = findFullPath(child, targetId)
        if (found) return found
      }
      return null
    }

    const tree = buildFileTree(treeEntries)
    const fullPath = findFullPath(tree, fileId)

    if (fullPath) {
      setSelectedFile(fullPath)
      setSelectedCommit(null)
      setRightTab(0)
      void loadFileContent(fullPath)
    }
  }, [treeEntries, loadFileContent])

  // Quando seleciona commit
  const handleCommitSelect = useCallback((commit: GitCommit) => {
    setSelectedCommit(commit)
    setSelectedFile(null)
    setRightTab(1)
    void loadCommitDiff(commit)
  }, [loadCommitDiff])

  // ─── Árvore de arquivos ────────────────────────────────────────────────

  const fileTree = useMemo(() => buildFileTree(treeEntries), [treeEntries])

  // ─── Render ─────────────────────────────────────────────────────────────

  if (!open) return null

  return (
    <Box
      sx={{
        position: "absolute",
        inset: 0,
        zIndex: 10,
        bgcolor: "background.default",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: 2,
          py: 1,
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <CodeRounded color="primary" />
          <Typography variant="h6" noWrap>
            {taskTitle}
          </Typography>
          <Chip
            size="small"
            label={integrationBranch}
            variant="outlined"
            sx={{ fontSize: "0.65rem", height: 20 }}
          />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <Tooltip title="Recarregar">
            <IconButton size="small" onClick={() => { void loadTree(); void loadCommits() }}>
              <RefreshRounded />
            </IconButton>
          </Tooltip>
          <Tooltip title="Fechar">
            <IconButton size="small" onClick={onClose}>
              <CloseRounded />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/* Conteúdo principal */}
      <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
        {/* ─── Painel esquerdo ─────────────────────────────────────────── */}
        <Paper
          variant="outlined"
          sx={{
            width: 320,
            minWidth: 240,
            maxWidth: 480,
            display: "flex",
            flexDirection: "column",
            borderRight: 1,
            borderColor: "divider",
            borderRadius: 0,
            overflow: "hidden",
          }}
        >
          {/* Seção: Arquivos */}
          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <Stack direction="row" alignItems="center" sx={{ px: 1.5, py: 0.5, bgcolor: "action.hover" }}>
              <FolderRounded fontSize="small" sx={{ mr: 0.5 }} />
              <Typography variant="subtitle2">Arquivos</Typography>
            </Stack>
            <Box sx={{ flex: 1, overflow: "auto", px: 0.5 }}>
              {treeLoading && (
                <Box sx={{ p: 2, textAlign: "center" }}>
                  <CircularProgress size={20} />
                </Box>
              )}
              {treeError && <Alert severity="error" sx={{ m: 1 }}>{treeError}</Alert>}
              {!treeLoading && !treeError && treeEntries.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                  Nenhum arquivo encontrado.
                </Typography>
              )}
              {!treeLoading && treeEntries.length > 0 && (
                <SimpleTreeView
                  sx={{ minHeight: "auto" }}
                  onSelectedItemsChange={(_, itemId) => {
                    if (itemId && typeof itemId === "string") {
                      handleFileSelect(itemId)
                    }
                  }}
                >
                  {renderTreeNodes(fileTree)}
                </SimpleTreeView>
              )}
            </Box>
          </Box>

          <Divider />

          {/* Seção: Commits */}
          <Box sx={{ height: "40%", minHeight: 160, display: "flex", flexDirection: "column" }}>
            <Stack direction="row" alignItems="center" sx={{ px: 1.5, py: 0.5, bgcolor: "action.hover" }}>
              <CommitRounded fontSize="small" sx={{ mr: 0.5 }} />
              <Typography variant="subtitle2">Commits</Typography>
              {commits.length > 0 && (
                <Chip size="small" label={commits.length} sx={{ ml: "auto", height: 18, fontSize: "0.65rem" }} />
              )}
            </Stack>
            <Box sx={{ flex: 1, overflow: "auto" }}>
              {commitsLoading && (
                <Box sx={{ p: 2, textAlign: "center" }}>
                  <CircularProgress size={20} />
                </Box>
              )}
              {commitsError && <Alert severity="error" sx={{ m: 1 }}>{commitsError}</Alert>}
              {!commitsLoading && commits.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>
                  Nenhum commit encontrado.
                </Typography>
              )}
              {commits.map((commit) => (
                <Box
                  key={commit.hash}
                  onClick={() => handleCommitSelect(commit)}
                  sx={{
                    px: 1.5,
                    py: 0.75,
                    cursor: "pointer",
                    bgcolor: selectedCommit?.hash === commit.hash ? "action.selected" : "transparent",
                    borderLeft: selectedCommit?.hash === commit.hash ? 3 : 0,
                    borderColor: "primary.main",
                    "&:hover": { bgcolor: "action.hover" },
                  }}
                >
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography variant="caption" sx={{ fontFamily: "monospace", fontWeight: 600 }}>
                      {commit.shortHash}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ ml: "auto", fontSize: "0.6rem" }}>
                      {formatDate(commit.date)}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" noWrap sx={{ fontSize: "0.75rem" }}>
                    {commit.message}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {commit.author}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>

          <Divider />

          {/* Botão Ver Conflitos */}
          <Box sx={{ p: 1 }}>
            <Button
              fullWidth
              variant={rightTab === 2 ? "contained" : "outlined"}
              color={mergeResult?.success ? "success" : mergeResult?.conflicts.length ? "warning" : "primary"}
              startIcon={mergeLoading ? <CircularProgress size={16} /> : <MergeTypeRounded />}
              onClick={() => void loadMergeSimulation()}
              disabled={mergeLoading}
              size="small"
            >
              Ver Conflitos
            </Button>
          </Box>
        </Paper>

        {/* ─── Painel direito ──────────────────────────────────────────── */}
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Tabs do painel direito */}
          <Tabs
            value={rightTab}
            onChange={(_, v) => setRightTab(v)}
            sx={{ minHeight: 36, borderBottom: 1, borderColor: "divider", "& .MuiTab-root": { minHeight: 36, py: 0 } }}
          >
            <Tab label="Arquivo" icon={<InsertDriveFileRounded fontSize="small" />} iconPosition="start" />
            <Tab label="Diff Commit" icon={<CommitRounded fontSize="small" />} iconPosition="start" />
            <Tab
              label="Conflitos"
              icon={<MergeTypeRounded fontSize="small" />}
              iconPosition="start"
              color={mergeResult && !mergeResult.success ? "warning" : undefined}
            />
          </Tabs>

          {/* Conteúdo do painel direito */}
          <Box sx={{ flex: 1, overflow: "auto", p: 1 }}>
            {/* Tab: Arquivo */}
            {rightTab === 0 && (
              <>
                {fileLoading && (
                  <Box sx={{ p: 2, textAlign: "center" }}>
                    <CircularProgress size={24} />
                  </Box>
                )}
                {!fileLoading && !selectedFile && (
                  <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", color: "text.secondary" }}>
                    <InsertDriveFileRounded sx={{ fontSize: 48, mb: 1, opacity: 0.3 }} />
                    <Typography>Selecione um arquivo na árvore à esquerda</Typography>
                  </Stack>
                )}
                {!fileLoading && selectedFile && (
                  <>
                    <Typography variant="caption" sx={{ mb: 0.5, display: "block", fontWeight: 600 }}>
                      {selectedFile}
                    </Typography>
                    <Box
                      component="pre"
                      sx={{
                        fontSize: "0.75rem",
                        fontFamily: "monospace",
                        whiteSpace: "pre-wrap",
                        bgcolor: "action.hover",
                        p: 1.5,
                        borderRadius: 1,
                        overflow: "auto",
                        maxHeight: "calc(100vh - 200px)",
                        lineHeight: 1.5,
                      }}
                    >
                      {fileContent ?? ""}
                    </Box>
                  </>
                )}
              </>
            )}

            {/* Tab: Diff do Commit */}
            {rightTab === 1 && (
              <>
                {diffLoading && (
                  <Box sx={{ p: 2, textAlign: "center" }}>
                    <CircularProgress size={24} />
                  </Box>
                )}
                {!diffLoading && !selectedCommit && (
                  <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", color: "text.secondary" }}>
                    <CommitRounded sx={{ fontSize: 48, mb: 1, opacity: 0.3 }} />
                    <Typography>Selecione um commit na lista à esquerda</Typography>
                  </Stack>
                )}
                {!diffLoading && selectedCommit && diffFiles.length > 0 && (
                  <Stack spacing={1} sx={{ height: "100%" }}>
                    {/* Lista de arquivos do diff */}
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {diffFiles.map((file) => (
                        <Chip
                          key={file.path}
                          size="small"
                          label={`${file.path} (+${file.additions}/-${file.deletions})`}
                          color={fileStatusColor(file.status)}
                          variant={selectedDiffFile?.path === file.path ? "filled" : "outlined"}
                          onClick={() => setSelectedDiffFile(file)}
                          sx={{ cursor: "pointer", fontSize: "0.65rem", height: 22 }}
                        />
                      ))}
                    </Stack>

                    {/* Diff do arquivo selecionado */}
                    {selectedDiffFile && (
                      <DiffViewer
                        oldValue={""}
                        newValue={selectedDiffFile.patch}
                        fileName={selectedDiffFile.path}
                        splitView
                        maxHeight="calc(100vh - 260px)"
                      />
                    )}
                  </Stack>
                )}
                {!diffLoading && selectedCommit && diffFiles.length === 0 && (
                  <Typography color="text.secondary" sx={{ p: 2 }}>
                    Nenhum arquivo alterado neste commit.
                  </Typography>
                )}
              </>
            )}

            {/* Tab: Conflitos */}
            {rightTab === 2 && (
              <ConflictViewer
                result={mergeResult}
                loading={mergeLoading}
                error={mergeError}
              />
            )}
          </Box>
        </Box>
      </Stack>
    </Box>
  )
}

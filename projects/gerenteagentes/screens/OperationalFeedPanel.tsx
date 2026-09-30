import React, { useMemo, useState } from "react"
import {
  Badge, Box, Chip, Collapse, Divider, FormControl, IconButton, InputLabel, MenuItem,
  Paper, Select, Stack, Typography,
} from "@mui/material"
import { ExpandLessRounded, ExpandMoreRounded, RadioButtonCheckedRounded } from "@mui/icons-material"
import type { OperationalFeedItem, OperationalFeedMessage, OperationalPendingAction } from "../api/operational-feed"

export type FeedConnection = "connecting" | "open" | "closed"
export type FeedCategory = "all" | "message" | "event" | "pending_action"

interface OperationalFeedPanelProps {
  items: OperationalFeedItem[]
  connection: FeedConnection
  recovered: boolean
  onSelectTask: (taskId: number) => void
}

const stateLabel: Record<string, string> = {
  sent: "enviada", received: "recebida", pending: "pendente", deferred: "adiada",
  delivered: "entregue", consumed: "consumida", failed: "falhou", running: "em execução",
  blocked: "bloqueada", completed: "concluída", cancelled: "cancelada",
}
const categoryLabel: Record<FeedCategory, string> = { all: "Tudo", message: "Mensagens", event: "Atividades", pending_action: "Pendências" }
const dateLabel = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "horário indisponível" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
}
const statusColor = (state: string): "default" | "success" | "warning" | "error" | "info" => {
  if (["failed", "blocked"].includes(state)) return "error"
  if (["pending", "deferred", "running"].includes(state)) return "warning"
  if (["delivered", "consumed", "completed"].includes(state)) return "success"
  return "default"
}
const itemState = (item: OperationalFeedItem) => item.type === "message" ? item.state : item.type === "pending_action" ? item.state : "activity"
const itemDescription = (item: OperationalFeedItem) => {
  if (item.type === "message") return item.text
  if (item.type === "pending_action") return item.reason || `Ação ${item.actionType} aguardando processamento`
  return item.reason || `Atividade: ${item.event}`
}

function FeedItem({ item, onSelectTask }: { item: OperationalFeedItem; onSelectTask: (taskId: number) => void }) {
  const state = itemState(item)
  const eventLabel = item.type === "message" ? `Mensagem ${stateLabel[item.state] ?? item.state}` : item.type === "pending_action" ? item.actionType : item.event
  const title = item.taskTitle?.trim() || eventLabel
  return <Paper component="button" type="button" variant="outlined" onClick={() => onSelectTask(item.taskId)} data-testid={`operational-feed-item-${item.id}`} sx={{ textAlign: "left", display: "block", width: "100%", p: 1, borderRadius: 1.5, cursor: "pointer", bgcolor: item.type === "pending_action" ? "warning.50" : "background.paper", "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" } }}>
    <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ minWidth: 0 }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" fontWeight={700} noWrap>{title}</Typography>
          <Chip size="small" label={stateLabel[state] ?? state} color={statusColor(state)} sx={{ height: 20 }} />
        </Stack>
        <Typography variant="caption" color="text.secondary" noWrap display="block">{eventLabel} · Tarefa #{item.taskId} · {item.agentId || "Motor"}</Typography>
        <Typography variant="body2" sx={{ mt: .25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{itemDescription(item)}</Typography>
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>{dateLabel(item.occurredAt)}</Typography>
    </Stack>
  </Paper>
}

export default function OperationalFeedPanel({ items, connection, recovered, onSelectTask }: OperationalFeedPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [category, setCategory] = useState<FeedCategory>("all")
  const [state, setState] = useState("all")
  const pending = useMemo(() => items.filter(item => item.type === "pending_action" && ["pending", "running", "blocked"].includes(item.state)).sort((a, b) => (b as OperationalPendingAction).priority - (a as OperationalPendingAction).priority), [items])
  const visiblePending = useMemo(() => pending.filter(item => state === "all" || itemState(item) === state), [pending, state])
  const states = useMemo(() => [...new Set(items.map(itemState))].sort(), [items])
  const visible = useMemo(() => items.filter(item => (category === "all" || item.type === category) && (state === "all" || itemState(item) === state)).slice(0, 40), [category, items, state])
  const connectionLabel = connection === "open" ? "Conectado" : connection === "connecting" ? "Reconectando…" : "Atualização indisponível"
  const connectionColor = connection === "open" ? "success.main" : "warning.main"
  return <Paper data-testid="operational-feed-panel" variant="outlined" sx={{ overflow: "hidden" }}>
    <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1, minHeight: 52 }}>
      <Badge badgeContent={pending.length} color={pending.length ? "warning" : "default"} max={99}><Typography variant="subtitle1" fontWeight={750} sx={{ pr: 1 }}>Quadro operacional</Typography></Badge>
      <Typography variant="caption" color={connectionColor} sx={{ ml: "auto", display: "flex", alignItems: "center", gap: .35 }}><RadioButtonCheckedRounded sx={{ fontSize: 12 }} />{connectionLabel}</Typography>
      {recovered && <Chip size="small" variant="outlined" color="info" label="Dados recuperados" />}
      <IconButton size="small" aria-label={collapsed ? "Expandir quadro operacional" : "Recolher quadro operacional"} onClick={() => setCollapsed(value => !value)}>{collapsed ? <ExpandMoreRounded /> : <ExpandLessRounded />}</IconButton>
    </Stack>
    <Collapse in={!collapsed}>
      <Divider />
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ px: 1.5, py: 1 }}>
        <FormControl size="small" sx={{ minWidth: 145 }}><InputLabel id="feed-category-label">Categoria</InputLabel><Select labelId="feed-category-label" label="Categoria" value={category} onChange={event => setCategory(event.target.value as FeedCategory)} data-testid="operational-feed-category">{Object.entries(categoryLabel).map(([value, label]) => <MenuItem key={value} value={value}>{label} ({value === "all" ? items.length : items.filter(item => item.type === value).length})</MenuItem>)}</Select></FormControl>
        <FormControl size="small" sx={{ minWidth: 145 }}><InputLabel id="feed-state-label">Estado</InputLabel><Select labelId="feed-state-label" label="Estado" value={state} onChange={event => setState(event.target.value)} data-testid="operational-feed-state"><MenuItem value="all">Todos os estados ({items.length})</MenuItem>{states.map(value => <MenuItem key={value} value={value}>{stateLabel[value] ?? value} ({items.filter(item => itemState(item) === value).length})</MenuItem>)}</Select></FormControl>
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: "center" }}>{items.filter(item => item.type === "message").length} mensagens · {items.filter(item => item.type === "event").length} atividades · {pending.length} pendências</Typography>
      </Stack>
      <Stack direction={{ xs: "column", lg: "row" }} spacing={1.5} sx={{ px: 1.5, pb: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="overline" color="text.secondary">Linha do tempo</Typography><Stack spacing={.75} sx={{ maxHeight: 250, overflow: "auto", pr: .25 }}>{visible.filter(item => item.type !== "pending_action").map(item => <FeedItem key={item.id} item={item} onSelectTask={onSelectTask} />)}{!visible.some(item => item.type !== "pending_action") && <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>Nenhuma mensagem ou atividade para estes filtros.</Typography>}</Stack></Box>
        <Box sx={{ width: { xs: "100%", lg: "38%" }, minWidth: 0, borderLeft: { lg: "1px solid" }, borderColor: "divider", pl: { lg: 1.5 } }}><Typography variant="overline" color="warning.main">Ações pendentes</Typography><Stack spacing={.75} sx={{ maxHeight: 250, overflow: "auto", pr: .25 }}>{(category === "all" || category === "pending_action" ? visiblePending : []).map(item => <FeedItem key={item.id} item={item} onSelectTask={onSelectTask} />)}{!visiblePending.length && <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>Nenhuma ação pendente.</Typography>}</Stack></Box>
      </Stack>
    </Collapse>
  </Paper>
}

export type { OperationalFeedMessage }

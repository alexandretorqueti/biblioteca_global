import { DragEvent, useRef, useState } from "react"
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Stack,
  Typography,
} from "@mui/material"
import {
  DeleteRounded,
  ImageRounded,
  UploadFileRounded,
} from "@mui/icons-material"

interface FieldPhotoProps {
  name: string
  label: string
  value: string
  required?: boolean
  helperText?: string
  disabled?: boolean
  accept?: string
  maxFileSizeMb?: number
  onChange: (name: string, value: string) => void
}

export default function FieldPhoto({
  name,
  label,
  value,
  required = false,
  helperText,
  disabled = false,
  accept = "image/*",
  maxFileSizeMb = 5,
  onChange,
}: FieldPhotoProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState("")

  const processFile = (file?: File) => {
    if (!file) {
      return
    }

    setError("")

    if (!file.type.startsWith("image/")) {
      setError("Selecione um arquivo de imagem válido.")
      return
    }

    if (file.size > maxFileSizeMb * 1024 * 1024) {
      setError(`A imagem deve ter no máximo ${maxFileSizeMb} MB.`)
      return
    }

    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === "string") {
        onChange(name, reader.result)
      }
    }

    reader.onerror = () => {
      setError("Não foi possível carregar a imagem.")
    }

    reader.readAsDataURL(file)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)

    if (!disabled) {
      processFile(event.dataTransfer.files[0])
    }
  }

  return (
    <Stack spacing={1.25}>
      <Typography fontWeight={700}>
        {label}
        {required ? " *" : ""}
      </Typography>

      <Paper
        variant="outlined"
        onDragEnter={(event) => {
          event.preventDefault()
          if (!disabled) {
            setDragging(true)
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault()
          setDragging(false)
        }}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
        sx={{
          position: "relative",
          minHeight: 220,
          p: 2,
          display: "grid",
          placeItems: "center",
          cursor: disabled ? "default" : "pointer",
          overflow: "hidden",
          borderStyle: "dashed",
          borderWidth: 2,
          borderColor: dragging ? "primary.main" : "divider",
          bgcolor: dragging ? "action.hover" : "background.paper",
          transition: "160ms ease",
          "&:hover": disabled
            ? undefined
            : {
                borderColor: "primary.main",
                bgcolor: "action.hover",
              },
        }}
      >
        <input
          ref={inputRef}
          hidden
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(event) => {
            processFile(event.target.files?.[0])
            event.target.value = ""
          }}
        />

        {value ? (
          <>
            <Box
              component="img"
              src={value}
              alt={`Pré-visualização de ${label}`}
              sx={{
                width: "100%",
                maxHeight: 320,
                objectFit: "contain",
                borderRadius: 1.5,
              }}
            />

            <IconButton
              aria-label="Remover foto"
              color="error"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation()
                setError("")
                onChange(name, "")
              }}
              sx={{
                position: "absolute",
                top: 10,
                right: 10,
                bgcolor: "background.paper",
                boxShadow: 2,
                "&:hover": {
                  bgcolor: "background.paper",
                },
              }}
            >
              <DeleteRounded />
            </IconButton>
          </>
        ) : (
          <Stack spacing={1.5} alignItems="center" textAlign="center">
            <ImageRounded color="primary" sx={{ fontSize: 52 }} />

            <Box>
              <Typography fontWeight={800}>
                Arraste uma foto para cá
              </Typography>
              <Typography variant="body2" color="text.secondary">
                ou escolha um arquivo do computador
              </Typography>
            </Box>

            <Button
              type="button"
              variant="outlined"
              startIcon={<UploadFileRounded />}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation()
                inputRef.current?.click()
              }}
            >
              Selecionar foto
            </Button>

            <Typography variant="caption" color="text.secondary">
              Limite de {maxFileSizeMb} MB
            </Typography>
          </Stack>
        )}
      </Paper>

      {helperText && (
        <Typography variant="caption" color="text.secondary">
          {helperText}
        </Typography>
      )}

      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}

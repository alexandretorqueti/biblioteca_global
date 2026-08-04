import { DragEvent, useEffect, useRef, useState } from "react"
import {
  Alert,
  Box,
  Button,
  CircularProgress,
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
  validationError?: string
  disabled?: boolean
  accept?: string
  maxFileSizeMb?: number
  uploadUrl?: string
  onChange: (name: string, value: string) => void
}

interface UploadResponse {
  url: string
}

export default function FieldPhoto({
  name,
  label,
  value,
  required = false,
  helperText,
  validationError,
  disabled = false,
  accept = "image/*",
  maxFileSizeMb = 5,
  uploadUrl = "http://localhost:3001/api/uploads/photos",
  onChange,
}: FieldPhotoProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState("")
  const [uploading, setUploading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(value)

  useEffect(() => {
    setPreviewUrl(value)
  }, [value])

  useEffect(
    () => () => {
      if (previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl)
      }
    },
    [previewUrl],
  )

  const processFile = async (file?: File) => {
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

    const localPreview = URL.createObjectURL(file)
    setPreviewUrl(localPreview)
    setUploading(true)

    try {
      const formData = new FormData()
      formData.append("file", file)

      const response = await fetch(uploadUrl, {
        method: "POST",
        body: formData,
      })

      const body = (await response.json().catch(() => null)) as
        | UploadResponse
        | { message?: string }
        | null

      if (!response.ok || !body || !("url" in body)) {
        throw new Error(
          body && "message" in body && body.message
            ? body.message
            : "Não foi possível enviar a imagem.",
        )
      }

      onChange(name, body.url)
      setPreviewUrl(body.url)
    } catch (uploadError) {
      setPreviewUrl(value)
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Não foi possível enviar a imagem.",
      )
    } finally {
      URL.revokeObjectURL(localPreview)
      setUploading(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)

    if (!disabled && !uploading) {
      void processFile(event.dataTransfer.files[0])
    }
  }

  const blocked = disabled || uploading

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
          if (!blocked) {
            setDragging(true)
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault()
          setDragging(false)
        }}
        onDrop={handleDrop}
        onClick={() => !blocked && inputRef.current?.click()}
        sx={{
          position: "relative",
          minHeight: 220,
          p: 2,
          display: "grid",
          placeItems: "center",
          cursor: blocked ? "default" : "pointer",
          overflow: "hidden",
          borderStyle: "dashed",
          borderWidth: 2,
          borderColor: dragging ? "primary.main" : "divider",
          bgcolor: dragging ? "action.hover" : "background.paper",
          transition: "160ms ease",
          "&:hover": blocked
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
          disabled={blocked}
          onChange={(event) => {
            void processFile(event.target.files?.[0])
            event.target.value = ""
          }}
        />

        {previewUrl ? (
          <>
            <Box
              component="img"
              src={previewUrl}
              alt={`Pré-visualização de ${label}`}
              sx={{
                width: "100%",
                maxHeight: 320,
                objectFit: "contain",
                borderRadius: 1.5,
                opacity: uploading ? 0.55 : 1,
              }}
            />

            {uploading && (
              <Stack
                spacing={1}
                alignItems="center"
                sx={{
                  position: "absolute",
                  inset: 0,
                  justifyContent: "center",
                }}
              >
                <CircularProgress />
                <Typography fontWeight={700}>Enviando foto...</Typography>
              </Stack>
            )}

            {!uploading && (
              <IconButton
                aria-label="Remover foto"
                color="error"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation()
                  setError("")
                  setPreviewUrl("")
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
            )}
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
              disabled={blocked}
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

      {(error || validationError) && (
        <Alert severity="error">{error || validationError}</Alert>
      )}
    </Stack>
  )
}

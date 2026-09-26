import { useEffect, useState } from "react"
import {
  Autocomplete,
  CircularProgress,
  TextField,
} from "@mui/material"
import type {
  EntityRecord,
  MultipleChoiceConfig,
} from "../../types"

interface FieldMultipleChoiceProps {
  name: string
  label: string
  value: string | number
  config: MultipleChoiceConfig
  required?: boolean
  helperText?: string
  disabled?: boolean
  onChange: (name: string, value: string | number) => void
}

export default function FieldMultipleChoice({
  name,
  label,
  value,
  config,
  required = false,
  helperText,
  disabled = false,
  onChange,
}: FieldMultipleChoiceProps) {
  const [options, setOptions] = useState<EntityRecord[]>(config.data ?? [])
  const [inputValue, setInputValue] = useState("")
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState("")

  useEffect(() => {
    if (config.data) {
      setOptions(config.data)
    }
  }, [config.data])

  useEffect(() => {
    if (!config.loadOptions) {
      return
    }

    const minimumSearchLength = config.minimumSearchLength ?? 0

    if (inputValue.length < minimumSearchLength) {
      setOptions([])
      return
    }

    const timeout = window.setTimeout(async () => {
      setLoading(true)
      setLoadError("")

      try {
        setOptions(await config.loadOptions!(inputValue))
      } catch (error) {
        setOptions([])
        setLoadError(
          error instanceof Error
            ? error.message
            : "Não foi possível carregar as opções.",
        )
      } finally {
        setLoading(false)
      }
    }, config.debounceMs ?? 300)

    return () => window.clearTimeout(timeout)
  }, [
    config.debounceMs,
    config.loadOptions,
    config.minimumSearchLength,
    inputValue,
  ])

  const selectedOption =
    options.find(
      (option) => String(option[config.idField]) === String(value),
    ) ?? null

  return (
    <Autocomplete<EntityRecord, false, false, false>
      options={options}
      value={selectedOption}
      inputValue={inputValue}
      loading={loading}
      disabled={disabled}
      noOptionsText={
        loadError ||
        config.noOptionsText ||
        "Nenhuma opção encontrada"
      }
      filterOptions={
        config.loadOptions
          ? (availableOptions) => availableOptions
          : undefined
      }
      isOptionEqualToValue={(option, selected) =>
        String(option[config.idField]) ===
        String(selected[config.idField])
      }
      getOptionLabel={(option) =>
        String(option[config.displayField] ?? "")
      }
      onInputChange={(_event, nextValue) => setInputValue(nextValue)}
      onChange={(_event, option) => {
        const nextValue = option?.[config.idField]

        if (
          typeof nextValue === "string" ||
          typeof nextValue === "number"
        ) {
          onChange(name, nextValue)
        } else {
          onChange(name, "")
        }
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          name={name}
          label={label}
          required={required}
          error={Boolean(loadError)}
          helperText={loadError || helperText}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading ? <CircularProgress size={20} /> : null}
                {params.InputProps.endAdornment}
              </>
            ),
          }}
        />
      )}
    />
  )
}

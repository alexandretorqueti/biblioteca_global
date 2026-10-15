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
  value: string | number | Array<string | number>
  config: MultipleChoiceConfig
  required?: boolean
  helperText?: string
  disabled?: boolean
  onChange: (name: string, value: string | number | Array<string | number>) => void
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

  const selectedOption = config.multiple
    ? options.filter((option) => Array.isArray(value) && value.some((item) => String(option[config.idField]) === String(item)))
    : options.find((option) => String(option[config.idField]) === String(value)) ?? null

  return (
    <Autocomplete<EntityRecord, boolean, false, false>
      options={options}
      value={selectedOption}
      multiple={Boolean(config.multiple)}
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
        if (config.multiple) {
          const values = Array.isArray(option)
            ? option.map((item) => item[config.idField]).filter((item): item is string | number => typeof item === "string" || typeof item === "number")
            : []
          onChange(name, values)
          return
        }
        const nextValue = !Array.isArray(option) ? option?.[config.idField] : undefined

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

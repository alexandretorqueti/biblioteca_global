import { useEffect, useMemo, useState } from "react"
import {
  Autocomplete,
  CircularProgress,
  TextField,
} from "@mui/material"
import { createEntityController } from "../../controllers/entityController"
import type { EntityRecord } from "../../api/entityApi"

export interface MultipleChoiceConfig {
  entity?: string
  data?: EntityRecord[]
  idField: string
  displayField: string
  filterField?: string
  minimumSearchLength?: number
  debounceMs?: number
  noOptionsText?: string
}

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
  const controller = useMemo(
    () =>
      config.entity
        ? createEntityController<EntityRecord>(config.entity)
        : null,
    [config.entity],
  )

  const [options, setOptions] = useState<EntityRecord[]>(config.data ?? [])
  const [inputValue, setInputValue] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (config.data) {
      setOptions(config.data)
    }
  }, [config.data])

  useEffect(() => {
    if (!controller) {
      return
    }

    const minimumSearchLength = config.minimumSearchLength ?? 0

    if (inputValue.length < minimumSearchLength) {
      setOptions([])
      return
    }

    const timeout = window.setTimeout(async () => {
      setLoading(true)

      try {
        const filters =
          inputValue && config.filterField
            ? { [config.filterField]: inputValue }
            : {}

        setOptions(await controller.list(filters))
      } finally {
        setLoading(false)
      }
    }, config.debounceMs ?? 300)

    return () => window.clearTimeout(timeout)
  }, [
    config.debounceMs,
    config.filterField,
    config.minimumSearchLength,
    controller,
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
      noOptionsText={config.noOptionsText ?? "Nenhuma opção encontrada"}
      filterOptions={(availableOptions) => availableOptions}
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
          helperText={helperText}
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

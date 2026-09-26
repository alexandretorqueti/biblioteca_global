import { FormEvent, ReactNode, useMemo, useState } from "react"
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material"
import {
  Apple,
  Cancel as CancelIcon,
  Facebook,
  GitHub,
  Google,
  Visibility,
  VisibilityOff,
} from "@mui/icons-material"

export type LoginIdentifier =
  | "email"
  | "phone"
  | "username"
  | "cpf"
  | "passport"
  | "document"

export type AuthFieldType =
  | "text"
  | "email"
  | "tel"
  | "password"
  | "date"
  | "number"
  | "select"
  | "checkbox"

export interface AuthFieldOption {
  label: string
  value: string
}

export interface AuthRegistrationField {
  name: string
  label: string
  type: AuthFieldType
  required?: boolean
  placeholder?: string
  helperText?: string
  defaultValue?: string | boolean
  options?: AuthFieldOption[]
  fullWidth?: boolean
}

export interface AuthSocialProvider {
  provider: "google" | "apple" | "facebook" | "github" | string
  label?: string
  icon?: ReactNode
}

export interface AuthPanelConfig {
  appName?: string
  title?: string
  subtitle?: string
  loginIdentifier: LoginIdentifier
  customIdentifierLabel?: string
  registrationFields: AuthRegistrationField[]
  socialProviders?: AuthSocialProvider[]
  allowRegistration?: boolean
  allowPasswordRecovery?: boolean
  /** Habilita "Entrar com código por e-mail" (auth única — default true). */
  allowCodeLogin?: boolean
  allowRememberMe?: boolean
  requirePasswordConfirmation?: boolean
  registrationColumns?: 1 | 2
  loginButtonLabel?: string
  registerButtonLabel?: string
}

export type AuthValues = Record<string, string | boolean>

/** Resposta do onVerifyCode — o painel decide se vai para "defina sua senha". */
export interface VerifyCodeResult {
  primeiraVez: boolean
  verificationToken?: string
}

interface AuthPanelProps {
  config: AuthPanelConfig
  onLogin?: (values: AuthValues) => Promise<void> | void
  onRegister?: (values: AuthValues) => void
  onForgotPassword?: (identifier: string) => void
  onSocialLogin?: (provider: string) => void
  /** Pedido de código por e-mail (auth única). */
  onRequestCode?: (email: string) => Promise<void> | void
  /** Valida o código; se primeiraVez, o painel abre "Defina sua senha". */
  onVerifyCode?: (
    email: string,
    code: string,
  ) => Promise<VerifyCodeResult> | void
  /** Define a senha na 1ª vez (verificationToken do verify-code). */
  onSetPassword?: (
    novaSenha: string,
    verificationToken: string,
  ) => Promise<void> | void
}

const identifierLabels: Record<LoginIdentifier, string> = {
  email: "E-mail",
  phone: "Telefone",
  username: "Nome de usuário",
  cpf: "CPF",
  passport: "Passaporte",
  document: "Documento",
}

const identifierTypes: Record<LoginIdentifier, string> = {
  email: "email",
  phone: "tel",
  username: "text",
  cpf: "text",
  passport: "text",
  document: "text",
}

const providerIcons: Record<string, ReactNode> = {
  google: <Google />,
  apple: <Apple />,
  facebook: <Facebook />,
  github: <GitHub />,
}

export default function AuthPanel({
  config,
  onLogin,
  onRegister,
  onForgotPassword,
  onSocialLogin,
  onRequestCode,
  onVerifyCode,
  onSetPassword,
}: AuthPanelProps) {
  const theme = useTheme()
  const [mode, setMode] = useState<
    "login" | "register" | "forgot" | "code" | "set-password"
  >("login")
  const [showPassword, setShowPassword] = useState(false)
  const [successMessage, setSuccessMessage] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const identifierLabel =
    config.customIdentifierLabel ??
    identifierLabels[config.loginIdentifier]

  const initialRegisterValues = useMemo(
    () =>
      config.registrationFields.reduce<AuthValues>((values, field) => {
        values[field.name] =
          field.defaultValue ?? (field.type === "checkbox" ? false : "")
        return values
      }, {}),
    [config.registrationFields],
  )

  const [loginValues, setLoginValues] = useState<AuthValues>({
    identifier: "",
    password: "",
    rememberMe: false,
  })

  const [registerValues, setRegisterValues] =
    useState<AuthValues>(initialRegisterValues)

  const [forgotIdentifier, setForgotIdentifier] = useState("")

  // Estado do fluxo de código (auth única — D4).
  const [codeEmail, setCodeEmail] = useState("")
  const [code, setCode] = useState("")
  const [verificationToken, setVerificationToken] = useState("")
  const [novaSenha, setNovaSenha] = useState("")
  const [confirmacaoSenha, setConfirmacaoSenha] = useState("")
  const [erroCode, setErroCode] = useState("")
  const [codeEnviado, setCodeEnviado] = useState(false)

  const updateLogin = (name: string, value: string | boolean) => {
    setSuccessMessage("")
    setLoginValues((current) => ({ ...current, [name]: value }))
  }

  const updateRegister = (name: string, value: string | boolean) => {
    setSuccessMessage("")
    setRegisterValues((current) => ({ ...current, [name]: value }))
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsLoading(true)
    try {
      await onLogin?.(loginValues)
      setSuccessMessage("Dados de login enviados.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleRegister = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onRegister?.(registerValues)
    setSuccessMessage("Dados de cadastro enviados.")
  }

  const handleForgotPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onForgotPassword?.(forgotIdentifier)
    setSuccessMessage("Solicitação de recuperação enviada.")
  }

  const changeMode = (nextMode: "login" | "register" | "forgot" | "code" | "set-password") => {
    setSuccessMessage("")
    setErroCode("")
    setMode(nextMode)
  }

  // ── Fluxo de código por e-mail (auth única) ──────────────────────────

  const handleRequestCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsLoading(true)
    setErroCode("")
    try {
      await onRequestCode?.(codeEmail)
      setCodeEnviado(true)
      setSuccessMessage("Se o e-mail existir, você receberá um código de acesso.")
    } catch {
      setErroCode("Não foi possível enviar o código. Tente novamente.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerifyCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsLoading(true)
    setErroCode("")
    try {
      const resultado = await onVerifyCode?.(codeEmail, code)
      if (resultado?.primeiraVez && resultado.verificationToken) {
        setVerificationToken(resultado.verificationToken)
        setSuccessMessage("")
        changeMode("set-password")
      } else {
        setSuccessMessage("Login realizado com sucesso.")
      }
    } catch {
      setErroCode("Código inválido ou expirado.")
    } finally {
      setIsLoading(false)
    }
  }

  const handleSetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (novaSenha.length < 8) {
      setErroCode("A senha deve ter pelo menos 8 caracteres.")
      return
    }
    if (novaSenha !== confirmacaoSenha) {
      setErroCode("As senhas não coincidem.")
      return
    }
    setIsLoading(true)
    setErroCode("")
    try {
      await onSetPassword?.(novaSenha, verificationToken)
      setNovaSenha("")
      setConfirmacaoSenha("")
      setCodeEnviado(false)
      changeMode("login")
      setSuccessMessage("Senha definida! Entre com sua nova senha ou com o código.")
    } catch {
      setErroCode("Não foi possível definir a senha. Tente novamente.")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Box
      data-testid="auth-panel-root"
      data-theme-mode={theme.palette.mode}
      sx={{
        minHeight: 620,
        display: "grid",
        placeItems: "center",
        p: { xs: 2, md: 4 },
        borderRadius: 4,
        background:
          theme.palette.mode === "dark"
            ? "radial-gradient(circle at top left, rgba(129,140,248,.22), transparent 36%), linear-gradient(135deg, #111827 0%, #0f172a 55%, #172033 100%)"
            : "radial-gradient(circle at top left, rgba(99,102,241,.22), transparent 36%), linear-gradient(135deg, #eef2ff 0%, #f8fafc 55%, #ecfeff 100%)",
      }}
    >
      <Paper
        elevation={0}
        sx={{
          width: "100%",
          maxWidth: mode === "register" ? 760 : 480,
          p: { xs: 3, md: 4 },
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 4,
          boxShadow:
            theme.palette.mode === "dark"
              ? "0 24px 70px rgba(0,0,0,.38)"
              : "0 24px 70px rgba(15,23,42,.12)",
        }}
      >
        <Stack spacing={3}>
          <Box textAlign="center">
            <Typography variant="overline" color="primary" fontWeight={800}>
              {config.appName ?? "Biblioteca Gera"}
            </Typography>

            <Typography variant="h4" fontWeight={900}>
              {mode === "login"
                ? config.title ?? "Bem-vindo novamente"
                : mode === "register"
                  ? "Crie sua conta"
                  : mode === "forgot"
                    ? "Recuperar senha"
                    : mode === "code"
                      ? "Entrar com código"
                      : "Defina sua senha"}
            </Typography>

            <Typography color="text.secondary" mt={1}>
              {mode === "login"
                ? config.subtitle ?? "Entre para continuar"
                : mode === "register"
                  ? "Preencha os dados configurados para o cadastro"
                  : mode === "forgot"
                    ? `Informe seu ${identifierLabel.toLowerCase()}`
                    : mode === "code"
                      ? "Enviaremos um código de 6 dígitos para seu e-mail"
                      : "Escolha uma senha para seu acesso"}
            </Typography>
          </Box>

          {successMessage && (
            <Alert severity="success">{successMessage}</Alert>
          )}

          {mode === "login" && (
            <>
              {config.socialProviders &&
                config.socialProviders.length > 0 && (
                  <>
                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: {
                          xs: "1fr",
                          sm: `repeat(${Math.min(config.socialProviders.length, 2)}, 1fr)`,
                        },
                        gap: 1.5,
                      }}
                    >
                      {config.socialProviders.map((social) => (
                        <Button
                          key={social.provider}
                          variant="outlined"
                          size="large"
                          startIcon={
                            social.icon ??
                            providerIcons[social.provider.toLowerCase()]
                          }
                          onClick={() =>
                            onSocialLogin?.(social.provider)
                          }
                        >
                          {social.label ??
                            `Continuar com ${social.provider}`}
                        </Button>
                      ))}
                    </Box>

                    <Divider>ou continue com sua conta</Divider>
                  </>
                )}

              <Box component="form" onSubmit={handleLogin}>
                <Stack spacing={2}>
                  <TextField
                    label={identifierLabel}
                    type={identifierTypes[config.loginIdentifier]}
                    required
                    value={loginValues.identifier}
                    onChange={(event) =>
                      updateLogin("identifier", event.target.value)
                    }
                    autoComplete="username"
                  />

                  <TextField
                    label="Senha"
                    type={showPassword ? "text" : "password"}
                    required
                    value={loginValues.password}
                    onChange={(event) =>
                      updateLogin("password", event.target.value)
                    }
                    autoComplete="current-password"
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            onClick={() =>
                              setShowPassword((visible) => !visible)
                            }
                            edge="end"
                            aria-label="Exibir ou ocultar senha"
                          >
                            {showPassword ? (
                              <VisibilityOff />
                            ) : (
                              <Visibility />
                            )}
                          </IconButton>
                        </InputAdornment>
                      ),
                    }}
                  />

                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    {config.allowRememberMe !== false && (
                      <FormControlLabel
                        control={
                          <Checkbox
                            checked={Boolean(loginValues.rememberMe)}
                            onChange={(event) =>
                              updateLogin(
                                "rememberMe",
                                event.target.checked,
                              )
                            }
                          />
                        }
                        label="Lembrar de mim"
                      />
                    )}

                    {config.allowPasswordRecovery !== false && (
                      <Link
                        component="button"
                        type="button"
                        underline="hover"
                        onClick={() => changeMode("forgot")}
                      >
                        Esqueci a senha
                      </Link>
                    )}
                  </Stack>

                  <Button type="submit" variant="contained" size="large" disabled={isLoading} startIcon={isLoading ? <CancelIcon /> : undefined}>
                    {isLoading ? "Entrando..." : (config.loginButtonLabel ?? "Entrar")}
                  </Button>
                </Stack>
              </Box>

              {config.allowRegistration !== false && (
                <Typography textAlign="center" color="text.secondary">
                  Ainda não possui conta?{" "}
                  <Link
                    component="button"
                    type="button"
                    fontWeight={800}
                    onClick={() => changeMode("register")}
                  >
                    Cadastre-se
                  </Link>
                </Typography>
              )}

              {config.allowCodeLogin !== false && (
                <Typography textAlign="center" color="text.secondary">
                  ou{" "}
                  <Link
                    component="button"
                    type="button"
                    fontWeight={800}
                    onClick={() => {
                      setCodeEnviado(false)
                      changeMode("code")
                    }}
                  >
                    Entrar com código por e-mail
                  </Link>
                </Typography>
              )}
            </>
          )}

          {mode === "code" && (
            <Box>
              {!codeEnviado ? (
                <Box component="form" onSubmit={handleRequestCode}>
                  <Stack spacing={2}>
                    <TextField
                      label="E-mail"
                      type="email"
                      required
                      value={codeEmail}
                      onChange={(event) => {
                        setCodeEmail(event.target.value)
                        setSuccessMessage("")
                      }}
                      autoComplete="email"
                    />
                    <Button
                      type="submit"
                      variant="contained"
                      size="large"
                      disabled={isLoading}
                    >
                      {isLoading ? "Enviando..." : "Enviar código"}
                    </Button>
                  </Stack>
                </Box>
              ) : (
                <Box component="form" onSubmit={handleVerifyCode}>
                  <Stack spacing={2}>
                    <TextField
                      label="Código de 6 dígitos"
                      required
                      inputProps={{
                        maxLength: 6,
                        inputMode: "numeric",
                        pattern: "\\d{6}",
                        "data-testid": "code-input",
                      }}
                      value={code}
                      onChange={(event) => {
                        setCode(
                          event.target.value.replace(/\D/g, "").slice(0, 6),
                        )
                        setSuccessMessage("")
                      }}
                    />
                    <Button
                      type="submit"
                      variant="contained"
                      size="large"
                      disabled={isLoading || code.length !== 6}
                    >
                      {isLoading ? "Entrando..." : "Entrar"}
                    </Button>
                    <Button
                      type="button"
                      variant="text"
                      onClick={() => {
                        setCode("")
                        setCodeEnviado(false)
                      }}
                    >
                      Reenviar código para outro e-mail
                    </Button>
                  </Stack>
                </Box>
              )}

              {erroCode && (
                <Alert severity="error" sx={{ mt: 2 }}>
                  {erroCode}
                </Alert>
              )}

              <Button
                type="button"
                variant="text"
                fullWidth
                sx={{ mt: 2 }}
                onClick={() => changeMode("login")}
              >
                Voltar para o login
              </Button>
            </Box>
          )}

          {mode === "set-password" && (
            <Box component="form" onSubmit={handleSetPassword}>
              <Stack spacing={2}>
                <TextField
                  label="Nova senha"
                  type={showPassword ? "text" : "password"}
                  required
                  value={novaSenha}
                  onChange={(event) => {
                    setNovaSenha(event.target.value)
                    setErroCode("")
                  }}
                  autoComplete="new-password"
                  helperText="Mínimo de 8 caracteres"
                />
                <TextField
                  label="Confirme a senha"
                  type={showPassword ? "text" : "password"}
                  required
                  value={confirmacaoSenha}
                  onChange={(event) => {
                    setConfirmacaoSenha(event.target.value)
                    setErroCode("")
                  }}
                  autoComplete="new-password"
                />
                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={isLoading}
                >
                  {isLoading ? "Definindo..." : "Definir senha"}
                </Button>

                {erroCode && (
                  <Alert severity="error">{erroCode}</Alert>
                )}
              </Stack>
            </Box>
          )}

          {mode === "register" && (
            <Box component="form" onSubmit={handleRegister}>
              <Stack spacing={3}>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: {
                      xs: "1fr",
                      md:
                        config.registrationColumns === 1
                          ? "1fr"
                          : "repeat(2, minmax(0, 1fr))",
                    },
                    gap: 2,
                  }}
                >
                  {config.registrationFields.map((field) => {
                    const gridSx = {
                      gridColumn: field.fullWidth
                        ? "1 / -1"
                        : "auto",
                    }

                    if (field.type === "checkbox") {
                      return (
                        <FormControlLabel
                          key={field.name}
                          sx={gridSx}
                          control={
                            <Checkbox
                              checked={Boolean(
                                registerValues[field.name],
                              )}
                              required={field.required}
                              onChange={(event) =>
                                updateRegister(
                                  field.name,
                                  event.target.checked,
                                )
                              }
                            />
                          }
                          label={field.label}
                        />
                      )
                    }

                    if (field.type === "select") {
                      return (
                        <TextField
                          select
                          key={field.name}
                          label={field.label}
                          required={field.required}
                          helperText={field.helperText}
                          value={registerValues[field.name]}
                          onChange={(event) =>
                            updateRegister(
                              field.name,
                              event.target.value,
                            )
                          }
                          sx={gridSx}
                        >
                          {field.options?.map((option) => (
                            <MenuItem
                              key={option.value}
                              value={option.value}
                            >
                              {option.label}
                            </MenuItem>
                          ))}
                        </TextField>
                      )
                    }

                    const isPassword = field.type === "password"

                    return (
                      <TextField
                        key={field.name}
                        label={field.label}
                        type={
                          isPassword && showPassword
                            ? "text"
                            : field.type
                        }
                        required={field.required}
                        placeholder={field.placeholder}
                        helperText={field.helperText}
                        value={registerValues[field.name]}
                        onChange={(event) =>
                          updateRegister(
                            field.name,
                            event.target.value,
                          )
                        }
                        sx={gridSx}
                        InputProps={
                          isPassword
                            ? {
                                endAdornment: (
                                  <InputAdornment position="end">
                                    <IconButton
                                      onClick={() =>
                                        setShowPassword(
                                          (visible) => !visible,
                                        )
                                      }
                                      edge="end"
                                    >
                                      {showPassword ? (
                                        <VisibilityOff />
                                      ) : (
                                        <Visibility />
                                      )}
                                    </IconButton>
                                  </InputAdornment>
                                ),
                              }
                            : undefined
                        }
                      />
                    )
                  })}

                  {config.requirePasswordConfirmation && (
                    <TextField
                      label="Confirme a senha"
                      type={showPassword ? "text" : "password"}
                      required
                      value={registerValues.passwordConfirmation ?? ""}
                      onChange={(event) =>
                        updateRegister(
                          "passwordConfirmation",
                          event.target.value,
                        )
                      }
                    />
                  )}
                </Box>

                <Button type="submit" variant="contained" size="large">
                  {config.registerButtonLabel ?? "Criar conta"}
                </Button>

                <Button
                  type="button"
                  variant="text"
                  onClick={() => changeMode("login")}
                >
                  Voltar para o login
                </Button>
              </Stack>
            </Box>
          )}

          {mode === "forgot" && (
            <Box component="form" onSubmit={handleForgotPassword}>
              <Stack spacing={2}>
                <TextField
                  label={identifierLabel}
                  type={identifierTypes[config.loginIdentifier]}
                  required
                  value={forgotIdentifier}
                  onChange={(event) =>
                    setForgotIdentifier(event.target.value)
                  }
                />

                <Button type="submit" variant="contained" size="large">
                  Enviar instruções
                </Button>

                <Button
                  type="button"
                  variant="text"
                  onClick={() => changeMode("login")}
                >
                  Voltar para o login
                </Button>
              </Stack>
            </Box>
          )}
        </Stack>
      </Paper>
    </Box>
  )
}

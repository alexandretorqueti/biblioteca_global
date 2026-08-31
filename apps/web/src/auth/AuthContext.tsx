/**
 * AuthContext (Etapa 9) — sessão completa do apps/web:
 *   - login via api-client (POST /auth/login)
 *   - seleção de projeto (POST /auth/select-project, com refresh token)
 *   - renovação: agendada antes da expiração + recovery em 401
 *   - logout (revoga o refresh token → volta ao login)
 *
 * O escopo vem do token; `projetoId` jamais sai do cliente. A lista de
 * projetos disponíveis vem do login/refresh (`projetos`).
 *
 * Organização: as operações são funções declaradas "por referência" num
 * objeto (`api`) e estabilizadas por useCallback para o valor do contexto.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type {
  LoginIdentifierType,
  LoginResponse,
  ProjetoResumo,
  RefreshResponse,
  UsuarioAutenticado,
} from "@biblioteca-global/shared"
import {
  loginRequestSchema,
  requestCodeRequestSchema,
  selectProjectRequestSchema,
  setPasswordRequestSchema,
  verifyCodeRequestSchema,
} from "@biblioteca-global/shared"
import { ApiClientError } from "@biblioteca-global/api-client"
import { createApiClient, type ApiClientBundle } from "../api/client"
import { LocalTokenStore } from "../api/tokenStore"
import {
  TokenRefresher,
  lerExpDoAccessStore,
} from "./tokenRefresh"

export type AuthStatus = "unknown" | "authenticated" | "unauthenticated"

export interface AuthSession {
  status: AuthStatus
  usuario: UsuarioAutenticado | null
  /** Projeto selecionado (null até selectProject). */
  projeto: ProjetoResumo | null
  /** Todos os projetos do usuário (lista do login/refresh). */
  projetos: ProjetoResumo[]
  /** true somente no projeto biblioteca-global (admin global). */
  globalAdmin: boolean
  /** Access token do projeto — diagnóstico, não usado pela UI. */
  accessToken: string | null
}

export interface AuthContextValue extends AuthSession {
  login: (input: {
    identifier: string
    password: string
    identifierType: LoginIdentifierType
    rememberMe?: boolean
  }) => Promise<void>
  /** Seleciona o projeto → novo access token (escopo do refresh token). */
  selectProject: (projetoId: number) => Promise<void>
  logout: () => Promise<void>
  /** Renova a sessão (refresh) e devolve true se conseguiu. */
  renewSession: () => Promise<boolean>
  /** Bundle api-client para montar dataSources (ProjectProvider). */
  bundle: ApiClientBundle
  // ── Auth por código (auth única — D4) ────────────────────────────────
  /** Pede um código por e-mail (resposta sempre ok — não revela conta). */
  requestCode: (email: string) => Promise<void>
  /** Valida o código; 1ª vez devolve o token efêmero p/ definir senha. */
  verifyCode: (email: string, code: string) => Promise<{
    primeiraVez: boolean
    verificationToken?: string
  }>
  /** Define a senha na 1ª vez (autenticado pelo token efêmero). */
  setPassword: (novaSenha: string, verificationToken: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function globalAdminDe(projeto: ProjetoResumo | null): boolean {
  // Admin global vive no projeto biblioteca-global (PoC §8).
  return projeto?.slug === "biblioteca-global" && projeto.perfil === "admin"
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<LocalTokenStore | null>(null)
  if (!storeRef.current) {
    const store = new LocalTokenStore()
    // Hidratação: sessão "lembrar de mim" sobrevive ao reload.
    if (store.temRefreshPersistido()) {
      store.setPersist(true)
    }
    storeRef.current = store
  }

  const bundleRef = useRef<ApiClientBundle | null>(null)
  if (!bundleRef.current) {
    bundleRef.current = createApiClient(storeRef.current)
  }
  const store = storeRef.current
  const bundle = bundleRef.current

  const [session, setSession] = useState<AuthSession>({
    status: "unknown",
    usuario: null,
    projeto: null,
    projetos: [],
    globalAdmin: false,
    accessToken: null,
  })
  const projetoAtualRef = useRef<ProjetoResumo | null>(null)

  const reactor = useMemo(
    () =>
      new TokenRefresher({
        onRenew: () => {
          void renewRef.current()
          return Promise.resolve(undefined)
        },
      }),
    [],
  )

  const renewRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false))


  // Guarda o status autenticado para o recovery/refresh.
  const authenticatedRef = useRef(false)

  // ---- Núcleo interno (usado por várias operações) ----

  /** Aplica um LoginResponse/RefreshResponse sem projetar (sessão parcial). */
  function aplicarRespostaAutenticacao(
    res: Pick<LoginResponse | RefreshResponse, "projetos"> & Partial<LoginResponse>,
  ): void {
    const projetos = res.projetos
    const usuario = "usuario" in res ? (res as LoginResponse).usuario : undefined
    authenticatedRef.current = true
    setSession((prev) => ({
      ...prev,
      status: "authenticated",
      usuario: usuario ?? prev.usuario,
      projetos,
      accessToken: store.getAccessToken(),
    }))
    reactor.schedule(
      () => lerExpDoAccessStore(store),
      Math.floor(Date.now() / 1000),
    )
  }

  /** Retorna a sessão ao estado não autenticado. */
  function encerrarSessao(): void {
    reactor.cancel()
    authenticatedRef.current = false
    projetoAtualRef.current = null
    setSession({
      status: "unauthenticated",
      usuario: null,
      projeto: null,
      projetos: [],
      globalAdmin: false,
      accessToken: null,
    })
  }

  /** Seleciona um projeto já validado. */
  async function selecionarProjetoResolvido(projetoId: number): Promise<void> {
    const res = await bundle.auth.selectProject({ projetoId })
    store.setAccessToken(res.accessToken)
    projetoAtualRef.current = res.projeto
    setSession((prev) => ({
      ...prev,
      status: "authenticated",
      projeto: res.projeto,
      globalAdmin: globalAdminDe(res.projeto),
      accessToken: res.accessToken,
    }))
    authenticatedRef.current = true
    reactor.schedule(
      () => lerExpDoAccessStore(store),
      Math.floor(Date.now() / 1000),
    )
  }

  // ---- Operações públicas (estabilizadas) ----

  const login = useCallback(
    async (input: {
      identifier: string
      password: string
      identifierType: LoginIdentifierType
      rememberMe?: boolean
    }): Promise<void> => {
      const parsed = loginRequestSchema.safeParse({
        identifier: input.identifier,
        password: input.password,
        identifierType: input.identifierType,
      })
      if (!parsed.success) {
        throw new ApiClientError(
          400,
          "VALIDATION",
          "Preencha identificador e senha.",
        )
      }
      store.setPersist(input.rememberMe ?? false)
      store.clear()
      const res = await bundle.auth.login(parsed.data)
      store.setRefreshToken(res.refreshToken)
      // Com exatamente 1 projeto, seleciona direto (fluxo do Estudo);
      // com vários, a tela de seleção decide.
      if (res.projetos.length === 1 && res.projetos[0]) {
        await selecionarProjetoResolvido(res.projetos[0].id)
      }
      // Publica a sessão parcial somente depois da seleção automática. Isso
      // evita que o roteador veja authenticated + projeto null e envie o
      // usuário para /select antes do select-project terminar.
      aplicarRespostaAutenticacao(res)
    },
    // store e bundle são estáveis (refs); aplicarRespostaAutenticacao é
    // redefinida por referência estável via closure acima.
    [],
  )

  const selectProject = useCallback(
    async (projetoId: number): Promise<void> => {
      const parsed = selectProjectRequestSchema.safeParse({ projetoId })
      if (!parsed.success) {
        throw new ApiClientError(400, "VALIDATION", "projetoId inválido")
      }
      await selecionarProjetoResolvido(parsed.data.projetoId)
    },
    [],
  )

  const renew = useCallback(async (): Promise<boolean> => {
    if (!store.getRefreshToken()) {
      encerrarSessao()
      return false
    }
    try {
      const res = await bundle.auth.refresh()
      store.setRefreshToken(res.refreshToken)
      aplicarRespostaAutenticacao(res)
      const projetoAtualId = projetoAtualRef.current?.id
      const projetoId = res.projetos.some(
        (projeto) => projeto.id === projetoAtualId,
      )
        ? projetoAtualId
        : res.projetos.length === 1
          ? res.projetos[0]?.id
          : undefined

      if (projetoId !== undefined) {
        // O refresh global não emite access token; é necessário selecionar
        // novamente o projeto para concluir a restauração/renovação.
        await selecionarProjetoResolvido(projetoId)
      } else {
        store.setAccessToken(null)
        projetoAtualRef.current = null
        setSession((prev) => ({
          ...prev,
          projeto: null,
          globalAdmin: false,
          accessToken: null,
        }))
      }
      return true
    } catch {
      store.clear()
      encerrarSessao()
      return false
    }
  }, [])
  renewRef.current = renew

  const logout = useCallback(async (): Promise<void> => {
    try {
      if (store.getRefreshToken()) {
        await bundle.auth.logout()
      }
    } catch {
      // token já revogado → segue
    } finally {
      store.clear()
      encerrarSessao()
    }
  }, [])

  // ── Auth por código (auth única — D4) ────────────────────────────────

  const requestCode = useCallback(
    async (email: string): Promise<void> => {
      const parsed = requestCodeRequestSchema.safeParse({ email })
      if (!parsed.success) {
        throw new ApiClientError(400, "VALIDATION", "E-mail inválido")
      }
      await bundle.auth.requestCode(parsed.data)
    },
    [],
  )

  const verifyCode = useCallback(
    async (email: string, code: string): Promise<{
      primeiraVez: boolean
      verificationToken?: string
    }> => {
      const parsed = verifyCodeRequestSchema.safeParse({ email, code })
      if (!parsed.success) {
        throw new ApiClientError(400, "VALIDATION", "Código inválido")
      }
      const res = await bundle.auth.verifyCode(parsed.data)
      if (res.primeiraVez) {
        return { primeiraVez: true, verificationToken: res.verificationToken }
      }
      // Login completo: mesma aplicação de sessão do login por senha.
      store.setPersist(false)
      store.clear()
      store.setRefreshToken(res.refreshToken)
      if (res.projetos.length === 1 && res.projetos[0]) {
        await selecionarProjetoResolvido(res.projetos[0].id)
      }
      aplicarRespostaAutenticacao(res)
      return { primeiraVez: false }
    },
    [],
  )

  const setPassword = useCallback(
    async (novaSenha: string, verificationToken: string): Promise<void> => {
      const parsed = setPasswordRequestSchema.safeParse({
        novaSenha,
        verificationToken,
      })
      if (!parsed.success) {
        throw new ApiClientError(
          400,
          "VALIDATION",
          "A senha deve ter pelo menos 8 caracteres",
        )
      }
      await bundle.auth.setPassword(parsed.data)
    },
    [],
  )

  const renewSession = useCallback((): Promise<boolean> => renew(), [renew])

  // ---- Recovery do ApiHttpClient: 401 → renovar → retry ----
  useEffect(() => {
    const recovery = async (): Promise<boolean> => {
      if (!authenticatedRef.current) return false
      return renewRef.current()
    }
    bundle.http.setSessionRecovery(recovery)
    return () => {
      reactor.cancel()
    }
  }, [])

  // ---- Hydratação: sessão persistida (lembrar de mim) ----
  useEffect(() => {
    const inicial = (): void => {
      const refresh = store.getRefreshToken()
      const access = store.getAccessToken()
      if (refresh && !access) {
        // Sessão persistida: renova (access nunca sobrevive ao reload).
        void renew()
        return
      }
      if (refresh && access) {
        // Access em memória: agenda a renovação proativa.
        reactor.schedule(
          () => lerExpDoAccessStore(store),
          Math.floor(Date.now() / 1000),
        )
        return
      }
      // Sem sessão: sai do estado "unknown" e redireciona ao login.
      // (Antes ficava "Restaurando sessão…" para sempre.)
      encerrarSessao()
    }
    inicial()
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      ...session,
      login,
      selectProject,
      logout,
      renewSession,
      bundle,
      requestCode,
      verifyCode,
      setPassword,
    }),
    [
      session,
      login,
      selectProject,
      logout,
      renewSession,
      bundle,
      requestCode,
      verifyCode,
      setPassword,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth deve ser usado dentro de <AuthProvider>.")
  }
  return ctx
}

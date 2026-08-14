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
  selectProjectRequestSchema,
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
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function globalAdminDe(projeto: ProjetoResumo | null): boolean {
  // Admin global vive no projeto biblioteca-global (PoC §8).
  return projeto?.slug === "biblioteca-global" && projeto.perfil === "admin"
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<LocalTokenStore | null>(null)
  if (!storeRef.current) storeRef.current = new LocalTokenStore()

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
      aplicarRespostaAutenticacao(res)
      // Com exatamente 1 projeto, seleciona direto (fluxo do Estudo);
      // com vários, a tela de seleção decide.
      if (res.projetos.length === 1 && res.projetos[0]) {
        await selecionarProjetoResolvido(res.projetos[0].id)
      }
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
      if (store.getRefreshToken() && !store.getAccessToken()) {
        void renew()
      } else if (authenticatedRef.current) {
        reactor.schedule(
          () => lerExpDoAccessStore(store),
          Math.floor(Date.now() / 1000),
        )
      }
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
    }),
    [session, login, selectProject, logout, renewSession, bundle],
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

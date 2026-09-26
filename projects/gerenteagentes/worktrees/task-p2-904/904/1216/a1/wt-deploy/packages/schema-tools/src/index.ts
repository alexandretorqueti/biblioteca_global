/**
 * @biblioteca-global/schema-tools — fonte única em ação (PoC §7.2):
 * schema.ts → fields da config, validação Zod e validação contra o schema.
 */
export {
  humanizarNome,
  type FormAnnotation,
  type FormAnnotationsPorTabela,
} from "./form"
export { gerarFields, TipoNaoSuportadoError } from "./gerar-fields"
export { zodParaInsert, zodParaUpdate } from "./zod"
export {
  coletarAnnotations,
  coletarTabelas,
  montarConfigInicial,
  telaCadastroDaTabela,
} from "./gerar-config"
export {
  ConfigInvalidaError,
  RESOURCES_DO_CORE,
  validarConfigContraSchema,
} from "./validar-config"

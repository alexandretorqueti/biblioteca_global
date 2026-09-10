import NotificacoesMoradorScreen, { componentId as notificacoesId } from "./NotificacoesMoradorScreen"
import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"
import RegistroEncomendaScreen, { componentId as registroId } from "./RegistroEncomendaScreen"
import EntregaEncomendaScreen, { componentId as entregaId } from "./EntregaEncomendaScreen"
import OcorrenciaScreen, { componentId as ocorrenciaId } from "./OcorrenciaScreen"

/** Registry exclusivo das telas customizadas do projeto taqui. */
export const customScreens = {
  [painelId]: PainelPortariaScreen,
  [notificacoesId]: NotificacoesMoradorScreen,
  [registroId]: RegistroEncomendaScreen,
  [entregaId]: EntregaEncomendaScreen,
  [ocorrenciaId]: OcorrenciaScreen,
}

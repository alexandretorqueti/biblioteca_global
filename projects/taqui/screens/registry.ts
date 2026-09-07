import NotificacoesMoradorScreen, { componentId as notificacoesId } from "./NotificacoesMoradorScreen"
import PainelPortariaScreen, { componentId as painelId } from "./PainelPortariaScreen"
import RegistroEncomendaScreen, { componentId as registroId } from "./RegistroEncomendaScreen"

/** Registry exclusivo das telas customizadas do projeto taqui. */
export const customScreens = {
  [painelId]: PainelPortariaScreen,
  [notificacoesId]: NotificacoesMoradorScreen,
  [registroId]: RegistroEncomendaScreen,
}

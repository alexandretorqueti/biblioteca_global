/**
 * Utilitário de auditoria responsiva para testes de tela (subtarefa 1624).
 *
 * jsdom não executa layout nem resolve media queries, então a evidência por
 * breakpoint é feita auditando o CSS que o MUI/emotion gera para o DOM
 * montado: regra FORA de `@media` com `min-width` fixo acima da largura útil
 * do viewport de 360px força corte/estouro horizontal no celular — é exatamente
 * a classe de defeito que esta subtarefa corrige (Dialogs com minWidth 320/340
 * dentro de uma área útil de ~296px).
 */
import { expect } from "vitest"

/** Largura útil dentro do DialogContent em viewport de 360px. */
export const LIMITE_CONTEUDO_DIALOG_XS = 296

/** Largura útil da área de conteúdo da página em viewport de 360px. */
export const LIMITE_CONTEUDO_PAGINA_XS = 344

export type RegraOfensiva = {
  seletor: string
  propriedade: string
  valor: string
}

/**
 * Retorna regras `min-width` (em px) que se aplicam ao elemento FORA de
 * qualquer bloco `@media` e excedem `limitePx`. Regras responsivas
 * (`minWidth: { xs: 0, sm: N }`) são aceitas: o `min-width` fica dentro
 * do `@media (min-width: 600px)` e não vale para 360px.
 */
export function regrasMinWidthForaDeMedia(
  el: Element,
  limitePx: number,
): RegraOfensiva[] {
  const ofensivas: RegraOfensiva[] = []
  for (const folha of Array.from(document.styleSheets)) {
    let regras: CSSRuleList
    try {
      regras = folha.cssRules
    } catch {
      continue // folha inacessível (cross-origin) — não ocorre no jsdom
    }
    const visitar = (lista: CSSRuleList, dentroDeMedia: boolean): void => {
      for (const regra of Array.from(lista)) {
        if (regra.type === 4 /* CSSRule.MEDIA_RULE */) {
          visitar((regra as CSSMediaRule).cssRules, true)
          continue
        }
        if (regra.type === 12 /* CSSRule.SUPPORTS_RULE */) {
          visitar((regra as CSSSupportsRule).cssRules, dentroDeMedia)
          continue
        }
        if (dentroDeMedia || regra.type !== 1 /* STYLE_RULE */) continue
        const styleRegra = regra as CSSStyleRule
        try {
          if (!el.matches(styleRegra.selectorText)) continue
        } catch {
          continue // seletor não suportado pelo jsdom
        }
        const valor = styleRegra.style.getPropertyValue("min-width")
        const m = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(valor)
        if (m && Number(m[1]) > limitePx) {
          ofensivas.push({
            seletor: styleRegra.selectorText,
            propriedade: "min-width",
            valor,
          })
        }
      }
    }
    visitar(regras, false)
  }
  return ofensivas
}

/**
 * Varre a subárvore e falha listando toda regra `min-width` fixa (fora de
 * media query) acima de `limitePx` — i.e. conteúdo que corta em 360px.
 */
export function esperarSemMinWidthForaDeMedia(
  raiz: HTMLElement,
  limitePx: number,
): void {
  const alvos: Element[] = [raiz, ...Array.from(raiz.querySelectorAll("*"))]
  const ofensivas = alvos.flatMap((el) =>
    regrasMinWidthForaDeMedia(el, limitePx).map(
      (r) => `${el.nodeName.toLowerCase()}[${r.seletor}] ${r.propriedade}: ${r.valor}`,
    ),
  )
  expect(ofensivas).toEqual([])
}

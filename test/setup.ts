function criarStorageEmMemoria(): Storage {
  const dados = new Map<string, string>()

  return {
    get length() { return dados.size },
    clear: () => dados.clear(),
    getItem: (key) => dados.get(key) ?? null,
    key: (index) => [...dados.keys()][index] ?? null,
    removeItem: (key) => { dados.delete(key) },
    setItem: (key, value) => { dados.set(String(key), String(value)) },
  }
}

// Node 26 expõe `localStorage` como undefined quando não recebe
// --localstorage-file. Nesse caso o JSDOM não consegue substituir o global.
// A suíte usa um storage por worker, suficiente para simular o navegador.
if (!globalThis.localStorage) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: criarStorageEmMemoria(),
  })
}

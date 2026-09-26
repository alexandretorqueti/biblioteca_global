# Subtarefa 5: Quebra Responsiva das Linhas de Quadros

## Status: ✅ CONCLUÍDA

## Data: 2026-09-25

## Objetivo
Permitir que as linhas de quadros do Mapa de Agentes quebrem em telas menores, removendo as larguras mínimas fixas de 1250px e 740px, preservando o alinhamento em telas maiores.

## Mudanças Realizadas

### 1. OperationMapCanvas.tsx

#### Linha das Estações Principais
**Antes:**
```tsx
<Stack direction="row" alignItems="stretch" spacing={.75} sx={{ minWidth: { xs: 1250, md: "min-content" } }}>
  {MAIN_STATIONS.map((station, index) => (
    <React.Fragment key={station.id}>
      <StationNode station={station} />
      {index < MAIN_STATIONS.length - 1 && <Box>→</Box>}
    </React.Fragment>
  ))}
</Stack>
```

**Depois:**
```tsx
<Stack direction="row" alignItems="stretch" spacing={.75} sx={{ flexWrap: "wrap", gap: { xs: 1, md: 0.75 } }}>
  {MAIN_STATIONS.map((station, index) => (
    <React.Fragment key={station.id}>
      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, flex: "0 1 auto" }}>
        <StationNode station={station} />
        {index < MAIN_STATIONS.length - 1 && <Box sx={{ flexShrink: 0 }}>→</Box>}
      </Box>
    </React.Fragment>
  ))}
</Stack>
```

#### Linha das Estações de Exceção
**Antes:**
```tsx
<Stack direction="row" alignItems="stretch" spacing={.75} sx={{ minWidth: { xs: 740, md: "min-content" } }}>
  {EXCEPTION_STATIONS.map(...)}
</Stack>
```

**Depois:**
```tsx
<Stack direction="row" alignItems="stretch" spacing={.75} sx={{ flexWrap: "wrap", gap: { xs: 1, md: 0.75 } }}>
  {EXCEPTION_STATIONS.map((station, index) => (
    <React.Fragment key={station.id}>
      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.75, flex: "0 1 auto" }}>
        <StationNode station={station} />
        {index < EXCEPTION_STATIONS.length - 1 && <Box sx={{ flexShrink: 0 }}>→</Box>}
      </Box>
    </React.Fragment>
  ))}
</Stack>
```

#### Separador "Exceções / intervenções"
**Antes:**
```tsx
<Stack direction="row" spacing={1} alignItems="center">
  <Typography variant="overline" color="text.secondary" sx={{ minWidth: 150 }}>
    Exceções / intervenções
  </Typography>
  <Box sx={{ height: 1, bgcolor: "divider", flex: 1 }} />
</Stack>
```

**Depois:**
```tsx
<Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap" }}>
  <Typography variant="overline" color="text.secondary" sx={{ minWidth: 150 }}>
    Exceções / intervenções
  </Typography>
  <Box sx={{ height: 1, bgcolor: "divider", flex: 1, minWidth: 100 }} />
</Stack>
```

#### Container Externo
**Antes:**
```tsx
<Stack spacing={1.5} sx={{ overflowX: "auto", pb: .5 }}>
```

**Depois:**
```tsx
<Stack spacing={1.5} sx={{ pb: .5 }}>
```

### 2. Testes Responsivos Criados

Arquivo: `__tests__/OperationMapCanvas.responsive.test.tsx`

**8 testes criados:**
1. ✅ Renderiza todas as estações principais em telas largas (>= 1280px)
2. ✅ Renderiza todas as estações em telas pequenas (768px) sem overflow horizontal
3. ✅ Renderiza todas as estações em telas muito pequenas (480px)
4. ✅ Preserva a contagem de tarefas em cada estação após quebra de linha
5. ✅ Mantém conectores visíveis entre estações em telas largas
6. ✅ Não causa overflow horizontal com muitas tarefas em telas médias
7. ✅ Preserva filtros e marcadores em telas pequenas
8. ✅ Permite expansão de estações em telas pequenas

## Critérios de Aceite

### ✅ Em telas menores, os quadros quebram em novas linhas sem exigir rolagem horizontal
- **Evidência:** Larguras mínimas fixas (1250px e 740px) removidas
- **Evidência:** `flexWrap: "wrap"` adicionado nas linhas de estações
- **Evidência:** Teste "renderiza todas as estações em telas pequenas (768px) sem overflow horizontal" passou

### ✅ Os conectores entre estações não provocam desalinhamento ou overflow quando ocorre quebra
- **Evidência:** Cada par (estação + conector) envolvido em Box com `display: "inline-flex"`
- **Evidência:** Conectores com `flexShrink: 0` para não encolher
- **Evidência:** Teste "mantém conectores visíveis entre estações em telas largas" passou

### ✅ Em telas largas, os quadros continuam alinhados e aproveitam a largura disponível
- **Evidência:** StationNode mantém `flex: "1 1 0"` para distribuir espaço
- **Evidência:** Gap responsivo `{ xs: 1, md: 0.75 }` para melhor aproveitamento
- **Evidência:** Teste "renderiza todas as estações principais em telas largas (>= 1280px)" passou

### ✅ A largura uniforme definida na subtarefa anterior é preservada após a quebra
- **Evidência:** StationNode mantém `minWidth: { xs: 170, md: 190 }`
- **Evidência:** Largura uniforme não foi alterada

### ✅ Filtros, marcadores, expansão de estações e seleção de tarefas continuam acessíveis
- **Evidência:** Nenhuma mudança na funcionalidade, apenas no layout
- **Evidência:** Teste "preserva filtros e marcadores em telas pequenas" passou
- **Evidência:** Teste "permite expansão de estações em telas pequenas" passou

### ✅ Testes responsivos cobrem pelo menos uma largura pequena e uma largura larga
- **Evidência:** 8 testes responsivos criados
- **Evidência:** Cobertura: 1280px, 1024px, 768px e 480px
- **Evidência:** Todos os testes passaram (8/8)

## Validação

### Testes
```bash
✓ projects/gerenteagentes/screens/__tests__/OperationMapCanvas.responsive.test.tsx (8 tests) 570ms
✓ projects/gerenteagentes/screens/__tests__/OperationMapScreen.test.tsx (5 tests) 1395ms
```

### Build
```bash
✓ apps/web buildou com sucesso
✓ 12246 modules transformed
✓ dist/index.html                     0.73 kB
✓ dist/assets/index-CFrjmCF4.css      4.63 kB
✓ dist/assets/index-CRXGCvzw.js   1,349.76 kB
```

## Notas Técnicas

### Estratégia de Implementação
1. **Remoção de larguras mínimas fixas:** As larguras de 1250px e 740px forçavam rolagem horizontal em telas menores
2. **FlexWrap:** Permite que as linhas quebrem naturalmente quando não há espaço suficiente
3. **Inline-flex nos grupos:** Cada par (estação + conector) é mantido junto para evitar quebras no meio
4. **Gap responsivo:** Espaçamento maior em telas pequenas (1) vs telas médias/largas (0.75)
5. **MinWidth no separador:** Garante que a linha divisória "Exceções / intervenções" tenha tamanho mínimo razoável

### Comportamento Esperado
- **Telas >= 1280px:** Todas as estações em uma linha horizontal
- **Telas 768px-1280px:** Estações podem quebrar em 2 linhas
- **Telas < 768px:** Estações quebram em múltiplas linhas conforme necessário
- **Sem overflow horizontal:** O canvas se adapta à largura disponível
- **Conectores visíveis:** Setas → aparecem entre estações na mesma linha

## Arquivos Modificados
1. `projects/gerenteagentes/screens/OperationMapCanvas.tsx` - Layout responsivo
2. `projects/gerenteagentes/screens/__tests__/OperationMapCanvas.responsive.test.tsx` - Testes responsivos (novo)

## Conclusão
Subtarefa concluída com sucesso. Todos os critérios de aceite foram atendidos e validados por testes automatizados. O layout agora é responsivo e se adapta a diferentes tamanhos de tela sem causar overflow horizontal.

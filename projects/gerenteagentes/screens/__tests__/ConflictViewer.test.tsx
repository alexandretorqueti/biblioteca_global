// @vitest-environment jsdom
/**
 * Testes do ConflictViewer — validação de conflitos persistidos e botões de resolução.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import ConflictViewer, { type PromotionConflictData } from '../ConflictViewer'

describe('ConflictViewer', () => {
  const mockPersistedData: PromotionConflictData = {
    id: 1,
    status: 'pending',
    confidence: 'high',
    recommendation: 'manual_rebase',
    report: null,
    errorMessage: null,
    baseBranch: 'base-desenvolvimento',
    taskBranch: 'motor-v2/task-123/integracao',
    baseCommit: 'abc123',
    taskCommit: 'def456',
    mergeBaseCommit: 'ghi789',
    conflictFiles: ['src/file1.ts', 'src/file2.ts'],
    evidence: {
      conflictFiles: [
        {
          path: 'src/file1.ts',
          kind: 'mechanical',
          baseExcerpt: 'base content',
          taskExcerpt: 'task content',
          ancestorExcerpt: 'ancestor content',
        },
        {
          path: 'src/file2.ts',
          kind: 'semantic',
          baseExcerpt: 'base content 2',
          taskExcerpt: 'task content 2',
          ancestorExcerpt: 'ancestor content 2',
        },
      ],
      resolutions: {},
    },
    attempts: 1,
    createdAt: '2026-09-30T10:00:00Z',
    updatedAt: '2026-09-30T10:00:00Z',
  }

  it('exibe dados persistidos quando disponíveis', () => {
    render(<ConflictViewer persistedData={mockPersistedData} />)
    
    expect(screen.getByText(/2 conflito\(s\)/)).toBeInTheDocument()
    expect(screen.getByText('base-desenvolvimento')).toBeInTheDocument()
    expect(screen.getByText('motor-v2/task-123/integracao')).toBeInTheDocument()
  })

  it('exibe botões de resolução quando onResolveConflict é fornecido', () => {
    const handleResolve = vi.fn()
    render(<ConflictViewer persistedData={mockPersistedData} onResolveConflict={handleResolve} />)
    
    // Selecionar primeiro arquivo
    fireEvent.click(screen.getByText('file1.ts'))
    
    // Verificar botões de resolução
    expect(screen.getByText('Aceitar Ours')).toBeInTheDocument()
    expect(screen.getByText('Aceitar Theirs')).toBeInTheDocument()
    expect(screen.getByText('Aceitar Both')).toBeInTheDocument()
  })

  it('chama onResolveConflict ao clicar em botão de resolução', async () => {
    const handleResolve = vi.fn().mockResolvedValue(undefined)
    render(<ConflictViewer persistedData={mockPersistedData} onResolveConflict={handleResolve} />)
    
    fireEvent.click(screen.getByText('file1.ts'))
    fireEvent.click(screen.getByText('Aceitar Ours'))
    
    await waitFor(() => {
      expect(handleResolve).toHaveBeenCalledWith('src/file1.ts', 'ours')
    })
  })

  it('diferencia conflitos reais de modificações simultâneas', () => {
    const dataWithMixedConflicts: PromotionConflictData = {
      ...mockPersistedData,
      evidence: {
        conflictFiles: [
          {
            path: 'src/real-conflict.ts',
            kind: 'mechanical',
            baseExcerpt: 'base',
            taskExcerpt: 'task',
            ancestorExcerpt: 'ancestor',
          },
          {
            path: 'src/modified.ts',
            kind: 'unknown',
            baseExcerpt: 'base',
            taskExcerpt: 'task',
            ancestorExcerpt: 'ancestor',
          },
        ],
      },
    }
    
    render(<ConflictViewer persistedData={dataWithMixedConflicts} />)
    
    // Ambos os arquivos devem aparecer na lista
    expect(screen.getByText('real-conflict.ts')).toBeInTheDocument()
    expect(screen.getByText('modified.ts')).toBeInTheDocument()
    
    // O chip de "conflict" deve aparecer para o conflito real
    const conflictChips = screen.getAllByText('conflict')
    expect(conflictChips.length).toBeGreaterThan(0)
  })

  it('exibe progresso de resolução', () => {
    const dataWithResolutions: PromotionConflictData = {
      ...mockPersistedData,
      evidence: {
        ...mockPersistedData.evidence,
        resolutions: {
          'src/file1.ts': 'ours',
        },
      },
    }
    
    render(<ConflictViewer persistedData={dataWithResolutions} />)
    
    expect(screen.getByText(/1\/2 resolvidos/)).toBeInTheDocument()
  })

  it('exibe mensagem de sucesso quando não há conflitos', () => {
    const emptyData: PromotionConflictData = {
      ...mockPersistedData,
      conflictFiles: [],
      evidence: {
        conflictFiles: [],
      },
    }
    
    render(<ConflictViewer persistedData={emptyData} />)
    
    expect(screen.getByText(/Merge limpo/)).toBeInTheDocument()
  })
})

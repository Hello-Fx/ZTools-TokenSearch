import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { useCommandDataStore } from '../../src/renderer/src/stores/commandDataStore'
import {
  emptyCommandSearchResult,
  type CommandContext,
  type CommandSearchRequest
} from '../../src/shared/commandService'

/**
 * 构造测试输入快照。
 * @param searchQuery 搜索文本
 * @returns 完整输入
 */
function input(searchQuery: string): CommandContext {
  return { searchQuery, pastedFiles: null, pastedImage: null, pastedText: null }
}

describe('搜索选项透传', () => {
  let pinia: ReturnType<typeof createPinia>
  let store: ReturnType<typeof useCommandDataStore>
  const query = vi.fn<
    (request: CommandSearchRequest) => Promise<ReturnType<typeof emptyCommandSearchResult>>
  >(async (request) => emptyCommandSearchResult(request))

  beforeEach(async () => {
    query.mockClear()
    vi.stubGlobal('window', {
      ztools: {
        commands: {
          query,
          execute: vi.fn().mockResolvedValue({ success: true }),
          cancel: vi.fn(),
          releaseSearch: vi.fn(),
          getHome: vi.fn().mockResolvedValue({
            history: [],
            pinned: [],
            superPanelPinned: [],
            recommendationPins: []
          }),
          onSearchUpdate: vi.fn(() => () => {}),
          onStateChanged: vi.fn(() => () => {})
        }
      }
    })
    pinia = createPinia()
    setActivePinia(pinia)
    store = useCommandDataStore()
    await store.initializeData()
  })

  afterEach(() => {
    disposePinia(pinia)
    vi.unstubAllGlobals()
  })

  it('把分词开关与词内匹配选项随查询提交给主进程', async () => {
    await store.query(input('visual code'), true, {
      tokenSearch: true,
      matchInsideWord: true
    })
    expect(query).toHaveBeenLastCalledWith(
      expect.objectContaining({
        searchOptions: { tokenSearch: true, matchInsideWord: true }
      })
    )
  })

  it('未提供选项时保持默认模糊搜索', async () => {
    await store.query(input('chrome'), true)
    expect(query).toHaveBeenLastCalledWith(expect.objectContaining({ searchOptions: undefined }))
  })
})

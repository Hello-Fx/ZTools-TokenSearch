import { describe, expect, it } from 'vitest'
import { buildCommandCatalog } from '../../src/main/core/commands/catalog'
import { CommandSearchEngine } from '../../src/main/core/commands/engine'
import { commandServiceFixture } from '../helpers/commandService'
import type {
  CommandCatalogInput,
  CommandMatchContext,
  CommandRankState
} from '../../src/shared/commandService'

const userState: CommandRankState = {
  recommendationPins: [],
  usage: [],
  preference: {}
}

/**
 * 创建无粘贴内容的查询上下文。
 * @param searchQuery 查询词
 * @returns 输入快照
 */
function context(searchQuery: string): CommandMatchContext {
  return { searchQuery, pastedImage: false, pastedFiles: null, pastedText: null }
}

/**
 * 以应用名称构建真实目录与引擎。
 * @param names 应用名称
 * @param overrides 目录覆盖项
 * @returns 搜索引擎
 */
function engine(
  names: string[],
  overrides: Partial<CommandCatalogInput> = {}
): CommandSearchEngine {
  return new CommandSearchEngine(
    buildCommandCatalog({
      apps: names.map((name, i) => ({ name, path: '/app/' + i })),
      plugins: [],
      settings: [],
      localShortcuts: [],
      aliases: {},
      disabledCommands: [],
      disabledPlugins: [],
      enabledMainPushPlugins: [],
      ...overrides
    })
  )
}

describe('分词搜索查询选项', () => {
  it('分词开关决定跨词查询是否参与匹配', () => {
    const search = engine(['Visual Studio Code'])
    // 默认六类只做连续字段比较，跨词且中间缺词的输入不命中。
    expect(search.query({ context: context('visual code') }, userState).bestSearchResults).toEqual(
      []
    )
    expect(
      search
        .query({ context: context('visual code'), searchOptions: { tokenSearch: true } }, userState)
        .bestSearchResults.map((item) => item.name)
    ).toEqual(['Visual Studio Code'])
  })

  it('matchInsideWord 单独门控词首子序列命中', () => {
    const search = engine(['A Dance of Fire and Ice'])
    const locked = search.query(
      { context: context('dne'), searchOptions: { tokenSearch: true } },
      userState
    )
    expect(locked.bestSearchResults).toEqual([])
    const inside = search.query(
      {
        context: context('dne'),
        searchOptions: { tokenSearch: true, matchInsideWord: true }
      },
      userState
    )
    const item = inside.bestSearchResults[0]
    expect(item.name).toBe('A Dance of Fire and Ice')
    expect(item.highlightRanges!.map(([start, end]) => item.name.slice(start, end + 1))).toEqual([
      'D',
      'n',
      'e'
    ])
  })

  it('分词同分时系统应用仍然优先', () => {
    const search = engine([], {
      apps: [{ name: 'Dancer', path: '/app' }],
      plugins: [
        {
          name: 'p',
          path: '/p',
          features: [
            { code: 'dancer', explain: 'dancer', cmds: [{ type: 'text', label: 'Dancer' }] }
          ]
        }
      ]
    })
    const result = search.query(
      { context: context('danc'), searchOptions: { tokenSearch: true } },
      userState
    )
    expect(result.bestSearchResults.map((item) => item.type)).toEqual(['direct', 'plugin'])
  })

  it('服务把分词选项透传到匹配线程', async () => {
    const { service } = commandServiceFixture({
      apps: [{ name: 'Visual Studio Code', path: '/app' }]
    })
    const token = await service.query('main', {
      sessionId: 'session',
      requestId: 1,
      context: { ...context('visual code'), pastedImage: null },
      searchOptions: { tokenSearch: true }
    })
    expect(token.bestSearchResults.map((item) => item.name)).toEqual(['Visual Studio Code'])
    const plain = await service.query('main', {
      sessionId: 'session',
      requestId: 2,
      context: { ...context('visual code'), pastedImage: null }
    })
    expect(plain.bestSearchResults).toEqual([])
  })
})

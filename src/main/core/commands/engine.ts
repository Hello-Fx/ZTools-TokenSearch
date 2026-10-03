import Fuse from 'fuse.js'
import { pinyin } from 'pinyin-pro'
import {
  matchesFilesInput,
  matchesOverText,
  matchesRegexText,
  matchesWindowInput,
  parseMatchPattern
} from '../../../shared/commandContextShared'
import {
  emptyCommandSearchResult,
  getRecommendationPinKey,
  type Command,
  type CommandCatalog,
  type CommandContext,
  type CommandSearchRequest,
  type CommandSearchResult,
  type CommandUserState
} from '../../../shared/commandService'

import { deduplicateResults } from '../../../shared/commandResults'

/**
 * 在隔离线程里统一判定所有内容规则，保留正则 flags 和排除条件。
 * @param command 指令规则
 * @param context 查询快照
 * @param compiled 可复用的预编译表达式
 * @returns 规则是否命中
 */
export function matchesContext(
  command: Command,
  context: CommandContext,
  compiled?: RegExp | null
): boolean {
  const cmd = command.matchCmd
  if (!cmd) return true
  const text = context.pastedText || context.searchQuery
  try {
    switch (cmd.type) {
      case 'regex':
        return (
          !context.pastedImage &&
          !context.pastedFiles &&
          matchesRegexText(text, cmd, { preserveFlags: true, compiledRegex: compiled })
        )
      case 'over':
        return (
          !context.pastedImage &&
          !context.pastedFiles &&
          matchesOverText(text, cmd, {
            useExclude: true,
            preserveExcludeFlags: true,
            allowPlainExclude: true,
            compiledExclude: compiled
          })
        )
      case 'img':
        return !!context.pastedImage
      case 'files':
        return (
          !!context.pastedFiles &&
          matchesFilesInput(context.pastedFiles, cmd, {
            preserveFlags: true,
            allowPlainString: true,
            compiledRegex: compiled
          })
        )
      case 'window':
        return matchesWindowInput(context.windowInfo, cmd, {
          preserveTitleFlags: true,
          titleRegex: compiled
        })
    }
  } catch {
    return false
  }
  return false
}

/**
 * 将搜索字段索引映射到显示名称的 UTF-16 区间。
 * @param command 搜索表示
 * @param query 查询词
 * @returns 包含两端的高亮区间
 */
function highlightRanges(command: Command, query: string): Array<[number, number]> {
  const indices = new Set<number>()
  const pos = command.name.toLowerCase().indexOf(query.toLowerCase())
  if (pos >= 0) return [[pos, pos + query.length - 1]]
  for (const match of command.matches || []) {
    if (match.key === 'name') {
      for (const [start, end] of match.indices) for (let i = start; i <= end; i++) indices.add(i)
    } else if (match.key === 'pinyin' || match.key === 'pinyinAbbr') {
      let searchOffset = 0
      let nameOffset = 0
      for (const char of command.name) {
        const token = pinyin(char, {
          toneType: 'none',
          type: 'string',
          ...(match.key === 'pinyinAbbr' ? { pattern: 'first' as const } : {})
        }).replace(/\s+/g, '')
        if (
          match.indices.some(
            ([start, end]) => start <= searchOffset + token.length - 1 && end >= searchOffset
          )
        ) {
          for (let i = 0; i < char.length; i++) indices.add(nameOffset + i)
        }
        searchOffset += token.length
        nameOffset += char.length
      }
    } else if (match.key === 'acronym') {
      const starts = [...command.name.matchAll(/\b\w|[A-Z]/g)].map((match) => match.index!)
      starts.slice(0, query.length).forEach((index) => indices.add(index))
    }
  }
  const ranges: Array<[number, number]> = []
  for (const index of [...indices].sort((a, b) => a - b)) {
    const previous = ranges[ranges.length - 1]
    if (previous && previous[1] + 1 === index) previous[1] = index
    else ranges.push([index, index])
  }
  return ranges
}

/**
 * 计算一次搜索的排序权重，避免比较器内重复计算。
 * @param command 命中项
 * @param query 搜索词
 * @returns 越大越靠前的分数
 */
function score(command: Command, query: string): number {
  const text = command.name.toLowerCase()
  const q = query.toLowerCase()
  if (text === q) return 10000
  const position = text.indexOf(q)
  return (
    (text.startsWith(q) ? 5000 : 0) +
    (position >= 0 ? 2000 + Math.max(0, 500 - position * 10) : 0) +
    (query.length / Math.max(1, text.length)) * 100 +
    Math.max(0, 100 - (command.matches?.[0]?.indices[0]?.[0] || 0)) +
    (command.type === 'direct' && command.subType === 'app' ? 300 : 0)
  )
}

/**
 * 为不可变目录建立普通名称索引，所有匹配和排名只发生在 Worker。
 */
export class CommandSearchEngine {
  private index: Fuse<Command>
  private patterns = new Map<string, RegExp | null>()

  /**
   * 构造可复用目录索引。
   * @param catalog 原子目录快照
   * @returns 搜索引擎实例
   */
  constructor(public readonly catalog: CommandCatalog) {
    this.index = this.createIndex(catalog.commands)
    for (const command of catalog.rules) {
      if (this.patterns.has(command.ruleId!)) continue
      const cmd = command.matchCmd
      const pattern =
        cmd?.type === 'regex'
          ? (cmd.match ?? cmd.regex)
          : cmd?.type === 'over'
            ? cmd.exclude
            : cmd?.type === 'files'
              ? cmd.match
              : cmd?.type === 'window'
                ? cmd.match?.title
                : undefined
      this.patterns.set(
        command.ruleId!,
        parseMatchPattern(pattern, {
          preserveFlags: true,
          allowPlainString: cmd?.type === 'over' || cmd?.type === 'window'
        })
      )
    }
  }

  /**
   * 创建严格子串匹配的索引，保持现有产品匹配策略。
   * @param commands 待索引表示
   * @returns Fuse 索引
   */
  private createIndex(commands: Command[]): Fuse<Command> {
    return new Fuse(commands, {
      keys: [
        { name: 'name', weight: 2 },
        { name: 'pinyin', weight: 1.5 },
        { name: 'pinyinAbbr', weight: 1 },
        { name: 'acronym', weight: 1.5 },
        { name: 'aliases', weight: 1.5 }
      ],
      threshold: 0,
      ignoreLocation: true,
      includeMatches: true
    })
  }

  /**
   * 搜索名称并应用偏好，长名称使用直接子串回退。
   * @param commands 搜索范围；省略时复用全局索引
   * @param query 搜索词
   * @param state 用户状态快照
   * @returns 最终排名的搜索表示
   */
  private names(
    commands: Command[] | undefined,
    query: string,
    state: CommandUserState
  ): Command[] {
    if (!query) return commands || []
    const found =
      query.length > 32
        ? (commands || this.catalog.commands)
            .filter((item) => item.name.toLowerCase().includes(query.toLowerCase()))
            .map((item) => ({ item, matches: [] }))
        : (commands ? this.createIndex(commands) : this.index).search(query)
    const ranked = found
      .map((item) => {
        const command = { ...item.item, matches: (item.matches || []) as Command['matches'] }
        command.highlightRanges = highlightRanges(command, query)
        return { command, score: score(command, query) }
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.command)
    const pref = state.preference[query.trim().toLowerCase()]
    const index = pref
      ? ranked.findIndex(
          (item) =>
            item.path === pref.path &&
            item.featureCode === pref.featureCode &&
            item.name === pref.name
        )
      : -1
    if (index > 0) ranked.unshift(...ranked.splice(index, 1))
    return ranked
  }

  /**
   * 从同一快照生成主搜索、面板和窗口分组结果。
   * @param request 带版本的查询
   * @param state 用户缓存
   * @param revision 目录版本
   * @returns 所有静态分组与动态候选
   */
  query(
    request: CommandSearchRequest,
    state: CommandUserState,
    revision: number
  ): CommandSearchResult {
    const result = emptyCommandSearchResult(request, revision)
    const context = request.context
    const query = context.searchQuery.trim()
    if (request.target) {
      const parts = request.target.split('/').map((part) => part.trim())
      const candidates = [...this.catalog.commands, ...this.catalog.rules].filter((item) =>
        parts.length === 2
          ? (item.pluginName === parts[0] || item.pluginTitle === parts[0]) &&
            item.name === parts[1]
          : item.name === parts[0]
      )
      const priority = { files: 500, img: 450, regex: 400, over: 350, window: 300, text: 0 }
      result.panelResults = candidates
        .filter((item) => matchesContext(item, context, this.patterns.get(item.ruleId!)))
        .sort((a, b) => priority[b.cmdType || 'text'] - priority[a.cmdType || 'text'])
      return result
    }
    const usage = new Map(
      state.usage.map((item) => [`${item.path}:${item.featureCode || ''}`, item.useCount || 0])
    )
    // 内容匹配先于别名筛选，别名不会改变原规则 payload。
    const matched = this.catalog.rules.filter(
      (item) =>
        (request.intent !== 'window' || item.cmdType === 'window') &&
        matchesContext(item, context, this.patterns.get(item.ruleId!))
    )
    const content = matched.filter((item) => item.cmdType !== 'window')
    const filterContent = !!context.pastedImage || !!context.pastedFiles || !!context.pastedText
    const contentNames = filterContent && query ? this.names(content, query, state) : content
    const byUsage = (items: Command[]): Command[] =>
      deduplicateResults(
        [...items].sort(
          (a, b) =>
            (usage.get(`${b.path}:${b.featureCode || ''}`) || 0) -
            (usage.get(`${a.path}:${a.featureCode || ''}`) || 0)
        )
      )
    result.windowCommands = deduplicateResults(
      this.names(
        matched.filter((item) => item.cmdType === 'window'),
        query,
        state
      )
    ).map((item) => ({ ...item, windowInfo: context.windowInfo || undefined }))
    // 窗口专用查询不执行无关内容规则或唤醒动态插件。
    if (request.intent === 'window') return result
    const normal = query
      ? this.names(undefined, query, state).filter(
          (item) => !item.matchCmd || matchesContext(item, context, this.patterns.get(item.ruleId!))
        )
      : []
    const regex = contentNames.filter(
      (item) => item.cmdType === 'regex' || item.cmdType === 'img' || item.cmdType === 'files'
    )
    const over = contentNames.filter((item) => item.cmdType === 'over')
    result.bestSearchResults = !filterContent
      ? deduplicateResults(normal)
      : context.pastedText && !regex.length
        ? byUsage(over)
        : []
    result.bestMatches = byUsage(regex)
    const pins = new Map(
      state.recommendationPins.map((item, index) => [getRecommendationPinKey(item), index])
    )
    result.recommendations =
      request.showRecommendations === false
        ? []
        : byUsage(over).sort(
            (a, b) =>
              (pins.get(getRecommendationPinKey(a)) ?? Infinity) -
              (pins.get(getRecommendationPinKey(b)) ?? Infinity)
          )
    // 列表展示保留服务排名，避免 UI 二次排序覆盖搜索偏好。
    result.allListModeResults = deduplicateResults([
      ...result.bestSearchResults,
      ...result.bestMatches,
      ...result.recommendations
    ])
    result.panelResults = deduplicateResults([...normal, ...byUsage(content)])
    const pushText = (context.pastedText || query).toLowerCase()
    const pushNames = this.catalog.commands.filter(
      (item) =>
        item.mainPush &&
        (item.name.toLowerCase().includes(pushText) ||
          pushText.includes(item.name.toLowerCase()) ||
          item.pinyin?.includes(pushText) ||
          item.pinyinAbbr?.includes(pushText))
    )
    result.mainPushCandidates =
      !context.pastedImage && !context.pastedFiles && pushText
        ? deduplicateResults([...pushNames, ...content].filter((item) => item.mainPush))
        : []
    return result
  }
}

import type { NameMatch } from '../../searchTypes'
import type { NameMatchContext, NameMatcher, NameSource, PreparedQuery } from '../contracts'
import { matchCommand, type TokenPattern } from './tokenSearch'

/** 分词命中的系统应用加权，与集合层分词搜索保持同一口径。 */
const SYSTEM_APP_BONUS = 300

/** 分词策略索引：名称与展示身份，编码在查询时按需计算。 */
export interface TokenIndex {
  name: string
  systemApp: boolean
}

/**
 * 分词搜索策略：把分词算法的命中事实接入统一名称排名。
 *
 * 分词模式由引擎按查询选项单独调度，正常模式下不会注册到默认六类表示中，
 * 因此两种匹配方式互不叠加。
 */
export class TokenMatcher implements NameMatcher<TokenIndex> {
  readonly id = 'token'

  /**
   * 只保存名称与系统应用身份；分词编码与命中计算都在查询时完成。
   * @param source 名称来源
   * @returns 分词索引
   */
  build(source: NameSource): TokenIndex {
    return {
      name: source.name,
      systemApp: source.type === 'direct' && source.subType === 'app'
    }
  }

  /**
   * 分词策略接受任何非空输入，是否启用由引擎的查询选项决定。
   * @param query 查询快照
   * @returns 是否需要调度分词策略
   */
  supports(query: PreparedQuery): boolean {
    return !!query.raw.trim()
  }

  /**
   * 运行分词匹配，并把模式分转换为统一命中事实。
   * @param index 分词索引
   * @param query 查询快照；使用原始输入保留尾随空格的强制断词语义
   * @param context 匹配上下文，提供 matchInsideWord 选项
   * @returns 带高亮区间的命中；未命中时为 null
   */
  match(index: TokenIndex, query: PreparedQuery, context: NameMatchContext): NameMatch | null {
    const outcome = matchCommand(index.name, query.raw, {
      matchInsideWord: context.matchInsideWord
    })
    if (!outcome) return null
    // 精确命中已是最强信号，不再叠加系统应用加权，与分词集合层口径一致。
    const bonus = outcome.pattern === 'exact' || !index.systemApp ? 0 : SYSTEM_APP_BONUS
    return {
      score: outcome.score + bonus,
      shape: shapeOf(outcome.pattern),
      partial: false,
      compact: false,
      position: 0,
      length: 0,
      field: this.id,
      alternatives: 0,
      ranges: outcome.matches[0]?.indices ?? []
    }
  }
}

/**
 * 把分词模式映射为统一命中形态，只用来说明命中的位置关系。
 * @param pattern 分词匹配模式
 * @returns 统一命中形态
 */
function shapeOf(pattern: TokenPattern): NameMatch['shape'] {
  if (pattern === 'exact') return 'exact'
  return pattern.startsWith('single-') || pattern.includes('at-start') ? 'prefix' : 'contains'
}

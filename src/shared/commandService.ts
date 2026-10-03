import type { CommandAliasStore } from './commandShared'
import type { FilesCmdLike, OverCmdLike, RegexCmdLike, WindowCmdLike } from './commandContextShared'
import type { PluginLaunchSource } from './pluginLaunch'

export type CommandType = 'direct' | 'plugin' | 'builtin' | 'file'
export type CommandSubType = 'app' | 'system-setting' | 'local-shortcut'
export type CommandInputType = 'text' | 'regex' | 'over' | 'img' | 'files' | 'window'
export type MatchCmd =
  | RegexCmdLike
  | OverCmdLike
  | FilesCmdLike
  | WindowCmdLike
  | { type: 'img'; label?: string }

export interface MatchInfo {
  indices: Array<[number, number]>
  value: string
  key: string
}

export interface Command {
  name: string
  path: string
  type: CommandType
  subType?: CommandSubType
  icon?: string
  featureCode?: string
  pluginName?: string
  pluginTitle?: string
  pluginExplain?: string
  cmdType?: CommandInputType
  matchCmd?: MatchCmd
  mainPush?: boolean
  pinyin?: string
  pinyinAbbr?: string
  acronym?: string
  aliases?: string[]
  matches?: MatchInfo[]
  matchType?: 'acronym' | 'name' | 'pinyin' | 'pinyinAbbr'
  highlightRanges?: Array<[number, number]>
  settingUri?: string
  category?: string
  confirmDialog?: any
  originalName?: string
  persistedName?: string
  /** 执行目标、规则与搜索表示使用不同身份，避免 alias 改变匹配型 payload。 */
  targetId?: string
  ruleId?: string
  resultId?: string
  disabled?: boolean
  windowInfo?: CommandWindowInfo
}

export interface CommandFile {
  path: string
  name: string
  isDirectory: boolean
  isFile?: boolean
}

export interface CommandWindowInfo {
  app?: string
  title?: string
  className?: string
  bundleId?: string
  pid?: number
  hwnd?: number
  path?: string
  url?: string
}

export interface CommandContext {
  searchQuery: string
  pastedImage: string | null
  pastedFiles: CommandFile[] | null
  pastedText: string | null
  windowInfo?: CommandWindowInfo | null
}

export interface RecommendationPin {
  path: string
  featureCode?: string
  name: string
  pluginName?: string
  type: CommandType
}

export interface CommandUserState {
  history: Command[]
  pinned: Command[]
  superPanelPinned: any[]
  recommendationPins: RecommendationPin[]
  usage: Array<{
    path: string
    featureCode?: string
    name?: string
    useCount?: number
    lastUsed?: number
  }>
  preference: Record<string, { path: string; featureCode?: string; name: string }>
}

export interface CommandCatalogInput {
  localAppSearchEnabled?: boolean
  apps: any[]
  plugins: any[]
  settings: any[]
  localShortcuts: any[]
  aliases: CommandAliasStore
  disabledPlugins: string[]
  disabledCommands: string[]
  enabledMainPushPlugins: string[]
}

export interface CommandCatalog {
  commands: Command[]
  rules: Command[]
  canonical: Command[]
  plugins: any[]
}

export interface MainPushItem {
  icon?: string
  text: string
  title?: string
  [key: string]: any
}

export interface MainPushGroup {
  featureKey: string
  pluginPath: string
  pluginName: string
  pluginLogo: string
  featureCode: string
  featureExplain: string
  featureIcon?: string
  matchedCmdType: string
  /** 动态结果选择必须复用产生该组结果的查询上下文。 */
  resultId: string
  items: MainPushItem[]
}

export interface CommandSearchRequest {
  target?: string
  sessionId: string
  requestId: number
  context: CommandContext
  intent?: 'search' | 'panel' | 'window'
  showRecommendations?: boolean
}

export interface CommandSearchResult {
  sessionId: string
  requestId: number
  catalogRevision: number
  bestSearchResults: Command[]
  bestMatches: Command[]
  recommendations: Command[]
  allListModeResults: Command[]
  windowCommands: Command[]
  panelResults: Command[]
  mainPushCandidates: Command[]
  mainPushGroups: MainPushGroup[]
  error?: string
}

export interface CommandHomeState {
  revision: number
  history: Command[]
  pinned: Command[]
  superPanelPinned: any[]
  recommendationPins: RecommendationPin[]
}

export interface CommandExecutionRequest {
  target?: string
  sessionId?: string
  requestId?: number
  resultId?: string
  command?: Command
  context?: CommandContext
  source?: PluginLaunchSource
  option?: MainPushItem
  enterMainPush?: boolean
}

export interface CommandExecutionResult {
  success: boolean
  error?: string
  restoreContext?: CommandContext
}

export type RecommendationOperation = {
  action: 'pin' | 'unpin' | 'front'
  command: RecommendationPin
}

export type PanelMutation =
  | {
      action: 'move'
      sourceKey: string
      targetKey?: string | null
      beforeKey?: string
      containerKey?: string
    }
  | { action: 'remove' | 'ungroup' | 'new-folder'; key: string }
  | { action: 'rename'; key: string; name: string }

export interface PanelMutationResult {
  success: boolean
  items: any[]
  error?: string
}

export interface CommandServiceClient {
  query(request: CommandSearchRequest): Promise<CommandSearchResult>
  cancel(sessionId: string, requestId: number): void
  execute(request: CommandExecutionRequest): Promise<CommandExecutionResult>
  getHome(): Promise<CommandHomeState>
  getCatalog(): Promise<Command[]>
  recommendation(operation: RecommendationOperation): Promise<CommandHomeState>
  onSearchUpdate(callback: (result: CommandSearchResult) => void): () => void
  onStateChanged(callback: () => void): () => void
}

/**
 * 创建当前查询的空结果，供取消、错误和初次渲染复用。
 * @param request 查询身份
 * @param revision 指令目录版本
 * @returns 不携带旧查询内容的空结果
 */
export function emptyCommandSearchResult(
  request: Pick<CommandSearchRequest, 'sessionId' | 'requestId'>,
  revision = 0
): CommandSearchResult {
  return {
    ...request,
    catalogRevision: revision,
    bestSearchResults: [],
    bestMatches: [],
    recommendations: [],
    allListModeResults: [],
    windowCommands: [],
    panelResults: [],
    mainPushCandidates: [],
    mainPushGroups: []
  }
}

/**
 * 生成推荐置顶的稳定身份，兼容插件安装路径变化。
 * @param command 推荐记录
 * @returns 推荐序列使用的稳定键
 */
export function getRecommendationPinKey(command: RecommendationPin): string {
  return command.type === 'plugin'
    ? JSON.stringify([
        'plugin',
        command.pluginName || command.path,
        command.featureCode || command.name
      ])
    : JSON.stringify([command.type, command.path, command.name])
}

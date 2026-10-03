import {
  emptyCommandSearchResult,
  getRecommendationPinKey,
  type Command,
  type CommandCatalog,
  type CommandCatalogInput,
  type CommandContext,
  type CommandExecutionRequest,
  type CommandExecutionResult,
  type CommandHomeState,
  type CommandSearchRequest,
  type CommandSearchResult,
  type CommandUserState,
  type RecommendationOperation
} from '../../../shared/commandService'
import type { SearchWorkerClient } from './workerClient'
import { applyPanelMutation, normalizePanelState } from './panelState'
import type { PanelMutation, PanelMutationResult } from '../../../shared/commandService'

export interface CommandServiceDependencies {
  worker: Pick<SearchWorkerClient, 'publish' | 'query'>
  sources: () => Promise<CommandCatalogInput>
  read: (key: string) => any
  write: (key: string, value: any) => void
  launch: (options: any) => Promise<any>
  queryMainPush: (path: string, code: string, data: any) => Promise<any[]>
  selectMainPush: (path: string, code: string, data: any) => Promise<boolean>
  stateChanged: () => void
}

interface SearchSession {
  requestId: number
  request: CommandSearchRequest
  result?: CommandSearchResult
  timer?: ReturnType<typeof setTimeout>
  update?: (result: CommandSearchResult) => void
}

/**
 * 主进程指令业务入口，按调用方隔离查询、动态回调及启动上下文。
 */
export class CommandService {
  private catalog: CommandCatalog = { commands: [], rules: [], canonical: [], plugins: [] }
  private revision = 0
  private generation = 0
  private dirty = true
  private building: Promise<void> | undefined
  private userState: CommandUserState | undefined
  private sessions = new Map<string, SearchSession>()
  private launchQueue: Promise<unknown> = Promise.resolve()

  /**
   * 注入平台适配器，业务服务不直接依赖 Electron 或窗口。
   * @param dependencies 来源、存储和插件运行时适配器
   * @returns 指令服务实例
   */
  constructor(private dependencies: CommandServiceDependencies) {}

  /**
   * 标记目录或用户状态失效，撤销所有旧动态任务。
   * @param catalogChanged 是否需要重建来源目录
   * @returns 无返回值
   */
  invalidate(catalogChanged = true): void {
    this.userState = undefined
    if (catalogChanged) {
      this.dirty = true
      this.generation++
      for (const session of this.sessions.values()) {
        clearTimeout(session.timer)
        session.result = undefined
      }
    }
    this.dependencies.stateChanged()
  }

  /**
   * 原子构建目录，期间发生的新来源变化必须重新构建。
   * @returns 目录就绪的 Promise
   */
  private async ensureCatalog(): Promise<void> {
    if (this.building) await this.building
    if (!this.dirty) return
    this.building = (async () => {
      while (this.dirty) {
        const generation = this.generation
        const input = await this.dependencies.sources()
        const catalog = await this.dependencies.worker.publish(input)
        if (generation !== this.generation) continue
        this.catalog = catalog
        this.revision++
        this.dirty = false
      }
    })()
    try {
      await this.building
    } finally {
      this.building = undefined
    }
  }

  /**
   * 缓存轻量用户状态，输入时无需再读数据库或发送统计 IPC。
   * @returns 当前用户状态快照
   */
  private state(): CommandUserState {
    if (!this.userState) {
      const read = this.dependencies.read
      this.userState = {
        history: read('command-history') || [],
        pinned: read('pinned-commands') || [],
        superPanelPinned: read('super-panel-pinned') || [],
        recommendationPins: read('recommendation-pinned') || [],
        usage: read('command-usage-stats') || [],
        preference: read('search-preference') || {}
      }
    }
    return this.userState
  }

  /**
   * 检查查询仍属于当前会话，防止异步结果写回其它输入。
   * @param key 调用方与会话组合键
   * @param session 查询快照
   * @returns 是否仍有效
   */
  private current(key: string, session: SearchSession): boolean {
    return this.sessions.get(key) === session && !this.dirty
  }

  /**
   * 查询静态结果并分别流式发布动态插件结果。
   * @param owner 调用方身份，由主进程提供
   * @param request 查询和完整输入快照
   * @param update 动态结果通知适配器
   * @returns 静态搜索结果
   */
  async query(
    owner: string,
    request: CommandSearchRequest,
    update?: (result: CommandSearchResult) => void
  ): Promise<CommandSearchResult> {
    const key = JSON.stringify([owner, request.sessionId])
    const previous = this.sessions.get(key)
    if (previous && request.requestId <= previous.requestId)
      return emptyCommandSearchResult(request, this.revision)
    clearTimeout(previous?.timer)
    const session: SearchSession = {
      requestId: request.requestId,
      request: structuredClone(request),
      update
    }
    this.sessions.set(key, session)
    try {
      await this.ensureCatalog()
      const generation = this.generation
      const result = await this.dependencies.worker.query(
        session.request,
        this.state(),
        this.revision
      )
      if (!this.current(key, session) || generation !== this.generation)
        return emptyCommandSearchResult(request, this.revision)
      session.result = result
      // 失效立即生效；防抖只推迟插件计算，不保留上一轮动态结果。
      session.timer = setTimeout(() => this.queryDynamic(key, session), 300)
      return structuredClone(result)
    } catch (error) {
      return {
        ...emptyCommandSearchResult(request, this.revision),
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 每个插件完成后独立发布，慢插件不会阻塞其它分组。
   * @param key 会话组合键
   * @param session 生成候选的输入快照
   * @returns 无返回值
   */
  private queryDynamic(key: string, session: SearchSession): void {
    if (!this.current(key, session) || !session.result) return
    for (const command of session.result.mainPushCandidates) {
      const data = this.payload(command, session.request.context)
      void this.dependencies
        .queryMainPush(command.path, command.featureCode || '', data)
        .then((items) => {
          if (
            !this.current(key, session) ||
            !session.result ||
            !Array.isArray(items) ||
            !items.length
          )
            return
          session.result.mainPushGroups.push({
            featureKey: `${command.path}:${command.featureCode}`,
            pluginPath: command.path,
            pluginName: command.pluginName || '',
            pluginLogo: command.icon || '',
            featureCode: command.featureCode || '',
            featureExplain: command.pluginExplain || '',
            featureIcon: command.icon,
            matchedCmdType: command.cmdType || 'text',
            resultId: command.resultId!,
            items
          })
          // 按候选顺序保持分组稳定，完成先后的差异不会重排已显示项目。
          session.result.mainPushGroups.sort(
            (a, b) =>
              session.result!.mainPushCandidates.findIndex((item) => item.resultId === a.resultId) -
              session.result!.mainPushCandidates.findIndex((item) => item.resultId === b.resultId)
          )
          session.update?.(structuredClone(session.result))
        })
        .catch((error) => console.error('[Commands] 动态搜索失败:', command.pluginName, error))
    }
  }

  /**
   * 取消旧查询；取消也推进版本，防止延迟 IPC 复活旧请求。
   * @param owner 可信调用方身份
   * @param sessionId 会话标识
   * @param requestId 最新输入版本
   * @returns 无返回值
   */
  cancel(owner: string, sessionId: string, requestId: number): void {
    const key = JSON.stringify([owner, sessionId])
    const previous = this.sessions.get(key)
    if (previous && previous.requestId >= requestId) return
    clearTimeout(previous?.timer)
    this.sessions.set(key, {
      requestId,
      request: {
        sessionId,
        requestId,
        context: { searchQuery: '', pastedImage: null, pastedFiles: null, pastedText: null }
      }
    })
  }

  /**
   * 窗口销毁或页面重载时释放所有相关会话。
   * @param owner 调用方身份
   * @returns 无返回值
   */
  release(owner: string): void {
    for (const [key, session] of this.sessions) {
      if (JSON.parse(key)[0] !== owner) continue
      clearTimeout(session.timer)
      this.sessions.delete(key)
    }
  }

  /**
   * 在服务端构造启动数据，匹配型输入只能来自产生结果的快照。
   * @param command 当前指令
   * @param context 查询快照
   * @returns 插件启动数据
   */
  private payload(command: Command, context: CommandContext): any {
    const type = command.cmdType || 'text'
    const payload =
      type === 'img'
        ? context.pastedImage
        : type === 'files'
          ? context.pastedFiles?.map((file) => ({ ...file, isFile: !file.isDirectory }))
          : type === 'window'
            ? context.windowInfo
            : type === 'regex' || type === 'over'
              ? context.pastedText || context.searchQuery
              : context.pastedText || context.searchQuery
    return { code: command.featureCode || '', type, payload: payload ?? '', inputState: context }
  }

  /**
   * 排队执行启动，兼容现有运行时的共享 launchParam 并防止交叉覆盖。
   * @param owner 可信调用方身份
   * @param request 选择身份或固定项
   * @returns 最终执行结果
   */
  execute(owner: string, request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    const snapshot = structuredClone(request)
    const operation = this.launchQueue.then(() => this.executeNow(owner, snapshot))
    this.launchQueue = operation.catch(() => undefined)
    return operation
  }

  /**
   * 兼容持久化空功能代码，重查可用性和规则后执行目录中的真实指令。
   * @param owner 调用方身份
   * @param request 不可变选择快照
   * @returns 执行结果或状态恢复请求
   */
  private async executeNow(
    owner: string,
    request: CommandExecutionRequest
  ): Promise<CommandExecutionResult> {
    try {
      await this.ensureCatalog()
      if (request.command?.path === 'special:last-match')
        return {
          success: true,
          restoreContext: this.dependencies.read('last-match-state') || undefined
        }
      const session = request.sessionId
        ? this.sessions.get(JSON.stringify([owner, request.sessionId]))
        : undefined
      if (request.sessionId && (!session?.result || session.requestId !== request.requestId))
        return { success: false, error: '搜索结果已过期' }
      const selected =
        request.resultId && session?.result
          ? [
              ...session.result.allListModeResults,
              ...session.result.windowCommands,
              ...session.result.panelResults,
              ...session.result.mainPushCandidates
            ].find((item) => item.resultId === request.resultId)
          : request.command
      const available = [
        ...this.catalog.commands,
        ...this.catalog.rules,
        ...this.catalog.canonical
      ].filter((item) => !item.disabled)
      const context = structuredClone(
        session?.request.context ||
          request.context || {
            searchQuery: '',
            pastedImage: null,
            pastedFiles: null,
            pastedText: null
          }
      )
      let command: Command | undefined
      if (request.target) {
        const exact = await this.dependencies.worker.query(
          { target: request.target, sessionId: 'exact', requestId: 0, context },
          this.state(),
          this.revision
        )
        const targets = new Set(exact.panelResults.map((item) => item.targetId))
        if (targets.size > 1)
          return { success: false, error: '多个指令同名，请使用「插件名称/指令名称」精确指定' }
        command = exact.panelResults[0]
      } else {
        // 旧面板把缺省功能代码保存为空字符串，与目录中的缺省值视为同一身份。
        command =
          available.find(
            (item) =>
              selected &&
              (selected.ruleId
                ? item.ruleId === selected.ruleId && item.name === selected.name
                : item.path === selected.path &&
                  (item.featureCode || '') === (selected.featureCode || '') &&
                  item.name === selected.name)
          ) ||
          (!request.resultId && selected
            ? available.find(
                (item) =>
                  item.path === selected.path &&
                  (item.featureCode || '') === (selected.featureCode || '')
              )
            : undefined)
        if (!command && selected?.type === 'file')
          command = this.state().history.find(
            (item) => item.type === 'file' && item.path === selected.path
          )
      }
      if (!command) return { success: false, error: '指令已删除、禁用或不满足当前输入' }
      if (command.matchCmd) {
        // 执行校验仍在隔离线程，恶意正则不会因点击结果阻塞主线程。
        const validation = await this.dependencies.worker.query(
          { sessionId: 'validation', requestId: 0, context },
          this.state(),
          this.revision
        )
        if (
          ![...validation.panelResults, ...validation.windowCommands].some(
            (item) => item.ruleId === command.ruleId
          )
        )
          return { success: false, error: '当前输入不满足指令规则' }
      }
      const param = this.payload(command, context)
      if (request.option) {
        const group = session?.result?.mainPushGroups.find(
          (item) => item.resultId === request.resultId
        )
        if (!group) return { success: false, error: '动态结果已过期' }
        const option = { ...request.option }
        delete option._resolvedIcon
        if (
          !group.items.some((item) => {
            const raw = { ...item }
            delete raw._resolvedIcon
            return JSON.stringify(raw) === JSON.stringify(option)
          })
        )
          return { success: false, error: '动态结果项已过期' }
        param.option = option
        if (
          !request.enterMainPush &&
          !(await this.dependencies.selectMainPush(command.path, command.featureCode || '', param))
        )
          return { success: true }
      }
      if (request.enterMainPush || request.option) param.from = 'main'
      const launched = await this.dependencies.launch({
        path: command.path,
        type: command.type,
        featureCode: command.featureCode,
        name: command.name,
        cmdType: command.cmdType || 'text',
        confirmDialog: command.confirmDialog,
        param,
        launchSource: request.source || 'search'
      })
      if (launched?.success === false) return launched
      if (context.searchQuery.trim() && (!command.cmdType || command.cmdType === 'text')) {
        const preference = {
          ...this.state().preference,
          [context.searchQuery.trim().toLowerCase()]: {
            path: command.path,
            name: command.name,
            featureCode: command.featureCode
          }
        }
        this.dependencies.write('search-preference', preference)
      }
      this.invalidate(false)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 将旧持久化名称恢复为当前目录项，路径升级和别名删除不丢失操作身份。
   * @param records 持久化指令
   * @returns 当前可用的显示指令
   */
  private reconcile(records: Command[]): Command[] {
    const available = [
      ...this.catalog.commands,
      ...this.catalog.rules,
      ...this.catalog.canonical
    ].filter((item) => !item.disabled)
    return records.flatMap<Command>((record) => {
      if (record.path === 'special:last-match') return [{ ...record, type: 'builtin' as const }]
      if (record.type === 'file') return [record]
      const same = (item: Command): boolean =>
        record.type === 'plugin'
          ? (record.pluginName
              ? item.pluginName === record.pluginName
              : item.path === record.path) && item.featureCode === record.featureCode
          : item.path === record.path
      const command =
        available.find((item) => same(item) && item.name === record.name) || available.find(same)
      return command ? [{ ...command, persistedName: record.name }] : []
    })
  }

  /**
   * 返回经过目录校验的历史、固定与推荐置顶快照。
   * @returns 主页状态
   */
  async getHome(): Promise<CommandHomeState> {
    await this.ensureCatalog()
    this.getPanelState()
    const state = this.state()
    const panel = state.superPanelPinned.flatMap((item) => {
      if (!item.isFolder) return this.reconcile([item])
      const items = this.reconcile(item.items || [])
      return items.length > 1 ? [{ ...item, items }] : items
    })
    return structuredClone({
      revision: this.revision,
      history: this.reconcile(state.history),
      pinned: this.reconcile(state.pinned),
      superPanelPinned: panel,
      recommendationPins: state.recommendationPins
    })
  }

  /**
   * 提供设置页需要的原始指令，搜索 UI 无需拿到完整索引。
   * @returns 完整目录快照
   */
  async getCatalog(): Promise<CommandCatalog> {
    await this.ensureCatalog()
    return structuredClone(this.catalog)
  }

  /**
   * 精确预解析快捷键名称，不执行第三方规则或剪贴板操作。
   * @param target 配置的名称
   * @returns 可能命中的可用目录表示
   */
  async getTargetCandidates(target: string): Promise<Command[]> {
    await this.ensureCatalog()
    const parts = target.split('/').map((part) => part.trim())
    return [...this.catalog.commands, ...this.catalog.rules].filter(
      (item) =>
        !item.disabled &&
        (parts.length === 2
          ? (item.pluginName === parts[0] || item.pluginTitle === parts[0]) &&
            item.name === parts[1]
          : item.name === parts[0])
    )
  }

  /**
   * 在主进程独立管理推荐置顶序列。
   * @param operation 推荐置顶操作
   * @returns 更新后的主页状态
   */
  async recommendation(operation: RecommendationOperation): Promise<CommandHomeState> {
    const key = getRecommendationPinKey(operation.command)
    const pins = [...this.state().recommendationPins]
    const index = pins.findIndex((item) => getRecommendationPinKey(item) === key)
    if (operation.action === 'unpin' || operation.action === 'front') {
      if (index >= 0) pins.splice(index, 1)
    }
    if (operation.action === 'front') pins.unshift(operation.command)
    else if (operation.action === 'pin' && index < 0) pins.push(operation.command)
    this.dependencies.write('recommendation-pinned', pins)
    this.invalidate(false)
    return this.getHome()
  }

  /**
   * 根据持久化最新状态执行面板操作，页面只提交项目身份与位置。
   * @param operation 面板动作
   * @returns 更新列表或供失败回滚的当前列表
   */
  panelMutation(operation: PanelMutation): PanelMutationResult {
    let current = this.dependencies.read('super-panel-pinned') || []
    try {
      current = this.getPanelState()
      const items = applyPanelMutation(current, operation)
      this.dependencies.write('super-panel-pinned', items)
      this.invalidate(false)
      return { success: true, items }
    } catch (error) {
      return {
        success: false,
        items: current,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /**
   * 读取面板结构并一次性持久化旧文件夹缺失的身份。
   * @returns 具有稳定身份的面板列表
   * @throws 持久化结构无效时抛错
   */
  getPanelState(): any[] {
    const current = this.dependencies.read('super-panel-pinned') || []
    const normalized = normalizePanelState(current)
    if (current.some((item) => item?.isFolder && !item.id)) {
      // 在任何页面收到快照前完成迁移，后续拖动使用同一份身份。
      this.dependencies.write('super-panel-pinned', normalized)
      this.userState = undefined
    }
    return normalized
  }
}

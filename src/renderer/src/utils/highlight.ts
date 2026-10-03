/**
 * 根据主进程返回的显示区间生成安全 HTML，不在页面计算拼音。
 * @param text 显示名称
 * @param _matches 兼容旧展示调用的匹配字段
 * @param _matchType 兼容旧展示调用的匹配类型
 * @param query 无区间时使用的子串显示词
 * @param ranges 主进程计算的包含两端的区间
 * @returns 转义后的高亮 HTML
 */
export function highlightMatch(
  text: string,
  _matches?: unknown,
  _matchType?: string,
  query?: string,
  ranges?: Array<[number, number]>
): string {
  if (!ranges?.length) return highlightSubstring(text, query)
  let html = ''
  let offset = 0
  for (const [start, end] of ranges) {
    html += escapeHtml(text.slice(offset, start))
    html += '<mark class="highlight">' + escapeHtml(text.slice(start, end + 1)) + '</mark>'
    offset = end + 1
  }
  return html + escapeHtml(text.slice(offset))
}

/**
 * 简单子串高亮：在文本中高亮搜索查询的子串匹配
 * 适用于没有 Fuse.js 匹配信息的场景（如 mainPush 插件结果）
 * @param text 原始文本
 * @param query 搜索查询
 * @returns 包含高亮标签的HTML字符串
 */
export function highlightSubstring(text: string, query?: string): string {
  if (!query || !query.trim()) {
    return escapeHtml(text)
  }

  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase().trim()
  const idx = lowerText.indexOf(lowerQuery)

  if (idx === -1) {
    return escapeHtml(text)
  }

  const before = escapeHtml(text.substring(0, idx))
  const matched = escapeHtml(text.substring(idx, idx + lowerQuery.length))
  const after = escapeHtml(text.substring(idx + lowerQuery.length))
  return before + '<mark class="highlight">' + matched + '</mark>' + after
}

/**
 * 转义HTML特殊字符,防止XSS
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

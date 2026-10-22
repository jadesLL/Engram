/**
 * 输入法（IME）组字与编辑器模型同步的边界判定。
 *
 * 背景：Vditor 的 getValue() 在组字期间会把「还没上屏的拼音」一起序列化进 Markdown。
 * 如果父级正文（v-model）回灌或外部更新在这个时刻走到 MarkdownEditor.applyModelValue，
 * 一旦判定「值不同」就会 vditor.setValue() 整块重建编辑器 DOM——组字被打断（拼音被当成
 * 拉丁字母提交）、光标跳位、正文被重新解析（列表/表格结构看起来被改掉）；保存路径直接读
 * getValue() 也会把拼音写进文件。这里把边界判定抽成纯函数，便于单测锁住行为。
 */

/** 组字期间编辑器活值（可能混着未提交拼音）不能当正文用，只能退回最近一次稳定快照。 */
export function stableEditorMarkdown(composing: boolean, live: string, committed: string): string {
  return composing ? committed : live;
}

export type ModelSyncAction =
  /** 与编辑器当前内容等价（通常是自己 emit 出去的回显）：不需要也不应该重渲染 */
  | 'skip'
  /** 组字中且值确实不同：先记着，等 compositionend 后再判断；此时绝不能 setValue */
  | 'defer'
  /** 不在组字且外部值确实不同（换页/外部更新）：整块写入 */
  | 'apply';

/**
 * 决定「父级 modelValue」要不要写回编辑器、什么时候写。
 *
 * @param composing 当前是否处于 IME 组字
 * @param incomingEqualsLive 外部值（转成编辑器 Markdown 后）与编辑器活值等价
 * @param incomingEqualsCommitted 外部值与最近一次稳定值等价（说明只是自己上次提交的回显）
 */
export function decideModelSync(
  composing: boolean,
  incomingEqualsLive: boolean,
  incomingEqualsCommitted: boolean,
): ModelSyncAction {
  if (incomingEqualsLive) return 'skip';
  if (!composing) return 'apply';
  // 组字中：自己提交时的回显（等于稳定值）直接丢弃；真正的外部改动推迟到组字结束后。
  return incomingEqualsCommitted ? 'skip' : 'defer';
}

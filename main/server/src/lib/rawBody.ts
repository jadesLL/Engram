/**
 * 原始资料的正文形态：**正文不再重复一级标题**。
 *
 * 标题已经有两处权威承载——文件名（`YYYY.MM.DD_标题.md`）与 frontmatter `标题`
 * （见 lib/vault.ts 的 extractTitle：frontmatter 标题 > 文件名，H1 只算正文内容），
 * 页头展示的就是它。正文再写一行 `# 标题` 只会让每次打开资料都先读一遍重复的标题。
 *
 * 所以「应用自己往原始资料写正文」的每条路径都过这里，保证口径一致：
 *   - routes/files.ts 新建空文件；
 *   - lib/ideaNote.ts 灵感速记（正文用户输入，标题模型拟）；
 *   - lib/chat.ts save_chat 对话沉积；
 *   - pipeline/inboxConvert.ts 收集箱入库；
 *   - pipeline/rawMaterial.ts Agent 新建原始资料。
 *
 * 注意：只处理**开头**那一个一级标题（它就是标题位）。正文中后段的一级标题是原文档的
 * 结构（例如「# 一.SP规划」），不是重复，不动。
 */

/** 开头的一级标题行：最多 3 个前导空格，`#` 后必须有空格或行尾，且第二个字符不是 `#`（那是 ## 二级标题） */
const LEADING_H1 = /^[ \t]{0,3}#(?:[ \t]+|$)/;

/** 正文是否以一级标题开头（跳过前导空行） */
export function hasLeadingHeading(text: string): boolean {
  const lines = String(text ?? '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    return LEADING_H1.test(line);
  }
  return false;
}

/**
 * 去掉正文开头的一级标题行（连带标题前后的空行），没有则原样返回。
 * 只动正文，不碰 frontmatter——调用方拿到的正文里本来就不含 frontmatter。
 */
export function stripLeadingHeading(text: string): string {
  const raw = String(text ?? '');
  const crlf = raw.includes('\r\n');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < lines.length && !lines[head].trim()) head += 1;
  if (head >= lines.length || !LEADING_H1.test(lines[head])) return raw;
  const rest = lines.slice(head + 1);
  while (rest.length && !rest[0].trim()) rest.shift();
  const out = rest.join('\n');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

/**
 * 把文件切成「原样保留的 frontmatter 头」+「正文」，供改正文时逐字节保留元信息。
 * 不解析 YAML——重新序列化会重排用户/Agent 写下的字段与缩进，没必要冒这个险。
 */
export function splitFrontmatter(raw: string): { head: string; body: string } {
  const match = /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/.exec(String(raw ?? ''));
  if (!match) return { head: '', body: String(raw ?? '') };
  return { head: match[1], body: String(raw ?? '').slice(match[1].length) };
}

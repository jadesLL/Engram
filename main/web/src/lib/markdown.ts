function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe, deliberately small Markdown renderer for model output. Raw HTML is always escaped. */
export function renderAssistantMarkdown(value: string): string {
  const codeBlocks: string[] = [];
  let text = value.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(
      `<pre><code data-language="${escapeHtml(String(language).trim())}">${escapeHtml(String(code))}</code></pre>`
    );
    return `\n@@CODE_BLOCK_${index}@@\n`;
  });
  text = escapeHtml(text)
    .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^#\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[(S\d+)\]/g, '<sup class="cite">[$1]</sup>')
    .replace(/^[-*]\s+(.+)$/gm, '<span class="list-line">• $1</span>')
    .replace(/\n/g, '<br>');
  for (let index = 0; index < codeBlocks.length; index++) {
    text = text.replace(`@@CODE_BLOCK_${index}@@`, codeBlocks[index]);
  }
  return text;
}

/** Wiki 双链与 Markdown 标准链接之间的无损表示层。 */

const WIKI_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const MD_WIKI_RE = /\[([^\]]*)\]\(#wiki\/([^\s)]+)\)/g;

function splitOutsideCode(text: string): Array<{ text: string; code: boolean }> {
  const re = /```[\s\S]*?```|`[^`\n]*`/g;
  const parts: Array<{ text: string; code: boolean }> = [];
  let last = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), code: false });
    parts.push({ text: match[0], code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: false });
  return parts;
}

function transformOutsideCode(text: string, transform: (value: string) => string): string {
  return splitOutsideCode(text)
    .map((part) => (part.code ? part.text : transform(part.text)))
    .join('');
}

export function wikiUrl(target: string): string {
  const encoded = encodeURIComponent(target.trim())
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
  return `#wiki/${encoded}`;
}

export function markdownWikiLink(target: string, label?: string): string {
  const cleanTarget = target.trim();
  const cleanLabel = (label || cleanTarget).replace(/([\[\]])/g, '\\$1');
  return `[${cleanLabel}](${wikiUrl(cleanTarget)})`;
}

export function wikiLinksToMarkdown(markdown: string): string {
  return transformOutsideCode(markdown, (text) =>
    text.replace(WIKI_RE, (_raw, target: string, label?: string) => {
      const cleanTarget = String(target).trim();
      if (!cleanTarget) return _raw;
      return markdownWikiLink(cleanTarget, label);
    })
  );
}

export function markdownLinksToWiki(markdown: string): string {
  return transformOutsideCode(markdown, (text) =>
    text.replace(MD_WIKI_RE, (_raw, label: string, encodedTarget: string) => {
      let target = '';
      try {
        target = decodeURIComponent(encodedTarget).trim();
      } catch {
        return _raw;
      }
      if (!target) return _raw;
      const cleanLabel = label.replace(/\\([\[\]])/g, '$1');
      return cleanLabel && cleanLabel !== target ? `[[${target}|${cleanLabel}]]` : `[[${target}]]`;
    })
  );
}

export function wikiTargetFromMarkdownLink(markdown: string): string | null {
  MD_WIKI_RE.lastIndex = 0;
  const match = MD_WIKI_RE.exec(markdown);
  if (!match) return null;
  try {
    return decodeURIComponent(match[2]).trim() || null;
  } catch {
    return null;
  }
}

export function wikiTargetFromHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith('#wiki/')) return null;
  try {
    return decodeURIComponent(trimmed.slice('#wiki/'.length)).trim() || null;
  } catch {
    return null;
  }
}

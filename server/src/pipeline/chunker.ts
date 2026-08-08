export interface Chunk {
  heading: string;
  content: string;
}

/** 粗略 token 估算：中文按字、英文按词 */
function approxTokens(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const words = (text.replace(/[一-鿿]/g, ' ').match(/\S+/g) || []).length;
  return cjk + words;
}

const MAX_TOKENS = 400;
const OVERLAP = 60;

/**
 * Markdown 感知分块：按标题层级切段，超长段按段落再切，段间保留重叠。
 */
export function chunkMarkdown(markdown: string): Chunk[] {
  const lines = markdown.split('\n');
  const sections: Chunk[] = [];
  let heading = '';
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading, content: text });
    buf = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+)/);
    if (m) {
      flush();
      heading = m[2].trim();
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  for (const sec of sections) {
    if (approxTokens(sec.content) <= MAX_TOKENS) {
      chunks.push(sec);
      continue;
    }
    // 超长：按段落切分并带重叠
    const paras = sec.content.split(/\n{2,}/);
    let cur: string[] = [];
    for (const p of paras) {
      cur.push(p);
      if (approxTokens(cur.join('\n\n')) >= MAX_TOKENS) {
        chunks.push({ heading: sec.heading, content: cur.join('\n\n').trim() });
        // 重叠：保留末尾片段
        const tail = cur.join('\n\n').slice(-OVERLAP * 2);
        cur = tail ? [tail] : [];
      }
    }
    const rest = cur.join('\n\n').trim();
    if (rest) chunks.push({ heading: sec.heading, content: rest });
  }
  return chunks.filter((c) => c.content.length > 0);
}

/** 纯文本分块（docx 提取文本等） */
export function chunkPlainText(text: string): Chunk[] {
  return chunkMarkdown(text);
}

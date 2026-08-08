import JSZip from 'jszip';
import * as XLSX from 'xlsx';

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** xlsx → Markdown 表格文本（每个 sheet 一张表，供无损切分与 AI 提炼） */
export function xlsxToText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, defval: '', raw: false });
    const nonEmpty = rows.filter((r: any[]) => r.some((c: any) => String(c).trim() !== ''));
    if (!nonEmpty.length) continue;
    const table = nonEmpty
      .map((r: any[]) => `| ${r.map((c: any) => String(c).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`)
      .join('\n');
    parts.push(`## ${name}\n\n${table}`);
  }
  return parts.join('\n\n').trim();
}

/** pptx → 按页文本（解析 slide XML 中的 a:t 文本，供无损切分与 AI 提炼） */
export async function pptxToText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)![1]);
      const nb = Number(b.match(/slide(\d+)\.xml$/)![1]);
      return na - nb;
    });
  const parts: string[] = [];
  let i = 0;
  for (const name of slideNames) {
    i += 1;
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((m) => decodeXml(m[1]).trim())
      .filter(Boolean);
    if (texts.length) parts.push(`## 第 ${i} 页\n\n${texts.join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

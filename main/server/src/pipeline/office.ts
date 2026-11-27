import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { docxToText } from './docx.js';

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function excelCellText(val: unknown): string {
  if (val == null) return '';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj.richText)) return obj.richText.map((r: any) => String(r?.text ?? '')).join('');
    if ('result' in obj) return excelCellText(obj.result);
    if (typeof obj.error === 'string') return obj.error;
  }
  return String(val);
}

/** xlsx → Markdown 表格文本（每个 sheet 一张表，供无损切分与 AI 提炼） */
export async function xlsxToText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const parts: string[] = [];
  for (const ws of wb.worksheets) {
    let maxCol = ws.columnCount || 0;
    const rawRows: string[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      maxCol = Math.max(maxCol, row.cellCount || 0);
      const cells: string[] = [];
      for (let c = 1; c <= maxCol; c++) {
        cells.push(excelCellText(row.getCell(c).value));
      }
      if (cells.some((cell) => cell.trim() !== '')) {
        rawRows.push(cells);
      }
    }
    if (!rawRows.length) continue;
    const width = rawRows.reduce((m, r) => Math.max(m, r.length), 0);
    const table = rawRows
      .map((r) => {
        const padded = r.length < width ? [...r, ...Array(width - r.length).fill('')] : r;
        return `| ${padded.map((c) => c.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`;
      })
      .join('\n');
    parts.push(`## ${ws.name}\n\n${table}`);
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

/** Office 文件统一文本提取，供上传和在线编辑回写后刷新索引。 */
export async function officeToText(ext: string, buffer: Buffer): Promise<string | null> {
  if (ext === 'docx') return docxToText(buffer);
  if (ext === 'xlsx') return xlsxToText(buffer);
  if (ext === 'pptx') return pptxToText(buffer);
  return null;
}

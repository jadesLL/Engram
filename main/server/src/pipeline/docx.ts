import mammoth from 'mammoth';

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export interface ExtractedDocx {
  text: string;
  warnings: string[];
}

/** docx → 带结构的 Markdown 风格文本；标题、列表和表格保留为文本，供无损切分与提炼。 */
export async function extractDocx(buffer: Buffer): Promise<ExtractedDocx> {
  const result = await mammoth.convertToHtml({ buffer });
  const text = result.value
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_, level: string, content: string) => `${'#'.repeat(Number(level))} ${stripHtml(content)}\n\n`)
    .replace(/<li[^>]*>(.*?)<\/li>/gis, (_, content: string) => `- ${stripHtml(content)}\n`)
    .replace(/<\/(p|tr|table|ul|ol)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text,
    warnings: result.messages.map((message: { message: string }) => message.message),
  };
}

/** docx → 文本（兼容既有调用） */
export async function docxToText(buffer: Buffer): Promise<string> {
  return (await extractDocx(buffer)).text;
}

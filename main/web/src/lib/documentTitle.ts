export interface DocumentTitleParts {
  name: string;
  date: string;
  dateLabel: string;
  prefix: string;
  rawName: string;
  extension: string;
}

/** 文件名只是显示来源：日期与名称拆开，不改磁盘名称、页面 ID 或双链。 */
export function documentTitleParts(value: string): DocumentTitleParts {
  const raw = String(value || '').trim();
  const extension = raw.match(/\.(?:md|markdown)$/i)?.[0] || '';
  const bare = extension ? raw.slice(0, -extension.length) : raw;
  const match = bare.match(/^(\d{4})(?:[.-](\d{1,2})[.-](\d{1,2})|年(\d{1,2})月(\d{1,2})日)([_\s-]*)(.*)$/);
  let date = '';
  let prefix = '';
  let rawName = bare;
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2] || match[4]);
    const day = Number(match[3] || match[5]);
    const at = new Date(Date.UTC(year, month - 1, day));
    if (year >= 1000 && at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day && match[7].trim()) {
      date = `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      rawName = match[7];
      prefix = bare.slice(0, bare.length - rawName.length);
    }
  }
  return {
    name: rawName.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || '无标题',
    date,
    dateLabel: date ? `${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日` : '',
    prefix,
    rawName,
    extension,
  };
}

/** 仅在用户提交编辑时组合标题；未变的部分原样保留，避免顺手改写文件命名。 */
export function editedDocumentTitle(original: string, name: string, date: string): string {
  const parts = documentTitleParts(original);
  const cleanName = name.trim();
  if (!cleanName) return original;
  if (cleanName === parts.name && date === parts.date) return original;
  const nextName = cleanName === parts.name ? parts.rawName : cleanName;
  const prefix = date === parts.date ? parts.prefix : date ? `${date.replace(/-/g, '.')}_` : '';
  return `${prefix}${nextName}${parts.extension}`;
}

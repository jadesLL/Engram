/**
 * 语音转写的文本清洗与提示词（服务端模型 / 本机识别 / 专用 ASR 共用）。
 *
 * 单独成模块是为了让「专用 ASR 适配器」与「内置 Agent 模型转写」共用同一套清洗口径，
 * 避免两边对引号、代码围栏、「转写：」前缀的处理不一致。
 */

/** 模型约定：无人声时只输出这个哨兵值，服务端统一清成空串 */
export const NO_SPEECH_SENTINEL = 'NO_SPEECH';

/** 转写提示词：只转写、不翻译、不解释（仅对话式模型使用；专用 ASR 接口不需要） */
export const SPEECH_SYSTEM_PROMPT = [
  '你是语音转写器。把录音里的说话内容逐字转成文字：',
  '- 说话人说什么语言就写什么语言（中文写中文、英文写英文），不要翻译；',
  '- 保留语气词与自然的措辞，按语义补全标点；',
  '- 只输出转写文本本身，不要解释、总结、标题、引号、Markdown 标记或「转写：」之类的前缀；',
  '- 录音里没有可辨识的人声时，只输出 NO_SPEECH。',
].join('\n');

/** 成对引号（中英文）与反引号：只在整段被包住时剥一层，正文里的引号不动 */
const WRAPPING_QUOTES: Array<[string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * 清掉模型常见的包装：代码围栏、整段引号、「转写：」前缀；无人声哨兵值归空串。
 * 只在首尾动手，不改正文里的标点与措辞。
 */
export function cleanTranscript(raw: string): string {
  let text = String(raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  if (text === NO_SPEECH_SENTINEL || text.toLowerCase() === NO_SPEECH_SENTINEL.toLowerCase()) return '';
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  for (const [open, close] of WRAPPING_QUOTES) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length).trim();
      if (inner) text = inner;
      break;
    }
  }
  text = text.replace(/^\s*(?:转写|识别|听写)(?:结果|文本|内容)?\s*[:：]\s*/, '');
  text = text.replace(/^[（(](?:无|没有|未检测到)[^）)]*(?:语音|人声|音频)[^）)]*[）)]$/, '');
  return text.trim();
}

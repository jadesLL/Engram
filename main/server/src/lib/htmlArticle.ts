/**
 * 网页 HTML → 可读正文（收集箱转换与网页标题共用，零依赖）。
 *
 * 背景（2026-10-31）：收集箱把网页保存成 HTML 原件后，转换时曾把整份 HTML 当正文喂给模型。
 * 微信公众号文章这类页面头部有 3MB+ 内联脚本、正文要到第 500KB 之后才出现，按字符分块后
 * 模型只看到 <head> 元信息与打包脚本，转出的 Markdown 全是「脚本分析」——用户看到的乱码。
 *
 * 这里做三件事：
 * 1. 按 BOM / <meta charset> 解码字节（UTF-8、GBK/GB18030 等），避免中文网页先解码成乱码；
 * 2. 去掉脚本、样式、注释、导航等非正文内容，优先取公众号正文容器（js_content）/
 *    article / main / 常见正文容器，取不到才退回整页；
 * 3. 把正文转成保留标题层级、列表、表格与图片引用的 Markdown 风格文本，再交给模型语义转换。
 *
 * 只依赖 Node 内置能力：Docker 构建默认断网、依赖清单也不该为一条网页转换涨一个解析库。
 */

export interface HtmlArticle {
  /** 页面标题：og:title > 微信 activity-name > <title> > 首个 H1；读不到为空串 */
  title: string;
  /** 可读正文（Markdown 风格纯文本，已去噪声） */
  text: string;
  /** 正文来自哪类容器，便于测试与排障 */
  container: 'wechat' | 'zhihu' | 'article' | 'body';
  /** 发布方（公众号名 / og:site_name） */
  site: string;
  /** 作者（og:article:author / meta author / 微信作者变量） */
  author: string;
  /** 发布时间（能确定时给 YYYY-MM-DD HH:mm） */
  publishedAt: string;
  /** 页面自报的原文地址（og:url / canonical / Engram 抓取注释） */
  sourceUrl: string;
}

/* ------------------------------------------------------------------ *
 * 字符集解码
 * ------------------------------------------------------------------ */

const UTF8_BOM = [0xef, 0xbb, 0xbf];

/**
 * 把网页文件字节解码成字符串：先看 BOM，再看 <meta charset>（HTML5 只认前 1024 字节，
 * 这里放宽到 4KB 兼容老页面），最后按 UTF-8 兜底。GB2312 / GBK 统一按 GB18030 解，
 * 这是浏览器处理中文网页的同一口径。
 */
export function decodeHtmlBytes(buffer: Buffer): string {
  if (buffer.length >= 3 && UTF8_BOM.every((byte, index) => buffer[index] === byte)) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return decodeWith('utf-16le', buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeWith('utf-16be', buffer.subarray(2));
  }
  const probe = buffer.subarray(0, 4096).toString('latin1');
  const declared =
    /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([\w.-]+)/i.exec(probe)?.[1] ||
    /<meta\b[^>]*\bcontent\s*=\s*["'][^"']*\bcharset\s*=\s*([\w.-]+)/i.exec(probe)?.[1] ||
    '';
  return decodeWith(declared || 'utf-8', buffer);
}

function canonicalCharset(label: string): string {
  const lower = label.trim().toLowerCase();
  if (!lower) return 'utf-8';
  // GB2312 / GBK 的字符集是 GB18030 的子集：按超集解码不会把生僻字变成乱码
  if (lower === 'gb2312' || lower === 'gbk' || lower === 'x-gbk' || lower === 'gb_2312-80') return 'gb18030';
  if (lower === 'iso-8859-1' || lower === 'latin1' || lower === 'latin-1') return 'windows-1252';
  if (lower === 'utf-16') return 'utf-16le';
  return lower;
}

function decodeWith(label: string, buffer: Buffer): string {
  try {
    return new TextDecoder(canonicalCharset(label)).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  }
}

/* ------------------------------------------------------------------ *
 * 实体解码
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', shy: '', zwj: '\u200d', zwnj: '\u200c', ndash: '–', mdash: '—', hellip: '…',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', middot: '·', bull: '•',
  times: '×', divide: '÷', plusmn: '±', deg: '°', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', rarr: '→', larr: '←',
  uarr: '↑', darr: '↓', harr: '↔', prime: '′', Prime: '″', sect: '§', para: '¶', dagger: '†',
  Dagger: '‡', permil: '‰', euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®',
  trade: '™', check: '✓', cross: '✗', star: '★', hearts: '♥', loz: '◊',
  agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', iuml: 'ï', ntilde: 'ñ', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  Eacute: 'É', szlig: 'ß',
};

/** 解码 HTML 实体（数字实体 + 常见命名实体；未知实体原样保留，避免吞正文） */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/* ------------------------------------------------------------------ *
 * 轻量标记化：不做 DOM 树，只按标签边界切 token（零依赖、线性、容错）
 * ------------------------------------------------------------------ */

interface TextToken {
  type: 'text';
  text: string;
  start: number;
  end: number;
}

interface TagToken {
  type: 'tag';
  name: string;
  raw: string;
  closing: boolean;
  selfClosing: boolean;
  start: number;
  end: number;
}

type HtmlToken = TextToken | TagToken;

/** 内容整段丢弃的元素：脚本、样式、内嵌资源等（里面即使有 <div> 也不参与解析） */
const RAW_TEXT_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'template', 'textarea', 'title', 'xmp', 'noembed', 'noframes',
]);

/** 没有结束标签的元素 */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr', 'keygen', 'frame',
]);

function tokenize(source: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const length = source.length;
  let index = 0;
  const pushText = (start: number, end: number) => {
    if (end > start) tokens.push({ type: 'text', text: source.slice(start, end), start, end });
  };
  while (index < length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) {
      pushText(index, length);
      break;
    }
    pushText(index, lt);
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      index = close < 0 ? length : close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt);
      index = close < 0 ? length : close + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const close = source.indexOf('>', lt);
      index = close < 0 ? length : close + 1;
      continue;
    }
    const gt = source.indexOf('>', lt + 1);
    if (gt < 0) {
      pushText(lt, length);
      break;
    }
    const raw = source.slice(lt, gt + 1);
    const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(raw);
    const closing = Boolean(match?.[1]);
    const name = (match?.[2] || '').toLowerCase();
    if (name && !closing && RAW_TEXT_ELEMENTS.has(name)) {
      // 整段跳过：脚本里常有大量「看起来像标签」的字符串，不能当正文解析
      const closeRe = new RegExp('</\\s*' + name + '\\s*>', 'ig');
      closeRe.lastIndex = gt + 1;
      const close = closeRe.exec(source);
      index = close ? close.index + close[0].length : length;
      continue;
    }
    const selfClosing = VOID_ELEMENTS.has(name) || /\/\s*>$/.test(raw);
    tokens.push({ type: 'tag', name, raw, closing, selfClosing, start: lt, end: gt + 1 });
    index = gt + 1;
  }
  return tokens;
}

/** 解析标签属性（属性值里的 > 已在 tokenize 里按第一个 > 截断，网页属性里极少见） */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = raw.replace(/^<\s*\/?[^\s>]*/, '').replace(/\/?\s*>$/, '');
  const pattern = /([^\s=<>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (!(name in attrs)) attrs[name] = value;
  }
  return attrs;
}

/* ------------------------------------------------------------------ *
 * 元信息
 * ------------------------------------------------------------------ */

const META_SCAN_LIMIT = 512 * 1024;

function readMetaMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const head = html.slice(0, META_SCAN_LIMIT);
  const pattern = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(head))) {
    const attrs = parseAttrs(match[0]);
    const key = (attrs.property || attrs.name || '').trim().toLowerCase();
    if (!key) continue;
    if (attrs.content !== undefined && !map.has(key)) map.set(key, decodeHtmlEntities(attrs.content).trim());
  }
  return map;
}

function stripMarkupText(fragment: string): string {
  return decodeHtmlEntities(
    fragment
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function cleanTitle(value: string): string {
  return stripMarkupText(value).replace(/\s+/g, ' ').slice(0, 160);
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = (value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function titleTagOf(html: string): string {
  const head = html.slice(0, META_SCAN_LIMIT);
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] || '';
  return cleanTitle(raw);
}

function wechatElementTitle(html: string): string {
  const raw =
    /<h1\b[^>]*\bid\s*=\s*["']?activity-name["']?[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ||
    /<h1\b[^>]*\bclass\s*=\s*["'][^"']*\brich_media_title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ||
    '';
  return cleanTitle(raw);
}

function scriptVariable(html: string, names: string[]): string {
  for (const name of names) {
    const match = new RegExp('\\bvar\\s+' + name + '\\s*=\\s*(["\'])((?:(?!\\1)[\\s\\S])*)\\1').exec(html);
    if (match?.[2] !== undefined) {
      const value = decodeHtmlEntities(match[2]).trim();
      if (value) return value;
    }
  }
  return '';
}

function formatWechatTimestamp(seconds: string): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  // 公众号页面里的 ct 是发布时刻的 Unix 秒；公众号发布用中国时间，固定按 +8 展示，
  // 避免容器（UTC）与桌面端（本机时区）转出不同日期。
  const date = new Date((value + 8 * 3600) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
    ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
}

function publishedAtOf(html: string, meta: Map<string, string>): string {
  const declared = firstNonEmpty(
    meta.get('article:published_time'),
    meta.get('og:article:published_time'),
    meta.get('date'),
  );
  if (declared) return declared.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/([+-]\d{2}:\d{2})$/, '').trim();
  const ct = scriptVariable(html, ['ct']);
  if (/^\d{9,11}$/.test(ct)) return formatWechatTimestamp(ct);
  const em = /<em\b[^>]*\bid\s*=\s*["']?publish_time["']?[^>]*>([\s\S]*?)<\/em\s*>/i.exec(html)?.[1];
  return em ? cleanTitle(em) : '';
}

function siteOf(html: string, meta: Map<string, string>): string {
  const nickname = scriptVariable(html, ['nickname']);
  const jsName =
    /<a\b[^>]*\bid\s*=\s*["']?js_name["']?[^>]*>([\s\S]*?)<\/a\s*>/i.exec(html)?.[1] ||
    /<span\b[^>]*\bid\s*=\s*["']?js_name["']?[^>]*>([\s\S]*?)<\/span\s*>/i.exec(html)?.[1] ||
    '';
  const accountName = firstNonEmpty(jsName ? cleanTitle(jsName) : '', nickname);
  // 公众号页面的 og:site_name 固定是「微信公众平台」，账号名在 js_name 里，优先用账号名
  if (accountName) return accountName;
  return firstNonEmpty(meta.get('og:site_name'), meta.get('application-name'));
}

function authorOf(html: string, meta: Map<string, string>): string {
  const jsAuthor =
    /<span\b[^>]*\bid\s*=\s*["']?js_author_name["']?[^>]*>([\s\S]*?)<\/span\s*>/i.exec(html)?.[1] || '';
  return firstNonEmpty(
    meta.get('og:article:author'),
    meta.get('article:author'),
    meta.get('author'),
    jsAuthor ? cleanTitle(jsAuthor) : '',
    scriptVariable(html, ['author']),
  );
}

function sourceUrlOf(html: string, meta: Map<string, string>): string {
  const canonical = /<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/i.exec(html.slice(0, META_SCAN_LIMIT))?.[0];
  const canonicalHref = canonical ? parseAttrs(canonical).href || '' : '';
  const engramComment = /<!--\s*Engram source URL:\s*(\S+?)\s*-->/i.exec(html)?.[1] || '';
  return firstNonEmpty(
    meta.get('og:url'),
    meta.get('twitter:url'),
    canonicalHref ? decodeHtmlEntities(canonicalHref).trim() : '',
    engramComment,
  );
}

/** 页面标题（网页抓取取名与正文提取共用）：og:title > 微信 activity-name > <title> > 首个 H1 */
export function htmlTitle(html: string): string {
  const meta = readMetaMap(html);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  return firstNonEmpty(
    meta.get('og:title'),
    meta.get('twitter:title'),
    wechatElementTitle(html),
    titleTagOf(html),
    h1 ? cleanTitle(h1) : '',
  );
}

/* ------------------------------------------------------------------ *
 * 正文容器定位
 * ------------------------------------------------------------------ */

function visibleTextLength(source: string): number {
  return source
    .replace(/<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-zA-Z#0-9]+;/g, 'x')
    .replace(/\s+/g, '')
    .length;
}

/** 取第一个满足条件的元素的 innerHTML（按同名标签深度配对；未闭合时取到结尾） */
function findElementInner(source: string, tokens: HtmlToken[], match: (token: TagToken) => boolean): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'tag' || token.closing || token.selfClosing) continue;
    if (!match(token)) continue;
    let depth = 1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const inner = tokens[cursor];
      if (inner.type !== 'tag' || inner.name !== token.name) continue;
      if (inner.closing) depth -= 1;
      else if (!inner.selfClosing) depth += 1;
      if (depth === 0) return source.slice(token.end, inner.start);
    }
    return source.slice(token.end);
  }
  return null;
}

const CONTENT_ID_PATTERN =
  /\bid\s*=\s*["']?(?:content|article|article_content|articlecontent|post|post-content|main-content|content_views|js_article|detail-content|news-content)\b/i;
const CONTENT_CLASS_PATTERN =
  /\bclass\s*=\s*["'][^"']*(?:article-content|article-body|post-content|post-body|entry-content|rich_media_content|markdown-body|story-body|news-content|detail-content|content-body|content-views)[^"']*["']/i;

const WECHAT_CONTENT_MATCH = (token: TagToken): boolean =>
  /\bid\s*=\s*["']?js_content\b/i.test(token.raw) ||
  /\bclass\s*=\s*["'][^"']*\brich_media_content\b[^"']*["']/i.test(token.raw);

/** class 属性里是否有某个**完整**类名（Post-RichText 不能匹配到 Post-RichTextContainer） */
function hasClassToken(raw: string, token: string): boolean {
  const className = parseAttrs(raw).class || '';
  return className.split(/\s+/).some((item) => item === token);
}

/** 知乎专栏文章正文：div.Post-RichText（外层 .Post-RichTextContainer 仅作为兜底） */
const ZHIHU_POST_TEXT_MATCH = (token: TagToken): boolean => hasClassToken(token.raw, 'Post-RichText');
const ZHIHU_POST_CONTAINER_MATCH = (token: TagToken): boolean => hasClassToken(token.raw, 'Post-RichTextContainer');
/** 知乎问答/答案页正文：每个回答一个 .RichContent-inner，取可见文字最多的那个 */
const ZHIHU_ANSWER_MATCH = (token: TagToken): boolean => hasClassToken(token.raw, 'RichContent-inner');

/** 知乎页面 <title> 末尾带站名后缀（「如何正确使用知乎？ - 知乎」）：抽正文标题时去掉 */
function stripZhihuSiteSuffix(title: string): string {
  const stripped = title.replace(/\s*[-–—_|·]\s*知乎(?:网|专栏)?\s*$/u, '').trim();
  return stripped || title;
}

const TAG_CONTENT_MATCH = (token: TagToken): boolean =>
  token.name === 'article' || token.name === 'main' ||
  /\brole\s*=\s*["']?main\b/i.test(token.raw) ||
  /\bitemtype\s*=\s*["'][^"']*Article["']/i.test(token.raw) ||
  CONTENT_ID_PATTERN.test(token.raw);

function contentContainerMatches(token: TagToken): boolean {
  return TAG_CONTENT_MATCH(token) || CONTENT_CLASS_PATTERN.test(token.raw);
}

/** 在候选容器里挑可见文字最多的那个（避免误取「文章目录 / 相关阅读」小容器） */
function largestElementInner(
  source: string,
  tokens: HtmlToken[],
  match: (token: TagToken) => boolean,
  minLength: number
): string | null {
  let best: { length: number; inner: string } | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'tag' || token.closing || token.selfClosing) continue;
    if (!match(token)) continue;
    const inner = findElementInner(source, tokens, (candidate) => candidate === token);
    if (!inner) continue;
    const length = visibleTextLength(inner);
    if (!best || length > best.length) best = { length, inner };
  }
  return best && best.length >= minLength ? best.inner : null;
}

/** 语义容器 <article>/<main> 优先；即使短文（标题 + 两段话）也认 */
const ARTICLE_TAG_MATCH = (token: TagToken): boolean => token.name === 'article' || token.name === 'main';

/** 靠 id/class 认出的正文容器门槛高一些：目录、摘要小卡片也常带 content/post 之类 class */
function otherContentContainerMatches(token: TagToken): boolean {
  if (ARTICLE_TAG_MATCH(token)) return false;
  return contentContainerMatches(token);
}

function bodyInner(html: string, tokens: HtmlToken[]): string {
  const inner = findElementInner(html, tokens, (token) => token.name === 'body');
  return inner && visibleTextLength(inner) > 0 ? inner : html;
}

/* ------------------------------------------------------------------ *
 * 正文渲染：HTML → 保留结构的 Markdown 风格文本
 * ------------------------------------------------------------------ */

const SKIP_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'object', 'embed', 'iframe',
  'video', 'audio', 'source', 'track', 'form', 'button', 'input', 'select', 'option', 'textarea',
  'link', 'meta', 'base', 'col', 'param', 'map', 'area', 'dialog', 'nav', 'aside', 'footer',
]);

/** 整页兜底时剔除的网站框架（文章容器内不按 class 剔，避免误伤正文小节） */
const CHROME_WORDS = new Set([
  'nav', 'navbar', 'navigation', 'menu', 'footer', 'header', 'sidebar', 'breadcrumb', 'breadcrumbs',
  'comment', 'comments', 'share', 'related', 'recommend', 'recommendation', 'pagination', 'pager',
  'banner', 'advert', 'advertisement', 'ads', 'ad', 'toolbar', 'login', 'subscribe', 'qrcode',
]);

function chromeElement(raw: string): boolean {
  const attrs = parseAttrs(raw);
  const classes = (attrs.class || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (classes.some((item) => CHROME_WORDS.has(item))) return true;
  const id = (attrs.id || '').toLowerCase();
  if (!id) return false;
  if (CHROME_WORDS.has(id)) return true;
  return /(^|[-_])(?:nav|navbar|menu|footer|header|sidebar|breadcrumb|comment|comments|share|related|recommend|pagination|pager|banner|advert|ads?|toolbar|login|subscribe|qrcode)($|[-_])/.test(id);
}

const BLOCK_ELEMENTS = new Set([
  'p', 'div', 'section', 'article', 'header', 'main', 'figure', 'figcaption', 'blockquote', 'ul', 'ol',
  'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'form', 'fieldset', 'details',
  'summary', 'address', 'center', 'pre',
]);

const HEADING_ELEMENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** 公众号页面里的尾部署名/引导语（整块命中才丢，避免误删正文短句） */
const UI_TAIL_BLOCKS = new Set([
  '预览时标签不可点', '继续滑动看下一个', '向上滑动看下一个', '轻点两下取消赞', '轻点两下取消在看',
  '轻点两下取消赞在看', '分享到朋友圈', '微信扫一扫', '长按识别二维码', '长按识别二维码关注',
  '长按二维码关注', '识别二维码', '关注该公众号', '关注我们', '写留言', '留言', '赞', '在看',
  '分享', '收藏', '举报', '阅读原文', '返回', '上一篇', '下一篇', '相关阅读', '预览时标签不可点。',
]);

function renderTable(rows: string[][]): string {
  const columns = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]): string =>
    '| ' + Array.from({ length: columns }, (_, index) => (row[index] || '').replace(/\|/g, '\\|')).join(' | ') + ' |';
  const header = line(rows[0]);
  const separator = '| ' + Array.from({ length: columns }, () => '---').join(' | ') + ' |';
  return [header, separator, ...rows.slice(1).map(line)].join('\n');
}

function renderHtml(source: string, options: { stripChrome: boolean }): string {
  const tokens = tokenize(source);
  const blocks: string[] = [];
  let buffer = '';
  let headingLevel = 0;
  let listPrefix = '';
  let preDepth = 0;
  /** 正在跳过的元素栈：脚本/样式/导航等，按标签名配对退出，不会把后文整段吞掉 */
  const skipStack: string[] = [];
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  const linkStack: Array<{ start: number; href: string }> = [];

  const flush = () => {
    if (cell !== null) {
      if (buffer.trim()) cell += ' ' + buffer;
      buffer = '';
      return;
    }
    if (preDepth > 0) {
      const preserved = buffer.replace(/^[ \t]*\n+/, '').replace(/\s+$/, '');
      buffer = '';
      if (preserved.trim()) blocks.push(preserved.replace(/\n{3,}/g, '\n\n'));
      return;
    }
    const text = buffer.replace(/[\s\u00a0]+/g, ' ').trim();
    buffer = '';
    if (!text) {
      headingLevel = 0;
      listPrefix = '';
      return;
    }
    const prefix = headingLevel ? '#'.repeat(Math.min(headingLevel, 6)) + ' ' : listPrefix;
    blocks.push(prefix + text);
    headingLevel = 0;
    listPrefix = '';
  };

  for (const token of tokens) {
    if (token.type === 'text') {
      if (skipStack.length > 0) continue;
      const text = decodeHtmlEntities(token.text);
      if (cell !== null) cell += text;
      else buffer += text;
      continue;
    }
    const name = token.name;
    if (!name) continue;
    if (skipStack.length > 0) {
      // 跳过区内也要按同名标签配对：跳过容器里嵌的 <div> 不能把外层 <div> 提前关掉
      const top = skipStack[skipStack.length - 1];
      if (token.closing) {
        if (name === top) skipStack.pop();
      } else if (!token.selfClosing && name === top) {
        skipStack.push(name);
      }
      continue;
    }
    if (SKIP_ELEMENTS.has(name)) {
      if (!token.closing && !token.selfClosing) skipStack.push(name);
      continue;
    }
    // 整页兜底时把站点导航/页脚/侧栏整块剔掉；文章容器（article/main）本身永不剔除
    if (
      options.stripChrome && !token.closing && !token.selfClosing && name !== 'article' && name !== 'main' &&
      chromeElement(token.raw)
    ) {
      skipStack.push(name);
      continue;
    }
    if (HEADING_ELEMENTS.has(name)) {
      if (token.closing) flush();
      else {
        flush();
        headingLevel = Number(name[1]);
      }
      continue;
    }
    if (name === 'br') {
      if (cell !== null) cell += ' ';
      else flush();
      continue;
    }
    if (name === 'hr') {
      flush();
      blocks.push('---');
      continue;
    }
    if (name === 'img') {
      if (token.closing) continue;
      const attrs = parseAttrs(token.raw);
      const src = decodeHtmlEntities(attrs['data-src'] || attrs.src || '').trim();
      const alt = decodeHtmlEntities(attrs.alt || attrs['data-alt'] || '').replace(/[\[\]]/g, '').trim();
      const className = (attrs['class'] || '').toLowerCase();
      if (!src || /^data:/i.test(src) || className.includes('emoji') || /\/we-emoji\//i.test(src)) continue;
      const markdown = '![' + alt + '](' + src + ')';
      if (cell !== null) cell += markdown;
      else buffer += markdown;
      continue;
    }
    if (name === 'a') {
      if (token.closing) {
        const link = linkStack.pop();
        if (link && link.start <= buffer.length) {
          const text = buffer.slice(link.start);
          const href = link.href.trim();
          if (href && /^https?:\/\//i.test(href) && text.trim() && !text.trim().startsWith('[')) {
            buffer = buffer.slice(0, link.start) + '[' + text.trim().slice(0, 200) + '](' + href + ')';
          }
        }
        continue;
      }
      linkStack.push({ start: buffer.length, href: decodeHtmlEntities(parseAttrs(token.raw).href || '') });
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (token.closing) {
        flush();
        if (cell !== null && row) row.push(cell.replace(/[\s\u00a0]+/g, ' ').trim());
        cell = null;
      } else {
        flush();
        cell = '';
      }
      continue;
    }
    if (name === 'tr') {
      if (token.closing) {
        flush();
        if (row && row.some((item) => item)) (table ||= []).push(row);
        row = null;
      } else {
        flush();
        row = [];
      }
      continue;
    }
    if (name === 'table') {
      if (!token.closing) {
        flush();
        table = [];
      } else if (table) {
        flush();
        if (table.length) blocks.push(renderTable(table));
        table = null;
      }
      continue;
    }
    if (name === 'li') {
      if (token.closing) flush();
      else {
        flush();
        listPrefix = '- ';
      }
      continue;
    }
    if (name === 'pre') {
      if (token.closing) {
        flush();
        preDepth = Math.max(0, preDepth - 1);
      } else {
        flush();
        preDepth += 1;
      }
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) {
      flush();
      continue;
    }
  }
  flush();

  const cleaned = blocks
    .map((block) => block.replace(/\u200b/g, '').replace(/[ \t]+$/gm, '').trim())
    .filter((block) => block && !UI_TAIL_BLOCKS.has(block.replace(/^#+\s*/, '').trim()));
  return cleaned.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------ *
 * 对外主入口
 * ------------------------------------------------------------------ */

/** HTML → 可读正文（微信 / 知乎 / 通用文章 / 整页兜底；都取不到时 text 为空串） */
export function extractHtmlArticle(html: string): HtmlArticle {
  const metadata = readMetaMap(html);
  const sourceUrl = sourceUrlOf(html, metadata);
  const tokens = tokenize(html);
  const looksWechat =
    /mp\.weixin\.qq\.com/i.test(sourceUrl) || /id\s*=\s*["']?js_content\b/i.test(html) || /rich_media_content/i.test(html);
  // 知乎判定多路兜底：来源链接、页面开头的 canonical/og:url、站名，或正文容器的特征类名
  const looksZhihu =
    /zhihu\.com/i.test(sourceUrl) ||
    /zhihu\.com/i.test(html.slice(0, 4096)) ||
    /^知乎(?:网|专栏)?$/.test((metadata.get('og:site_name') || '').trim()) ||
    /\b(?:Post-RichText(?:Container)?|RichContent-inner)\b/.test(html) ||
    /\bzse-ck\b/i.test(html);

  let container: HtmlArticle['container'] = 'body';
  let inner: string | null = null;
  const wechat = looksWechat ? findElementInner(html, tokens, WECHAT_CONTENT_MATCH) : null;
  if (wechat && visibleTextLength(wechat) >= 40) {
    inner = wechat;
    container = 'wechat';
  }
  if (!inner && looksZhihu) {
    // 专栏文章取 .Post-RichText（推荐阅读等都在容器外）；问答页每个回答一个 .RichContent-inner，取最长的那条。
    const zhihu =
      largestElementInner(html, tokens, ZHIHU_POST_TEXT_MATCH, 40) ||
      largestElementInner(html, tokens, ZHIHU_ANSWER_MATCH, 40) ||
      largestElementInner(html, tokens, ZHIHU_POST_CONTAINER_MATCH, 40);
    if (zhihu) {
      inner = zhihu;
      container = 'zhihu';
    }
  }
  if (!inner) {
    const article =
      largestElementInner(html, tokens, ARTICLE_TAG_MATCH, 10) ||
      largestElementInner(html, tokens, otherContentContainerMatches, 40);
    if (article) {
      inner = article;
      container = 'article';
    }
  }
  if (!inner) inner = bodyInner(html, tokens);

  let text = renderHtml(inner, { stripChrome: container === 'body' });
  // 正文容器里只剩壳（图片站 / 结构异常）时退回整页，宁可多带点导航也别丢正文
  if (visibleTextLength(text) < 40 && container !== 'body') {
    text = renderHtml(bodyInner(html, tokens), { stripChrome: true });
    container = 'body';
  }

  const title = htmlTitle(html);
  return {
    // 知乎页面的 <title> 带站名后缀，只对知乎页去掉，其它站点保持原文标题
    title: looksZhihu ? stripZhihuSiteSuffix(title) : title,
    text,
    container,
    site: siteOf(html, metadata),
    author: authorOf(html, metadata),
    publishedAt: publishedAtOf(html, metadata),
    sourceUrl,
  };
}

/**
 * 正文 + 元信息拼成给模型的「原件正文」。
 *
 * 不要把 og:description 之类摘要塞进来：公众号摘要常是截断的（实测最后少半句），
 * 模型会拿它当结论复述，正文反而不被使用。
 */
export function htmlArticleToPrompt(article: HtmlArticle): string {
  const lines: string[] = [];
  if (article.title) lines.push('原文标题：' + article.title);
  if (article.site) lines.push('发布方：' + article.site);
  if (article.author && article.author !== article.site) lines.push('作者：' + article.author);
  if (article.publishedAt) lines.push('发布时间：' + article.publishedAt);
  if (article.sourceUrl) lines.push('原文链接：' + article.sourceUrl);
  const head = lines.length ? lines.join('\n') + '\n\n' : '';
  return head + article.text;
}

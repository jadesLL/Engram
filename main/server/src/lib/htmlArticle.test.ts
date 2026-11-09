import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeHtmlBytes,
  decodeHtmlEntities,
  extractHtmlArticle,
  htmlArticleToPrompt,
  htmlTitle,
} from './htmlArticle.js';

/**
 * 网页正文提取（2026-10-31 微信文章转换乱码回归）。
 *
 * 真实公众号页面结构：<head> 里有 3MB+ 内联脚本、<title> 是空的、正文在
 * div#js_content（默认 visibility: hidden，靠脚本显示）。旧实现把整份 HTML 当正文，
 * 分块后模型只看到脚本，转出的 Markdown 全是代码分析。
 */

/** 造一份结构近似公众号文章的页面（HTML 总量 ~250KB，正文只占其中一小段） */
function wechatHtml(): string {
  const scriptNoise = 'var mod=function(){return "<div>假标签</div>";};'.repeat(6000);
  return [
    '<!DOCTYPE html><html><head>',
    '<meta charset="utf-8">',
    '<meta name="wechat-enable-text-zoom-em" content="true">',
    '<title></title>',
    '<meta property="og:title" content="公众号测试文章：IRT 与确定性">',
    '<meta property="og:url" content="https://mp.weixin.qq.com/s/abc123">',
    '<meta property="og:site_name" content="微信公众平台">',
    '<script>' + scriptNoise + '</script>',
    '</head><body>',
    '<div id="page-content">',
    '<h1 class="rich_media_title" id="activity-name"><span class="js_title_inner">公众号测试文章：IRT 与确定性</span></h1>',
    '<div id="meta_content" class="rich_media_meta_list"><span id="profileBt"><a id="js_name">测试公众号</a></span></div>',
    '<div class="rich_media_content" id="js_content" style="visibility: hidden; opacity: 0; ">',
    '<p><span>一句话结论：IRT 不是更快的 RT，而是硬件级确定性。</span></p>',
    '<p><img data-src="https://mmbiz.qpic.cn/demo.jpg?wx_fmt=jpeg&amp;from=appmsg" alt="示意图" class="rich_pages wxw-img" /></p>',
    '<h2>01 关键差异</h2>',
    '<p>RT 的抖动是毫秒级，IRT 是微秒级。</p>',
    '<ul><li>硬件时间戳</li><li>双端口以太网</li></ul>',
    '<p>预览时标签不可点</p>',
    '</div>',
    '<div id="js_bottom" class="rich_media_tool"><a>赞</a><a>在看</a></div>',
    '</div>',
    '<script>var ct = "1762701752";</script>',
    '</body></html>',
  ].join('');
}

function expectedWechatDate(): string {
  const date = new Date((1762701752 + 8 * 3600) * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
    ' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes());
}

test('公众号文章：只取 js_content 正文，标题/账号/发布时间/链接从元信息补齐，脚本不进正文', () => {
  const article = extractHtmlArticle(wechatHtml());
  assert.equal(article.container, 'wechat');
  assert.equal(article.title, '公众号测试文章：IRT 与确定性', '空 <title> 时用 og:title，不能用 URL 文件名');
  assert.equal(article.site, '测试公众号', '公众号账号名在 js_name 里，og:site_name 是「微信公众平台」');
  assert.equal(article.publishedAt, expectedWechatDate(), '发布时刻从 ct（Unix 秒）按北京时间还原');
  assert.equal(article.sourceUrl, 'https://mp.weixin.qq.com/s/abc123');

  assert.match(article.text, /一句话结论：IRT 不是更快的 RT/);
  assert.match(article.text, /## 01 关键差异/, 'h2 保留为二级标题');
  assert.match(article.text, /- 硬件时间戳/, '列表保留为 Markdown 列表');
  assert.match(article.text, /!\[示意图\]\(https:\/\/mmbiz\.qpic\.cn\/demo\.jpg\?wx_fmt=jpeg&from=appmsg\)/, '正文图片用 data-src 并解码实体');
  assert.doesNotMatch(article.text, /假标签|function\(\)|webpack|<script|font-size/i, '内联脚本与样式不能进正文');
  assert.doesNotMatch(article.text, /预览时标签不可点/, '公众号尾部引导语要清掉');
  assert.doesNotMatch(article.text, /js_bottom|rich_media_tool/);
  assert.ok(article.text.length < 3000, '正文长度应与文章内容量级一致，而不是整份 HTML');

  const prompt = htmlArticleToPrompt(article);
  assert.match(prompt, /^原文标题：公众号测试文章/);
  assert.match(prompt, /发布方：测试公众号/);
  assert.match(prompt, /发布时间：/);
  assert.match(prompt, /原文链接：https:\/\/mp\.weixin\.qq\.com\/s\/abc123/);
  assert.match(prompt, /一句话结论/);
  assert.doesNotMatch(prompt, /微信公众平台/, '不要拿 og:site_name 当发布方');
});

test('通用文章页：优先 article 容器，站点导航/页脚不进正文，表格转 Markdown', () => {
  const html = [
    '<!doctype html><html><head><title>站点 - 通用文章</title>',
    '<meta property="og:title" content="通用文章标题"></head><body>',
    '<div class="header">站点导航</div>',
    '<nav><a href="/">首页</a><a href="/about">关于</a></nav>',
    '<article><h1>通用文章标题</h1>',
    '<p>这是文章正文，应该被完整保留。</p>',
    '<h2>小节</h2><p>第二段正文。</p>',
    '<table><tr><th>项目</th><th>说明</th></tr><tr><td>甲</td><td>乙</td></tr></table>',
    '</article>',
    '<div class="footer">版权所有 2026</div><footer>页脚链接</footer>',
    '</body></html>',
  ].join('');
  const article = extractHtmlArticle(html);
  assert.equal(article.container, 'article');
  assert.equal(article.title, '通用文章标题');
  assert.match(article.text, /这是文章正文，应该被完整保留。/);
  assert.match(article.text, /^## 小节/m);
  assert.match(article.text, /\| 项目 \| 说明 \|/);
  assert.match(article.text, /\| 甲 \| 乙 \|/);
  assert.doesNotMatch(article.text, /站点导航|首页|关于|版权所有|页脚链接/);
});

test('找不到 article/main 时退回整页，但剔除站点 header/nav/footer 框架', () => {
  const html = [
    '<!doctype html><html><head><title>无容器页面</title></head><body>',
    '<div class="header">站点名</div>',
    '<nav>首页 产品 联系</nav>',
    '<div><p>第一段正文内容，比较长，应该被保留下来。</p><p>第二段正文内容，同样应该保留。</p></div>',
    '<footer>版权所有</footer>',
    '</body></html>',
  ].join('');
  const article = extractHtmlArticle(html);
  assert.equal(article.container, 'body');
  assert.match(article.text, /第一段正文内容/);
  assert.match(article.text, /第二段正文内容/);
  assert.doesNotMatch(article.text, /站点名|首页 产品|版权所有/);
});

test('GBK / GB2312 页面按声明字符集解码，不先解成乱码', () => {
  const prefix = Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'latin1');
  // 「中文资料」的 GBK 字节
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xca, 0xc1, 0xcf]);
  const suffix = Buffer.from('</p></body></html>', 'latin1');
  const decoded = decodeHtmlBytes(Buffer.concat([prefix, gbk, suffix]));
  assert.match(decoded, /中文资料/);
  assert.match(extractHtmlArticle(decoded).text, /中文资料/);

  // http-equiv 写法（老站点常见）
  const legacy = Buffer.concat([
    Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body><p>', 'latin1'),
    gbk,
    suffix,
  ]);
  assert.match(decodeHtmlBytes(legacy), /中文资料/);
});

test('标题兜底顺序：og:title > 微信 activity-name > <title> > 首个 H1', () => {
  assert.equal(
    htmlTitle('<html><head><title></title><meta property="og:title" content="OG 标题"></head></html>'),
    'OG 标题'
  );
  assert.equal(
    htmlTitle('<html><head></head><body><h1 id="activity-name"><span>微信标题</span></h1></body></html>'),
    '微信标题'
  );
  assert.equal(htmlTitle('<html><head><title>普通标题</title></head></html>'), '普通标题');
  assert.equal(htmlTitle('<html><head></head><body><h1>正文一级标题</h1></body></html>'), '正文一级标题');
});

test('实体解码：数字实体与命名实体都还原，未知实体原样保留', () => {
  assert.equal(decodeHtmlEntities('甲&amp;乙&nbsp;&#39;丙&#x27;&hearts;'), "甲&乙 '丙'♥");
  assert.equal(decodeHtmlEntities('&not-a-real-entity;'), '&not-a-real-entity;');
});

test('只有脚本/样式的页面提取为空正文（由转换链路给出明确提示，而不是喂脚本）', () => {
  const html = '<!doctype html><html><head><title>x</title><script>var a = 1;</script></head><body><script>var b = 2;</script></body></html>';
  assert.equal(extractHtmlArticle(html).text, '');
});

/**
 * 知乎（2026-11 收集箱抓知乎链接）：服务端直抓被 403 挡下后，由客户端内置浏览器渲染成
 * HTML 再上传。渲染后的页面同样带着「推荐阅读 / 相关问题 / 页头」这些站点框架，
 * 转换时必须只取正文容器，标题也不能带「 - 知乎」站名后缀入库。
 */
function zhihuArticleHtml(): string {
  const paragraph = '这段是知乎专栏正文：先把问题拆开，再给出可执行的结论和例子。';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>如何正确使用知乎？ - 知乎</title>',
    '<meta property="og:url" content="https://zhuanlan.zhihu.com/p/123456">',
    '<meta property="og:site_name" content="知乎">',
    '</head><body>',
    '<header class="AppHeader">知乎 首页 发现 等你来答</header>',
    '<div class="Post-RichTextContainer">',
    '<div class="RichText ztext Post-RichText">',
    '<p>' + paragraph.repeat(3) + '</p>',
    '<h2>一、先说结论</h2>',
    '<p>' + paragraph + '</p>',
    '</div>',
    '</div>',
    '<div class="Recommendations">',
    '<div class="Recommendation-list">推荐阅读：另一篇专栏文章</div>',
    '<div class="Recommendation-list">推荐阅读：再一篇专栏文章</div>',
    '</div>',
    '</body></html>',
  ].join('');
}

test('知乎专栏文章：只取 Post-RichText 正文，推荐阅读/页头不进正文，标题去掉「 - 知乎」', () => {
  const article = extractHtmlArticle(zhihuArticleHtml());
  assert.equal(article.container, 'zhihu');
  assert.equal(article.title, '如何正确使用知乎？');
  assert.match(article.text, /这段是知乎专栏正文/);
  assert.match(article.text, /^## 一、先说结论/m, '正文 h2 保留为二级标题');
  assert.doesNotMatch(article.text, /推荐阅读|AppHeader|等你来答/, '推荐阅读与页头属于站点框架');
  assert.ok(article.text.length < 2000, '正文长度应与文章内容量级一致，而不是整份 HTML');
});

function zhihuQuestionHtml(): string {
  const bestAnswer = '这是获赞最多的回答正文：先列背景，再给分析和可执行建议，最后补一句边界条件。';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>如何评价 Engram 的收集箱？ - 知乎</title>',
    '</head><body>',
    '<div class="QuestionHeader"><h1 class="QuestionHeader-title">如何评价 Engram 的收集箱？</h1>',
    '<div class="QuestionHeader-detail">问题描述：收集箱好不好用</div></div>',
    '<div class="Question-main">',
    '<div class="Question-sideColumn">',
    '<div class="QuestionSidebar">相关问题：侧栏噪声问题一</div>',
    '<div class="QuestionSidebar">相关问题：侧栏噪声问题二</div>',
    '</div>',
    '<div class="List">',
    '<div class="List-item"><div class="RichContent">',
    '<div class="RichContent-inner"><span class="RichText ztext">' + bestAnswer.repeat(4) + '</span></div>',
    '</div></div>',
    '<div class="List-item"><div class="RichContent">',
    '<div class="RichContent-inner"><span class="RichText ztext">另一个靠后的短回答，不该被选中。</span></div>',
    '</div></div>',
    '</div>',
    '</div>',
    '</body></html>',
  ].join('');
}

test('知乎问答页：取可见文字最多的 RichContent-inner，侧栏与问题头不进正文', () => {
  const article = extractHtmlArticle(zhihuQuestionHtml());
  assert.equal(article.container, 'zhihu');
  assert.equal(article.title, '如何评价 Engram 的收集箱？');
  assert.match(article.text, /获赞最多的回答正文/);
  assert.match(article.text, /边界条件/);
  assert.doesNotMatch(article.text, /侧栏噪声|问题描述|另一个靠后的短回答|QuestionHeader/);
});

test('站名后缀只对知乎去掉：其它站点标题保持原样', () => {
  const html = '<!doctype html><html><head><title>某篇文章 - 某技术站</title></head><body><article><p>'
    + '正文内容足够长，应该被 article 容器提取出来。'.repeat(4) + '</p></article></body></html>';
  const article = extractHtmlArticle(html);
  assert.equal(article.title, '某篇文章 - 某技术站');
  assert.equal(article.container, 'article');
});

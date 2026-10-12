/**
 * 收集箱「渲染后抓取」：服务端抓到 JS 空壳页时以 code=needs-render 拒绝（正文要等浏览器执行脚本
 * 才出现，如小黑盒帖子分享页）。这时用运行环境自带的浏览器把页面渲染出来，再把渲染后的 HTML
 * 当作原件存进收集箱——与「浏览器另存为 HTML」等价，产出的仍是普通 web 原件。
 *
 * 两个端各有自己的桥，纯浏览器 / Docker 网页端没有桥（保持服务端的明确报错）：
 *  - 桌面端：preload 暴露的 `window.wikiDesktop.renderInboxUrl`（Electron 隐藏窗口，见 desktop/lib/inbox-render.js）；
 *  - 手机端：安卓壳注入的 `window.EngramInboxRender.render(requestId, url)`，结果经
 *    `window.__engramInboxRenderResult(requestId, payload)` 回填（与生物识别桥同一套模式）。
 */

export interface RenderedPage {
  html: string;
  title: string;
  url: string;
}

export interface LocalRenderer {
  /** 界面提示用：哪个端帮你渲染的 */
  label: string;
  render(url: string): Promise<RenderedPage>;
}

/** 手机端渲染等待上限：比桌面端（30 秒）宽一点，弱网手机上加载更慢 */
export const ANDROID_RENDER_TIMEOUT_MS = 45_000;

type AnyWindow = Record<string, any>;

function currentWindow(): AnyWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as AnyWindow);
}

export function desktopRenderer(): LocalRenderer | null {
  const bridge = currentWindow()?.wikiDesktop;
  if (!bridge || typeof bridge.renderInboxUrl !== 'function') return null;
  return {
    label: '桌面端',
    render: (url) => bridge.renderInboxUrl(url) as Promise<RenderedPage>,
  };
}

export function androidRenderer(timeoutMs = ANDROID_RENDER_TIMEOUT_MS): LocalRenderer | null {
  const win = currentWindow();
  const bridge = win?.EngramInboxRender;
  if (!win || !bridge || typeof bridge.render !== 'function') return null;
  return {
    label: '手机端',
    render: (url) =>
      new Promise<RenderedPage>((resolve, reject) => {
        const requestId = `inbox-render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const previous = win.__engramInboxRenderResult;
        const finish = (fn: () => void) => {
          clearTimeout(timer);
          // 只回收自己装上的回调：并发渲染时别把后来者的处理器抹掉
          if (win.__engramInboxRenderResult === handler) win.__engramInboxRenderResult = previous;
          fn();
        };
        const timer = setTimeout(() => finish(() => reject(new Error('页面渲染超时'))), timeoutMs);
        const handler = (id: string, payload: string) => {
          if (id !== requestId) return;
          finish(() => {
            try {
              const data = JSON.parse(payload || '{}');
              if (data && data.ok) {
                resolve({ html: String(data.html || ''), title: String(data.title || ''), url: String(data.url || url) });
              } else {
                reject(new Error(String((data && data.error) || '渲染失败')));
              }
            } catch {
              reject(new Error('渲染结果无法解析'));
            }
          });
        };
        win.__engramInboxRenderResult = handler;
        try {
          bridge.render(requestId, url);
        } catch (error: any) {
          finish(() => reject(error instanceof Error ? error : new Error('渲染失败')));
        }
      }),
  };
}

/** 当前运行环境可用的渲染器；桌面端优先（同机若有两个桥也只可能命中一个） */
export function localRenderer(): LocalRenderer | null {
  return desktopRenderer() || androidRenderer();
}

/** 渲染结果的文件名：优先页面标题，没有标题就退回域名；扩展名固定 .html */
function renderedFileName(page: RenderedPage, originalUrl: string): string {
  const raw = (page.title || '').trim();
  if (raw) return `${raw.slice(0, 80)}.html`;
  try {
    return `${new URL(page.url || originalUrl).hostname}.html`;
  } catch {
    return '网页.html';
  }
}

/**
 * 渲染结果包成上传用的表单：文件名按页面标题，来源地址交给服务端追加
 * `<!-- Engram source URL -->` 注释（与直接抓取同一格式，见 server 的 sourceUrlComment）。
 */
export function renderedPageForm(page: RenderedPage, originalUrl: string): FormData {
  const form = new FormData();
  form.append('files', new File([page.html], renderedFileName(page, originalUrl), { type: 'text/html' }));
  form.append('sourceUrl', page.url || originalUrl);
  return form;
}

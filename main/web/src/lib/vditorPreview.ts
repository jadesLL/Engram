export const VDITOR_CDN = '/vendor/vditor';

export function vditorPreviewOptions(dark: boolean): IPreviewOptions {
  return {
    cdn: VDITOR_CDN,
    icon: 'ant',
    lang: 'zh_CN',
    mode: dark ? 'dark' : 'light',
    markdown: {
      sanitize: true,
    },
    theme: {
      current: dark ? 'dark' : 'light',
      path: `${VDITOR_CDN}/dist/css/content-theme`,
    },
    hljs: {
      enable: true,
      lineNumber: false,
      defaultLang: '',
      style: dark ? 'github-dark' : 'github',
    },
  };
}

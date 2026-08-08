/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module 'pptx-preview' {
  export function init(
    el: HTMLElement,
    options?: { width?: number; height?: number }
  ): { preview(data: ArrayBuffer | Uint8Array): void };
}

declare module 'x-data-spreadsheet/dist/xspreadsheet.css';
declare module 'x-data-spreadsheet/dist/locale/zh-cn';

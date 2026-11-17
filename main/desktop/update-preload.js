// 更新进度小窗专用预加载：窗口无边框（frame: false）+ 纯 data: 页面，没有系统标题栏按钮，
// 页面只经此桥暴露「最小化」一个能力。不要复用主窗 preload.js —— 那会把完整的 wikiDesktop 桥
// （数据目录、文件操作、内置 Agent 等）暴露给一个静态进度页。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('engramUpdateWindow', {
  minimize: () => ipcRenderer.send('desktop-update-window-minimize'),
});

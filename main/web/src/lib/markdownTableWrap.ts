/**
 * 给渲染结果里的每个 `<table>` 套一层可横向滚动的容器（类名由调用方给）。
 *
 * 为什么需要：`Vditor.preview` 直出原生 `<table>`，列一多、单元格文字一长，表格的固有宽度
 * 就会超过容器——手机/折叠屏上表现为整块正文横向溢出、右侧被推出视野，读者只能整页左右拖。
 * 套一层 `overflow-x: auto` 的 div 后，横向滚动被关在表格自己身上，外层布局宽度不再被撑破。
 *
 * 为什么抽成共享工具：沉浸阅读（ReadingPreview）早就在自己的渲染流程里做了同样的事，
 * 而同样走 `Vditor.preview` 的收集箱产物审阅与文件 Markdown 预览都没做——同一个坑踩了三次。
 * 这里只负责 DOM 包装：容器样式由调用方写在自己组件的 `<style>` 里（用 `:deep(.xxx)` 选中），
 * 不往全局 CSS 塞规则，各处也就能各按各的排版调边距与描边。
 *
 * @param root      渲染宿主（`Vditor.preview` 写入内容的那个元素）
 * @param className 滚动容器的类名，调用方负责给它写样式
 */
export function wrapTables(root: ParentNode, className: string): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    // 同一宿主可能被重新 preview 或重复调用，已经包过的直接跳过，免得套出多层滚动区
    if (table.parentElement?.classList.contains(className)) continue;
    const wrapper = document.createElement('div');
    wrapper.className = className;
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  }
}

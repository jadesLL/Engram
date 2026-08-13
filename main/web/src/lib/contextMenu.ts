import { reactive } from 'vue';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  hint?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  children?: ContextMenuItem[];
  action?: () => unknown | Promise<unknown>;
}

export interface ContextMenuRequest {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface SelectionContextMenuRequest {
  x: number;
  y: number;
  selection: string;
}

export const contextMenuState = reactive({
  open: false,
  x: 0,
  y: 0,
  items: [] as ContextMenuItem[],
  version: 0,
});

export function openContextMenu(request: ContextMenuRequest): void {
  contextMenuState.x = request.x;
  contextMenuState.y = request.y;
  contextMenuState.items = request.items;
  contextMenuState.open = true;
  contextMenuState.version += 1;
}

export function closeContextMenu(): void {
  contextMenuState.open = false;
  contextMenuState.items = [];
}

export function canReadClipboard(): boolean {
  return Boolean(window.isSecureContext && navigator.clipboard?.readText);
}

export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to execCommand for HTTP deployments and denied permissions.
    }
  }

  const input = document.createElement('textarea');
  input.value = text;
  input.readOnly = true;
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  return copied;
}

export function selectionInside(root: Node): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  if (!root.contains(ancestor)) return '';
  return selection.toString().trim();
}

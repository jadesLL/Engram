import { isComposingKey } from './ime.ts';

/** Enter sends a single-line card; a full editor reserves Enter for newlines. */
export function isHomeActionSubmitKey(event: {
  key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
  isComposing?: boolean; keyCode?: number;
}, singleLine: boolean): boolean {
  if (isComposingKey(event) || event.key !== 'Enter' || event.altKey || event.shiftKey) return false;
  return singleLine || event.ctrlKey || event.metaKey;
}

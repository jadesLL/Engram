/** Enter sends a single-line card; a full editor reserves Enter for newlines. */
export function isHomeActionSubmitKey(event: {
  key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
  isComposing?: boolean; keyCode?: number;
}, singleLine: boolean): boolean {
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.altKey || event.shiftKey) return false;
  return singleLine || event.ctrlKey || event.metaKey;
}

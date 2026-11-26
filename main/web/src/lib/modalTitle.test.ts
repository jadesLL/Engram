import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..');

function walkVue(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkVue(full, acc);
    else if (entry.name.endsWith('.vue')) acc.push(full);
  }
  return acc;
}

test('所有 <AppModal> 均未误传 v-tooltip，且 ConfirmHost 与 FilePreview 正确传递 title', () => {
  const files = walkVue(webSrc);
  assert.ok(files.length > 0);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const tags = src.match(/<AppModal\b[\s\S]*?>/g) || [];
    for (const tag of tags) {
      assert.doesNotMatch(
        tag,
        /\bv-tooltip\s*=/,
        `${path.relative(webSrc, file)} 的 <AppModal> 误用了 v-tooltip，应使用 title / :title`,
      );
    }
  }

  const confirmHost = fs.readFileSync(path.join(webSrc, 'components/ui/ConfirmHost.vue'), 'utf8');
  assert.match(confirmHost, /<AppModal[\s\S]*?:title="confirmState\.title"/);

  const filePreview = fs.readFileSync(path.join(webSrc, 'components/FilePreview.vue'), 'utf8');
  assert.match(filePreview, /<AppModal[\s\S]*?title="历史版本"/);
});

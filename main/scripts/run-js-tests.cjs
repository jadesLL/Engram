'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const mainRoot = path.resolve(__dirname, '..');

function listFiles(dirRel, suffix) {
  const dir = path.join(mainRoot, dirRel);
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => path.join(dirRel, name));
}

function runNodeScript(relFile) {
  console.log(`\n>> node ${relFile}`);
  execFileSync(process.execPath, [relFile], { cwd: mainRoot, stdio: 'inherit' });
}

function runNodeTestSuite(files) {
  if (!files.length) return;
  console.log(`\n>> node --test (${files.length} files)`);
  execFileSync(process.execPath, ['--test', ...files], { cwd: mainRoot, stdio: 'inherit' });
}

for (const file of listFiles('desktop/scripts/tests', '.test.js')) {
  runNodeScript(file);
}
for (const file of listFiles('installer/scripts/tests', '.test.js')) {
  runNodeScript(file);
}
runNodeTestSuite([
  ...listFiles('scripts', '.test.cjs'),
  ...listFiles('scripts/release/tests', '.test.mjs'),
]);

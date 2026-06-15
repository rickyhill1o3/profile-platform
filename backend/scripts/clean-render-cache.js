'use strict';
const fs = require('fs');
const path = require('path');
const backend = path.resolve(__dirname, '..');
const targets = [
  path.join(backend, 'node_modules', 'imapflow'),
  path.join(backend, 'node_modules', '.imapflow-hf81Zjo5')
];
try {
  const nm = path.join(backend, 'node_modules');
  if (fs.existsSync(nm)) {
    for (const name of fs.readdirSync(nm)) {
      if (name.startsWith('.imapflow-')) targets.push(path.join(nm, name));
    }
  }
} catch (_) {}
for (const target of targets) {
  try { fs.rmSync(target, { recursive: true, force: true }); console.log('[preinstall] removed stale cache path:', target); } catch (_) {}
}

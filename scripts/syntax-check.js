// npm run check — node --check every source file (fast pre-commit sanity).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['packages', 'apps', 'scripts'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
roots.forEach((r) => { try { walk(r); } catch {} });

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`✗ ${f}\n${err.stderr}`);
  }
}
console.log(failed ? `${failed}/${files.length} files FAILED` : `✓ ${files.length} files OK`);
process.exit(failed ? 1 : 0);

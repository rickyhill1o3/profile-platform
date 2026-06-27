const { execSync } = require('child_process');

function has(name) {
  try {
    require.resolve(name);
    return true;
  } catch (_) {
    return false;
  }
}

const missing = ['ws'].filter((name) => !has(name));
if (!missing.length) {
  console.log('[postinstall] required runtime packages verified.');
  process.exit(0);
}

if (process.env.SKIP_VERIFY_INSTALL === '1') {
  console.warn('[postinstall] missing packages, but SKIP_VERIFY_INSTALL=1:', missing.join(', '));
  process.exit(0);
}

console.warn('[postinstall] missing runtime packages:', missing.join(', '));
console.warn('[postinstall] installing missing packages...');
execSync(`npm install ${missing.join(' ')} --no-audit --no-fund --package-lock=false`, {
  stdio: 'inherit',
  env: { ...process.env, SKIP_VERIFY_INSTALL: '1' }
});

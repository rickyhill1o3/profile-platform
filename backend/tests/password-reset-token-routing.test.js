const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'script.js'), 'utf8');
const resetHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'reset-password.html'), 'utf8');
const forgotHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'forgot-password.html'), 'utf8');

assert.match(serverSource, /reset-password\.html\?reset_token=/, 'new reset emails must use a reset-specific query parameter');
assert.match(frontendSource, /tokenValue\s*&&\s*!isResetPasswordPath\(\)/, 'OAuth token cleanup must skip the password-reset page');
assert.match(frontendSource, /searchParams\.get\('reset_token'\)[\s\S]*?searchParams\.get\('token'\)/, 'the reset page must accept both new and legacy email links');
assert.match(frontendSource, /jwtPurpose\(misplacedLoginToken\)\s*===\s*'password_reset'/, 'the reset page must recover tokens misplaced by the old frontend');
assert.match(frontendSource, /sessionStorage\.setItem\(PASSWORD_RESET_SESSION_KEY/, 'the token must survive URL cleanup without becoming a login session');
assert.match(frontendSource, /sessionStorage\.removeItem\(PASSWORD_RESET_SESSION_KEY\)/, 'the reset token must be cleared after success or expiry');
assert.match(frontendSource, /missing or expired/, 'a missing token must produce a clear user-facing message');
assert.match(resetHtml, /<script src="script\.js\?v=20261008-password-reset-fix"><\/script>/, 'reset page must load the fixed script with a new cache key');
assert.match(forgotHtml, /type="email"/, 'forgot-password form should request a valid email field');
assert.doesNotMatch(resetHtml, /MULTI SKU HELPERS/, 'reset page must not contain unrelated inline JavaScript');
assert.doesNotMatch(forgotHtml, /MULTI SKU HELPERS/, 'forgot-password page must not contain unrelated inline JavaScript');

console.log('password reset token routing tests passed');

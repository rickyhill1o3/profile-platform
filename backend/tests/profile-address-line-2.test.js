const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const profileHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'profile.html'), 'utf8');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');

assert.match(profileHtml, /<label for="address1">Address Line 1<\/label>/, 'profile editor must identify Address Line 1');
assert.match(profileHtml, /<label for="address2">Address Line 2[\s\S]*?<input[^>]+id="address2"[^>]*>/, 'profile editor must show Address Line 2');

const address2Input = profileHtml.match(/<input[^>]+id="address2"[^>]*>/)?.[0] || '';
assert.ok(address2Input, 'Address Line 2 input must exist');
assert.ok(!/\srequired(?:\s|=|\/|>)/.test(address2Input), 'Address Line 2 must remain optional');

assert.match(frontendScript, /address2Input\.value\s*=\s*addr\.address2\s*\|\|\s*""/, 'editing a profile must reload Address Line 2');
assert.match(frontendScript, /address2:\s*document\.getElementById\("address2"\)\?\.value\.trim\(\)\s*\|\|\s*""/, 'saving a profile must submit Address Line 2');

assert.match(serverSource, /address2:\s*payload\.address2\s*\|\|\s*""/, 'backend must persist Address Line 2');
assert.match(serverSource, /"shipping_street",\s*"shipping_street_2"/, 'Shikari export must contain shipping_street_2');
assert.match(serverSource, /address\.address1\s*\|\|\s*"",\s*\n\s*address\.address2\s*\|\|\s*""/, 'Shikari export must place Address Line 2 after shipping_street');
assert.match(serverSource, /billingSameAsShipping\s*\?\s*\(address\.address2\s*\|\|\s*""\)\s*:\s*\(address\.billing_address2\s*\|\|\s*""\)/, 'Shikari billing_street_2 must follow the saved billing rule');

console.log('profile Address Line 2 tests passed');

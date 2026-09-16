const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mergeManageableGuilds, removeManageableGuild, fallbackDiscordUserId } = require('../success-network-ownership');

const merged = mergeManageableGuilds([
  { id: 'secret', name: 'The Secret Sauce', icon: 'old-secret-icon' },
  { id: 'hype', name: 'Old Hype Name', icon: null }
], { id: 'hype', name: 'HYPEEAST', icon: 'hype-icon' });

assert.deepEqual(merged, [
  { id: 'secret', name: 'The Secret Sauce', icon: 'old-secret-icon' },
  { id: 'hype', name: 'HYPEEAST', icon: 'hype-icon' }
]);
assert.deepEqual(removeManageableGuild(merged, 'hype'), [
  { id: 'secret', name: 'The Secret Sauce', icon: 'old-secret-icon' }
]);
assert.deepEqual(mergeManageableGuilds(null, { id: 'hype', name: 'HYPEEAST' }), [
  { id: 'hype', name: 'HYPEEAST', icon: null }
]);
assert.equal(fallbackDiscordUserId('apex-admin-uuid'), 'website-admin:apex-admin-uuid');
assert.throws(() => fallbackDiscordUserId(''), /admin ID is required/i);

const root = path.join(__dirname, '..', '..');
const backend = fs.readFileSync(path.join(root, 'backend', 'success-network.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'frontend', 'success-network.html'), 'utf8');

assert.ok(backend.includes("app.get('/admin/success-network/assignable-admins'"));
assert.ok(backend.includes("app.post('/admin/success-network/assign-owner'"));
assert.ok(backend.includes("source_admin_user_id: targetAdmin.id"));
assert.ok(backend.includes("if (!isSuper(user, SUPER_ADMIN_EMAIL))"));
assert.ok(backend.includes('await transferSavedSourceOwnership(guild.id, decoded.user_id)'));
assert.ok(backend.includes('Discord server ownership could not be saved to the website admin account'));
assert.ok(backend.includes('existing?.discord_user_id || fallbackDiscordUserId(userId)'));
assert.ok(frontend.includes('Assign &amp; activate'));
assert.ok(frontend.includes('/admin/success-network/assign-owner'));
assert.ok(frontend.includes('That admin will see this server, channel, and its saved success posts.'));

console.log('success network ownership tests passed');

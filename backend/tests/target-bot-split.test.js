const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    TARGET_BOT_SPLIT_BOTS,
    DEFAULT_ACTIVE_TARGET_SPLIT_BOTS,
    normalizeSplitBot,
    normalizeActiveSplitBots,
    buildBalancedTargetBotSplit,
    isSplitCurrent
} = require('../target-bot-split');

const addressSizes = [14, 14, 14, 14, 14, 14, 9, 8];
const rows = [];
addressSizes.forEach((size, addressIndex) => {
    for (let profileIndex = 0; profileIndex < size; profileIndex += 1) {
        rows.push({
            id: `profile-${String(rows.length + 1).padStart(3, '0')}`,
            address_key: `address-${addressIndex + 1}`,
            address_label: `Address ${addressIndex + 1}`
        });
    }
});

assert.strictEqual(rows.length, 101);
const split = buildBalancedTargetBotSplit(rows, { revision: 0 });
assert.strictEqual(split.total_profiles, 101);
assert.strictEqual(Object.keys(split.assignments).length, 101);
assert.deepStrictEqual(Object.keys(split.counts), TARGET_BOT_SPLIT_BOTS);
assert.deepStrictEqual(split.active_bots, DEFAULT_ACTIVE_TARGET_SPLIT_BOTS);
const defaultActiveCounts = split.active_bots.map((bot) => split.counts[bot]);
assert.ok(Math.max(...defaultActiveCounts) - Math.min(...defaultActiveCounts) <= 1, 'active bot totals must remain within one profile');
assert.deepStrictEqual([...defaultActiveCounts].sort((a, b) => b - a), [34, 34, 33]);
assert.strictEqual(split.counts.refract, 0);
split.address_breakdown.forEach((group) => {
    const counts = split.active_bots.map((bot) => group.counts[bot]);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${group.address_label} must be spread across every active bot`);
    assert.strictEqual(counts.reduce((sum, value) => sum + value, 0), group.total);
});
assert.strictEqual(isSplitCurrent(split, rows), true);
assert.strictEqual(isSplitCurrent(split, rows, ['shikari']), false);
assert.strictEqual(isSplitCurrent(split, rows.slice(1)), false);
assert.strictEqual(isSplitCurrent(split, rows.map((row, index) => index === 0 ? { ...row, address_key: 'moved-address' } : row)), false);
assert.strictEqual(normalizeSplitBot('VALOR'), 'valor');
assert.strictEqual(normalizeSplitBot('REFRACT'), 'refract');
assert.strictEqual(normalizeSplitBot('stellar'), '');
assert.deepStrictEqual(normalizeActiveSplitBots(['polar', 'shikari', 'polar']), ['shikari', 'polar']);

const rebalanced = buildBalancedTargetBotSplit(rows, { revision: 1 });
assert.ok(Math.max(...rebalanced.active_bots.map((bot) => rebalanced.counts[bot])) - Math.min(...rebalanced.active_bots.map((bot) => rebalanced.counts[bot])) <= 1);
assert.notDeepStrictEqual(rebalanced.assignments, split.assignments, 'a deliberate rebalance should rotate which profiles run on each bot');

const weeklySets = [
    ['shikari'],
    ['shikari', 'polar'],
    ['valor', 'shikari', 'polar'],
    ['refract', 'valor', 'shikari', 'polar']
];
weeklySets.forEach((activeBots) => {
    const weekly = buildBalancedTargetBotSplit(rows, { revision: 3, activeBots });
    assert.deepStrictEqual(weekly.active_bots, TARGET_BOT_SPLIT_BOTS.filter((bot) => activeBots.includes(bot)));
    const totals = weekly.active_bots.map((bot) => weekly.counts[bot]);
    assert.ok(Math.max(...totals) - Math.min(...totals) <= 1, `${activeBots.length}-bot weekly totals must be even`);
    assert.strictEqual(totals.reduce((sum, value) => sum + value, 0), rows.length);
    TARGET_BOT_SPLIT_BOTS.filter((bot) => !weekly.active_bots.includes(bot)).forEach((bot) => assert.strictEqual(weekly.counts[bot], 0));
    weekly.address_breakdown.forEach((group) => {
        const groupCounts = weekly.active_bots.map((bot) => group.counts[bot]);
        assert.ok(Math.max(...groupCounts) - Math.min(...groupCounts) <= 1, 'each physical address must stay even across active bots');
    });
});
assert.strictEqual(buildBalancedTargetBotSplit(rows, { activeBots: ['shikari'] }).counts.shikari, 101);
assert.deepStrictEqual([...['shikari', 'polar'].map((bot) => buildBalancedTargetBotSplit(rows, { activeBots: ['shikari', 'polar'] }).counts[bot])].sort((a, b) => b - a), [51, 50]);

const projectRoot = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'admin.html'), 'utf8');
const frontendScript = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
assert.match(serverSource, /app\.get\('\/admin\/target-bot-split'/, 'the saved split status endpoint must exist');
assert.match(serverSource, /app\.post\('\/admin\/target-bot-split\/rebalance'/, 'the deliberate rebalance endpoint must exist');
assert.match(serverSource, /\.eq\('user_id', userId\)/, 'split inputs must be limited to the signed-in super-admin user ID');
assert.strictEqual((serverSource.match(/filterProfilesForOwnTargetBotSplit\(currentUser\.id, exportProfiles, splitBot\)/g) || []).length, 4, 'Refract, Valor, Shikari, and Polar exports must all apply the saved split');
assert.match(adminHtml, /Target Weekly Bot Split — My Super Admin Profiles/);
assert.strictEqual((adminHtml.match(/data-target-bot-split-active=/g) || []).length, 4, 'all four weekly bot checkboxes must be available');
assert.match(frontendScript, /target_bot_split:\s*bot/);
assert.match(frontendScript, /active_bots:\s*activeBots/);
assert.doesNotMatch(frontendScript, /target_bot_split[\s\S]{0,120}active_only/, 'split downloads must include all owned Target profiles, not only active-user exports');

console.log('target bot split tests passed');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const server = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');

test('checkout intake records Pokémon Center errors and successes', () => {
    const calls = server.match(/recordPokemonCenterProfileOutcome\(\{ payload, resolvedUser/g) || [];
    assert.ok(calls.length >= 2, 'expected recorder calls in both checkout branches');
    assert.match(server, /app\.get\('\/pokemon-center-profile-health', auth/);
});

test('health endpoint scopes stored profile events to signed-in user', () => {
    const endpoint = server.slice(server.indexOf("app.get('/pokemon-center-profile-health'"), server.indexOf('app.get("/profiles"'));
    assert.match(endpoint, /\.eq\('user_id', req\.user_id\)/);
    assert.match(endpoint, /health_storage_available/);
    assert.match(endpoint, /loadHistoricalPokemonCenterProfileEvents/);
});

test('profile edits create blue standby markers', () => {
    assert.match(server, /category: 'profile_changed'/);
    assert.match(server, /reason: 'profiles_bulk_updated'/);
    assert.match(server, /reason: 'profile_updated'/);
});

test('dashboard includes Pokémon Center health summary, filters, and decline details', () => {
    assert.match(frontend, /Pokémon Center Profile Health/);
    assert.match(frontend, /data-pokemon-center-health-filter/);
    assert.match(frontend, /Payment update recommended/);
    assert.match(frontend, /pokemonCenterProfileHealthCache/);
});

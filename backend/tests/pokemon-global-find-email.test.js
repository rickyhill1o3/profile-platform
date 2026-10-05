const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'order-tracker.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'order-tracker.js'), 'utf8');

const routeStart = backendSource.indexOf("app.post('/orders/tracked/:id/find-emails'");
const routeEnd = backendSource.indexOf("app.get('/orders/tracked/:id/find-emails/status'", routeStart);
assert(routeStart >= 0 && routeEnd > routeStart, 'individual find-email route must exist');
const route = backendSource.slice(routeStart, routeEnd);

assert(route.includes("req.role === 'super_admin'"), 'cross-user mailbox search must be super-admin-only');
assert(route.includes("normalizeStoreKey(order.store || '') === 'pokemoncenter'"), 'global search must be Pokemon Center-only');
assert(route.includes('replayPokemonCenterArchiveForOrder('), 'individual search must replay the website-wide archive first');
assert(route.includes('findPokemonCenterOrderAcrossAllMailboxes('), 'individual Pokemon Center search must inspect every connected website mailbox');
assert(route.includes('trackedOrderHasConfirmation'), 'the job must verify that a confirmation was actually linked');

const replayStart = backendSource.indexOf('async function replayPokemonCenterArchiveForOrder(');
const replayEnd = backendSource.indexOf('async function trackedOrderHasConfirmation', replayStart);
const replay = backendSource.slice(replayStart, replayEnd);
assert(replay.includes('fetchPokemonCenterArchiveCandidates(supabase, null'), 'archive lookup must use the complete cross-user scope');
assert(replay.includes('_pokemonCenterOrderNumber'), 'archive replay must force the exact P-number as the ownership key');
assert(replay.includes('email.user_id || order.user_id'), 'archive receiving ownership must be preserved for audit');

const liveStart = backendSource.indexOf('async function findPokemonCenterOrderAcrossAllMailboxes(');
const liveEnd = backendSource.indexOf('async function trackedOrderHasConfirmation', liveStart);
const live = backendSource.slice(liveStart, liveEnd);
assert(live.includes('loadScanAccounts(supabase, null)'), 'live search must load connected mailboxes across every website user');
assert(live.includes('{ text:orderNumber }'), 'live search must use the exact P-number instead of a guessed time window');
assert(live.includes('historicalRepairMailboxNames(account, boxes)'), 'live search must include archive/custom folders, not only Inbox');
assert(live.includes("parsed._pokemonCenterOrderNumber = orderNumber"), 'live match must retain the exact P-number ownership key');

assert(frontendSource.includes('Searching all mailboxes…'), 'Pokemon Center button must explain the global search');
assert(frontendSource.includes('global_no_exact_match'), 'frontend must distinguish a complete global no-match');
assert(frontendSource.includes('linked to the correct website order owner'), 'success must explain cross-mailbox ownership');

console.log('Pokemon Center global find-email tests passed');

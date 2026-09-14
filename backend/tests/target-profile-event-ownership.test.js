const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    buildTargetProfileOwnershipIndex,
    resolveOwnedTargetProfile,
    buildUserScopedTargetEvents
} = require('../target-profile-event-ownership');

function profile(id, name, email) {
    return {
        id,
        profile_name: name,
        addresses: [{ email }],
        accounts: [],
        store_credentials: { target: { login_email: email } }
    };
}

function classifier(payload = {}) {
    return {
        accountEmail: payload.account_email || '',
        profileName: payload.profile_name || '',
        orderId: payload.order_id || ''
    };
}

const johnathan = profile('johnathan-target-1', 'Target 1', 'johnathan_lindley@yahoo.com');
const dab = profile('dab-target-1', 'Target 1', 'd.b.nettz.11@gmail.com');
const copgod = profile('copgod-target-1', 'Profile 1', 'copgod@example.com');

const johnathanOrder = {
    id: 'order-johnathan',
    user_id: 'johnathan',
    external_order_id: '912003760731476',
    created_at: '2026-09-11T08:40:30.000Z',
    site: 'target',
    raw_payload: {
        account_email: 'johnathan_lindley@yahoo.com',
        profile_name: 'Target 1',
        order_id: '912003760731476'
    }
};

const dabOrder = {
    id: 'order-dab',
    user_id: 'dab',
    external_order_id: '902003687827278',
    created_at: '2026-09-11T09:03:48.000Z',
    site: 'target',
    raw_payload: {
        account_email: 'd.b.nettz.11@gmail.com',
        profile_name: 'Target 1',
        order_id: '902003687827278'
    }
};

const johnathanResult = buildUserScopedTargetEvents({
    profiles: [johnathan],
    storedEvents: [],
    ownedOrders: [johnathanOrder],
    classifyPayload: classifier
});
assert.strictEqual(johnathanResult.matchedEvents, 1);
assert.strictEqual(johnathanResult.eventsByProfile.get(johnathan.id)[0].order_id, '912003760731476');

const dabResult = buildUserScopedTargetEvents({
    profiles: [dab],
    storedEvents: [],
    ownedOrders: [dabOrder],
    classifyPayload: classifier
});
assert.strictEqual(dabResult.matchedEvents, 1);
assert.strictEqual(dabResult.eventsByProfile.get(dab.id)[0].order_id, '902003687827278');

// This recreates the production bug: a global Target 1 event had previously been written onto
// another user's profile. Its account email does not belong to copgod, so it must not display.
const copgodResult = buildUserScopedTargetEvents({
    profiles: [copgod],
    storedEvents: [{
        id: 'contaminated-row',
        webhook_log_id: 'global-webhook-1',
        user_id: 'copgod',
        profile_id: copgod.id,
        category: 'success',
        event_at: johnathanOrder.created_at,
        order_id: johnathanOrder.external_order_id,
        account_email: 'johnathan_lindley@yahoo.com',
        profile_name: 'Target 1'
    }],
    ownedOrders: [],
    classifyPayload: classifier
});
assert.strictEqual(copgodResult.matchedEvents, 0);
assert.deepStrictEqual(copgodResult.eventsByProfile.get(copgod.id), []);

const index = buildTargetProfileOwnershipIndex([johnathan]);
assert.strictEqual(resolveOwnedTargetProfile(index, {
    accountEmail: 'd.b.nettz.11@gmail.com',
    profileName: 'Target 1'
}, { allowProfileFallback: true }), null, 'an unmatched account email must not fall through to Target 1');

const duplicateIndex = buildTargetProfileOwnershipIndex([
    profile('one', 'Target 1', 'one@example.com'),
    profile('two', 'Target 1', 'two@example.com')
]);
assert.strictEqual(resolveOwnedTargetProfile(duplicateIndex, {
    profileName: 'Target 1'
}, { allowProfileFallback: true }), null, 'a duplicate profile name inside one user must remain ambiguous');

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
const endpointSource = serverSource.slice(
    serverSource.indexOf("app.get('/target-profile-health'"),
    serverSource.indexOf('app.get("/profiles"')
);
assert.doesNotMatch(endpointSource, /getWebhookLogEntries/, 'user profile health must never scan the global webhook log');
assert.doesNotMatch(endpointSource, /target_profile_address_events'\)\.upsert/, 'dashboard reads must never rewrite event ownership');
assert.match(endpointSource, /\.from\('orders'\)[\s\S]*?\.eq\('user_id', req\.user_id\)/, 'successful results must come from the signed-in user\'s orders');
assert.match(endpointSource, /\.from\('target_profile_address_events'\)[\s\S]*?\.eq\('user_id', req\.user_id\)/, 'failure results must be user-scoped');

console.log('target profile event ownership tests passed');

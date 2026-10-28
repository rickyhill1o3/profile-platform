const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildPokemonCenterProfileIndex,
    classifyPokemonCenterProfileWebhook,
    derivePokemonCenterProfileHealthState,
    resolveOwnedPokemonCenterProfile,
    summarizePokemonCenterEvents
} = require('../pokemon-center-profile-health');

function stellarPayload(title, description, email = 'queue@example.com', profile = 'Sandra Visa') {
    return {
        embeds: [{
            title,
            description,
            fields: [
                { name: 'Site', value: 'Pokemon Center US' },
                { name: 'Email', value: `||${email}||` },
                { name: 'Profile', value: `||${profile}||` },
                { name: 'Product', value: 'Pokémon TCG: Test Product' }
            ]
        }]
    };
}

test('classifies Stellar Pokémon Center successes', () => {
    const parsed = classifyPokemonCenterProfileWebhook(stellarPayload('Successful Checkout :tada:', '', 'a@example.com', 'A'));
    assert.equal(parsed.category, 'success');
    assert.equal(parsed.accountEmail, 'a@example.com');
    assert.equal(parsed.profileName, 'A');
});

test('classifies payment decline reason codes and keeps the reason', () => {
    const parsed = classifyPokemonCenterProfileWebhook(stellarPayload(
        '**Payment Declined!**',
        'Decline Reason: Reason code 481: The order has been rejected by Decision Manager.'
    ));
    assert.equal(parsed.category, 'payment_decline');
    assert.match(parsed.reason, /481/);
});

test('uses Stellar profile name before a reused queue email', () => {
    const profiles = [
        { id: '1', profile_name: 'First Queue', addresses: [{ email: 'queue@example.com' }] },
        { id: '2', profile_name: 'Sandra Visa', addresses: [{ email: 'sandra@example.com' }] }
    ];
    const index = buildPokemonCenterProfileIndex(profiles);
    const matched = resolveOwnedPokemonCenterProfile(index, { profileName: 'Sandra Visa', accountEmail: 'queue@example.com' });
    assert.equal(matched.id, '2');
});

test('uses email only to break a duplicate profile-name tie', () => {
    const profiles = [
        { id: '1', profile_name: 'PKC', addresses: [{ email: 'one@example.com' }] },
        { id: '2', profile_name: 'PKC', addresses: [{ email: 'two@example.com' }] }
    ];
    const matched = resolveOwnedPokemonCenterProfile(buildPokemonCenterProfileIndex(profiles), {
        profileName: 'PKC', accountEmail: 'two@example.com'
    });
    assert.equal(matched.id, '2');
});

test('a profile edit moves health to standby until a newer checkout', () => {
    const before = derivePokemonCenterProfileHealthState({ events: [
        { category: 'profile_changed', event_at: '2026-10-27T16:10:00Z' },
        { category: 'payment_decline', event_at: '2026-10-27T16:00:00Z' }
    ] });
    assert.equal(before.current_status, 'standby');

    const after = derivePokemonCenterProfileHealthState({ events: [
        { category: 'success', event_at: '2026-10-27T16:20:00Z' },
        { category: 'profile_changed', event_at: '2026-10-27T16:10:00Z' }
    ] });
    assert.equal(after.current_status, 'success');
});

test('summary counts checkout attempts but not edit markers', () => {
    assert.deepEqual(summarizePokemonCenterEvents([
        { category: 'success' },
        { category: 'payment_decline' },
        { category: 'payment_decline' },
        { category: 'profile_changed' }
    ]), { success: 1, payment_decline: 2, other: 0, total: 3 });
});

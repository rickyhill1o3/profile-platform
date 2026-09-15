const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { deriveTargetProfileHealthState } = require('../target-profile-health-state');

const reseller = (createdAt, versionId = 'address-old') => ({
    id: `reseller-${createdAt}`,
    created_at: createdAt,
    category: 'reseller',
    address_version_id: versionId,
    order_id: 'ORDER-OLD'
});
const event = (category, createdAt) => ({ id: `${category}-${createdAt}`, created_at: createdAt, category });
const oldAddress = { id: 'address-old', valid_from: '2026-08-01T00:00:00.000Z', valid_to: '2026-09-13T12:00:00.000Z', is_current: false };
const changedAddress = { id: 'address-new', valid_from: '2026-09-13T12:00:00.000Z', valid_to: null, is_current: true };

const waiting = deriveTargetProfileHealthState({
    events: [reseller('2026-09-01T12:00:00.000Z')],
    addressVersions: [changedAddress, oldAddress],
    profileModifiedAt: changedAddress.valid_from
});
assert.strictEqual(waiting.current_status, 'standby');
assert.strictEqual(waiting.reseller_needs_attention, false);
assert.strictEqual(waiting.standby_since, changedAddress.valid_from);
assert.strictEqual(waiting.standby_reason, 'address_changed_after_reseller');

const successfulRetry = deriveTargetProfileHealthState({
    events: [event('success', '2026-09-15T09:00:00.000Z'), reseller('2026-09-01T12:00:00.000Z')],
    addressVersions: [changedAddress, oldAddress],
    profileModifiedAt: changedAddress.valid_from
});
assert.strictEqual(successfulRetry.current_status, 'success');
assert.strictEqual(successfulRetry.standby_since, null);

const failedRetry = deriveTargetProfileHealthState({
    events: [event('order_id', '2026-09-15T09:00:00.000Z'), reseller('2026-09-01T12:00:00.000Z')],
    addressVersions: [changedAddress, oldAddress],
    profileModifiedAt: changedAddress.valid_from
});
assert.strictEqual(failedRetry.current_status, 'order_id');

const resellerAgain = deriveTargetProfileHealthState({
    events: [reseller('2026-09-15T09:00:00.000Z', 'address-new'), reseller('2026-09-01T12:00:00.000Z')],
    addressVersions: [changedAddress, oldAddress],
    profileModifiedAt: changedAddress.valid_from
});
assert.strictEqual(resellerAgain.current_status, 'reseller');
assert.strictEqual(resellerAgain.reseller_needs_attention, true);

const noRealAddressChange = deriveTargetProfileHealthState({
    events: [reseller('2026-09-01T12:00:00.000Z')],
    addressVersions: [oldAddress],
    profileModifiedAt: '2026-09-13T12:00:00.000Z'
});
assert.strictEqual(noRealAddressChange.current_status, 'reseller', 'editing a non-address field must not create standby');

const addressChangedBeforeCancel = deriveTargetProfileHealthState({
    events: [reseller('2026-09-14T12:00:00.000Z', 'address-new')],
    addressVersions: [changedAddress, oldAddress],
    profileModifiedAt: changedAddress.valid_from
});
assert.strictEqual(addressChangedBeforeCancel.current_status, 'reseller');

const frontendSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'frontend', 'script.js'), 'utf8');
assert.match(frontendSource, /Standby — address changed/);
assert.match(frontendSource, /data-target-health-filter[\s\S]*?value="standby"/);
assert.match(frontendSource, /do not change it again yet/i);

const serverSource = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
assert.match(serverSource, /deriveTargetProfileHealthState/);
assert.match(serverSource, /standby:\s*0/);

console.log('target profile standby state tests passed');

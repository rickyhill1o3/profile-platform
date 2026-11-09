const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildValorProfileExport } = require('../valor-profile-export');

const profileId = '7dd39f98-0f79-4fe7-a74e-305e11c8a9e4';
const payload = buildValorProfileExport([{
    id: profileId,
    profile_name: 'Valor Profile',
    addresses: [{
        first_name: 'Taylor',
        last_name: 'Smith',
        email: 'taylor@example.com',
        phone: '(252) 555-0199',
        address1: '126 Neals Creek Road',
        address2: 'APT 1234',
        city: 'Aydlett',
        state: 'NC',
        zip: '27916',
        country: 'US'
    }],
    payments: [{
        card_name: 'Taylor Smith',
        card_encrypted: '4111111111111111',
        cvv_encrypted: '123',
        exp_month: '3',
        exp_year: '2031'
    }]
}], { decrypt: (value) => value });

assert.deepStrictEqual(Object.keys(payload), [profileId]);
assert.deepStrictEqual(payload[profileId], {
    id: profileId,
    name: 'Valor Profile',
    email: 'taylor@example.com',
    phoneNumber: '2525550199',
    billingSameAsShipping: true,
    totalSpent: 0,
    personalCustomsCode: '',
    pinCode: '',
    idNumber: '',
    birthday: '',
    shipping: {
        firstName: 'Taylor',
        lastName: 'Smith',
        addressLine1: '126 Neals Creek Road',
        addressLine2: 'APT 1234',
        countryName: 'United States',
        countryCode: 'US',
        state: 'North Carolina',
        city: 'Aydlett',
        zipCode: '27916'
    },
    billing: {
        firstName: 'Taylor',
        lastName: 'Smith',
        addressLine1: '126 Neals Creek Road',
        addressLine2: 'APT 1234',
        countryName: 'United States',
        countryCode: 'US',
        state: 'North Carolina',
        city: 'Aydlett',
        zipCode: '27916'
    },
    card: {
        holder: 'Taylor Smith',
        number: '4111 1111 1111 1111',
        expiration: '03/31',
        cvv: '123',
        type: 'visa'
    },
    selected: false
});

const legacyPayload = buildValorProfileExport([{
    id: 'legacy-profile-12',
    profile_name: 'Separate Billing',
    addresses: [{
        first_name: 'Alex', last_name: 'Doe', address1: '10 Main St', city: 'Aydlett',
        state: 'NC', zip: '27916', country: 'United States',
        billing_first_name: 'Jordan', billing_last_name: 'Doe', billing_address1: '20 Oak St',
        billing_city: 'Chesapeake', billing_state: 'VA', billing_zip: '23320', billing_country: 'US'
    }],
    payments: []
}]);
const legacyId = Object.keys(legacyPayload)[0];
assert.match(legacyId, /^[0-9a-f-]{36}$/);
assert.strictEqual(legacyPayload[legacyId].billingSameAsShipping, false);
assert.strictEqual(legacyPayload[legacyId].billing.state, 'Virginia');
assert.strictEqual(legacyPayload[legacyId].billing.addressLine1, '20 Oak St');

const root = path.join(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'frontend', 'admin.html'), 'utf8');
const scriptSource = fs.readFileSync(path.join(root, 'frontend', 'script.js'), 'utf8');

assert.match(serverSource, /\/admin\/export\/profiles-valor-json/);
assert.match(serverSource, /buildValorProfileExport\(exportProfiles, \{ decrypt \}\)/);
assert.match(adminSource, /id="adminRunStatusExportValorProfilesButton"/);
assert.match(scriptSource, /profiles-valor-json/);

console.log('Valor profile export tests passed.');

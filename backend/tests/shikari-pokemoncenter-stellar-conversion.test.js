'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildStellarRowsFromImportedProfiles } = require('../shikari-pokemoncenter-stellar');

const rows = buildStellarRowsFromImportedProfiles([{
    profile_name: 'Target Profile 1',
    first_name: 'Casey',
    last_name: 'Shopper',
    email: 'casey@example.com',
    phone: '5558675309',
    address1: '100 Shipping Way',
    address2: 'Unit 2',
    city: 'Raleigh',
    state: 'North Carolina',
    zip: '27601',
    country: 'United States',
    billing_first_name: 'Casey',
    billing_last_name: 'Shopper',
    billing_address1: '200 Billing Road',
    billing_address2: '',
    billing_city: 'Durham',
    billing_state: 'NC',
    billing_zip: '27701',
    billing_country: 'US',
    card_name: 'Casey Shopper',
    card: '4111111111111111',
    exp_month: '7',
    exp_year: '2029',
    cvv: '123'
}]);

assert.deepStrictEqual(rows, [{
    profileName: 'Target Profile 1',
    email: 'casey@example.com',
    phone: '5558675309',
    shipping: {
        firstName: 'Casey',
        lastName: 'Shopper',
        country: 'US',
        address: '100 Shipping Way',
        address2: 'Unit 2',
        state: 'NC',
        city: 'Raleigh',
        zipcode: '27601'
    },
    billingAsShipping: false,
    oneCheckoutPerProfile: false,
    billing: {
        firstName: 'Casey',
        lastName: 'Shopper',
        country: 'US',
        address: '200 Billing Road',
        address2: '',
        state: 'NC',
        city: 'Durham',
        zipcode: '27701'
    },
    payment: {
        cardName: 'Casey Shopper',
        cardType: 'Visa',
        cardNumber: '4111111111111111',
        cardMonth: '07',
        cardYear: '29',
        cardCvv: '123'
    }
}]);

const sameAddress = buildStellarRowsFromImportedProfiles([{
    profile_name: 'No Separate Billing',
    first_name: 'Alex',
    last_name: 'Buyer',
    email: 'alex@example.com',
    phone: '5555551212',
    address1: '1 Main Street',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    card: '5555555555554444',
    exp_month: '12',
    exp_year: '30',
    cvv: '999'
}])[0];
assert.strictEqual(sameAddress.billingAsShipping, true);
assert.deepStrictEqual(sameAddress.billing, sameAddress.shipping);
assert.strictEqual(sameAddress.payment.cardType, 'MasterCard');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(projectRoot, 'frontend', 'script.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(projectRoot, 'frontend', 'dashboard.html'), 'utf8');

assert.match(serverSource, /app\.get\("\/profiles\/export\/stellar-pokemon-center", auth, async/,
    'every signed-in user must have a user-scoped Stellar Pokémon Center export');
assert.match(serverSource, /app\.get\("\/profiles\/export\/stellar-pokemon-center"[\s\S]*?\.eq\("user_id", req\.user_id\)/,
    'the regular-user export must only read the signed-in user');
assert.match(serverSource, /attachAndFilterProfilesByStore\(profiles \|\| \[\], "pokemoncenter"\)/,
    'the user export must only include Pokémon Center-assigned profiles');
assert.match(serverSource, /isShikariTargetToPokemonCenter[\s\S]*?buildStellarRowsFromImportedProfiles\(normalizedRows\)/,
    'the dedicated import must return an exact Stellar conversion from the uploaded Shikari rows');
assert.match(serverSource, /import_source \|\| ''[\s\S]*?shikari_target_csv/,
    'the backend must recognize the dedicated Shikari Target conversion source');
assert.match(frontendSource, /const destinationStore = typeSelect\.value/,
    'the user must be able to choose the destination store before importing');
assert.match(frontendSource, /account_type: destinationStore[\s\S]*?assigned_stores: \[destinationStore\][\s\S]*?import_source: effectiveImportSource/,
    'the selected store must control both the imported profile type and store assignment');
assert.match(frontendSource, /destinationStore === 'pokemoncenter' && importSource === 'shikari_csv'/,
    'only a Shikari CSV deliberately assigned to Pokémon Center should trigger the Stellar conversion');
assert.match(frontendSource, /downloadPokemonCenterStellarProfiles\(data\.stellar_profiles\)/,
    'the Stellar file must download immediately after a Pokémon Center import');
assert.match(dashboardHtml, /id="profileImportType"[\s\S]*?<option value="target">Target<\/option>[\s\S]*?<option value="amazon">Amazon<\/option>[\s\S]*?<option value="pokemoncenter">Pokémon Center<\/option>/,
    'the user importer must offer Target, Amazon, Pokémon Center, and the supported stores');
assert.match(dashboardHtml, /The profiles are assigned only to that selected store/);
assert.match(dashboardHtml, /id="downloadMyStellarPokemonCenterButton"/);

console.log('Selectable Shikari store import and Stellar Pokémon Center conversion tests passed');

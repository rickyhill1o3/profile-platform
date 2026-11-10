const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backendSource = fs.readFileSync(path.join(__dirname, '..', 'order-tracker.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'order-tracker.js'), 'utf8');

assert(
  frontendSource.includes('https://www.pokemoncenter.com/orders/${encodeURIComponent(orderNumber)}?postalCode=${encodeURIComponent(postalCode)}'),
  'Pokemon Center button must build the public P-number + ZIP URL'
);
assert(frontendSource.includes('View Pokémon Center confirmation'), 'Pokemon Center cards must show the direct confirmation button');
assert(frontendSource.includes("['confirmed','processing'].includes(status)&&hasPokemonConfirmationEmail(o)"), 'confirmed Pokemon Center orders must expose manual delivery only when confirmation exists');
assert(frontendSource.includes('This does not create a fake IMAP email.'), 'manual delivery prompt must explain that no email is invented');

const decorateStart = backendSource.indexOf('async function decorateTrackedOrdersWithEmails(');
const decorateEnd = backendSource.indexOf("app.get('/orders/bootstrap'", decorateStart);
const decorate = backendSource.slice(decorateStart, decorateEnd);
assert(decorate.includes("from('addresses').select('profile_id,zip')"), 'tracker must load the profile shipping ZIP for the guest order URL');
assert(decorate.includes('shipping_zip:normalizeUsPostalCode'), 'tracker response must expose only the normalized shipping ZIP');

const routeStart = backendSource.indexOf("app.post('/orders/tracked/:id/mark-delivered'");
const routeEnd = backendSource.indexOf("app.delete('/orders/tracked/:id'", routeStart);
assert(routeStart >= 0 && routeEnd > routeStart, 'manual delivery route must exist');
const route = backendSource.slice(routeStart, routeEnd);
assert(route.includes("normalizeStoreKey(existing.store || '') === 'pokemoncenter'"), 'expanded manual delivery must be Pokemon Center-specific');
assert(route.includes("['confirmed','processing'].includes(previousStatus)"), 'confirmed and processing Pokemon Center orders must be eligible');
assert(route.includes("clean(existing.last_message_id).startsWith('manual-pdf:')"), 'a manually uploaded PDF must count as confirmation evidence');
assert(route.includes('trackedOrderHasConfirmation'), 'Pokemon Center delivery must require confirmation evidence');
assert(route.includes(".eq('user_id', req.user_id)"), 'manual delivery must remain limited to the signed-in user’s order');
assert(route.includes('manual_delivery_confirmed_at'), 'source checkout must retain an audit timestamp');
assert(!route.includes("status:'delivered',\n        event_at"), 'manual delivery must not invent an IMAP delivery event');

console.log('Pokemon Center direct-order and manual-delivery tests passed');

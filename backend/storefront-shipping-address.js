'use strict';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeAddress(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    line1: clean(source.line1 || source.address_line_1),
    line2: clean(source.line2 || source.address_line_2),
    city: clean(source.city),
    state: clean(source.state),
    postal_code: clean(source.postal_code || source.postalCode || source.zip),
    country: clean(source.country).toUpperCase()
  };
}

function hasAddress(address = {}) {
  const normalized = normalizeAddress(address);
  return Boolean(normalized.line1 && normalized.city && normalized.state && normalized.postal_code);
}

function normalizeContact(details = {}, fallback = {}) {
  const source = details && typeof details === 'object' ? details : {};
  const fallbackSource = fallback && typeof fallback === 'object' ? fallback : {};
  return {
    name: clean(source.name || fallbackSource.name),
    phone: clean(source.phone || fallbackSource.phone),
    address: normalizeAddress(source.address || source)
  };
}

function extractStripeShippingContact(session = {}) {
  const customerDetails = session?.customer_details || {};
  const candidates = [
    session?.collected_information?.shipping_details,
    session?.shipping_details,
    session?.customer?.shipping,
    customerDetails
  ].filter(Boolean);

  for (const candidate of candidates) {
    const contact = normalizeContact(candidate, customerDetails);
    if (hasAddress(contact.address)) return contact;
  }

  return normalizeContact(candidates[0] || customerDetails, customerDetails);
}

function extractStoredShippingContact(metadata = {}) {
  const rawSession = metadata?.raw_session || {};
  const stripeContact = extractStripeShippingContact(rawSession);
  if (hasAddress(stripeContact.address)) return stripeContact;

  return normalizeContact({
    name: metadata?.shipping_name || metadata?.customer_name,
    phone: metadata?.shipping_phone || metadata?.customer_phone,
    address: metadata?.shipping_address || {}
  });
}

function shippingAddressLines(contact = {}) {
  const normalized = normalizeContact(contact);
  const locality = [normalized.address.city, normalized.address.state, normalized.address.postal_code]
    .filter(Boolean)
    .join(', ')
    .replace(/, ([A-Z]{2}), /, ', $1 ');
  return [
    normalized.name,
    normalized.address.line1,
    normalized.address.line2,
    locality,
    normalized.address.country,
    normalized.phone ? `Phone: ${normalized.phone}` : ''
  ].filter(Boolean);
}

module.exports = {
  normalizeAddress,
  hasAddress,
  extractStripeShippingContact,
  extractStoredShippingContact,
  shippingAddressLines
};

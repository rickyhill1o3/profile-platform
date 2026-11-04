const crypto = require('crypto');

const STATE_NAMES = {
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
    HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
    KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
    MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
    NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
    OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
    VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
    DC: 'District of Columbia', PR: 'Puerto Rico'
};

const COUNTRY_CODES = {
    'united states': 'US', usa: 'US', us: 'US',
    canada: 'CA', ca: 'CA',
    'united kingdom': 'GB', uk: 'GB', gb: 'GB',
    australia: 'AU', au: 'AU'
};

function clean(value) {
    return String(value ?? '').trim();
}

function digits(value) {
    return clean(value).replace(/\D/g, '');
}

function valorUuid(value) {
    const text = clean(value).toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) {
        return text;
    }

    // Valor requires UUID keys. Keep the fallback stable between exports so an
    // older non-UUID profile does not become a brand-new Valor profile each time.
    const hex = crypto.createHash('sha256').update(text || 'shore-shack-profile').digest('hex').slice(0, 32).split('');
    hex[12] = '5';
    hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4];
    return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
}

function fullStateName(value) {
    const text = clean(value);
    return STATE_NAMES[text.toUpperCase()] || text;
}

function countryName(value) {
    const text = clean(value);
    if (!text || /^(united states|usa|us|u\.s\.|u\.s\.a\.)$/i.test(text)) return 'United States';
    if (/^(canada|ca)$/i.test(text)) return 'Canada';
    if (/^(united kingdom|uk|gb)$/i.test(text)) return 'United Kingdom';
    if (/^(australia|au)$/i.test(text)) return 'Australia';
    return text;
}

function countryCode(value) {
    const text = clean(value);
    const normalized = text.toLowerCase().replace(/\./g, '');
    if (!normalized) return 'US';
    return COUNTRY_CODES[normalized] || (/^[A-Za-z]{2}$/.test(text) ? text.toUpperCase() : 'US');
}

function twoDigit(value) {
    const text = digits(value);
    return text ? text.slice(-2).padStart(2, '0') : '';
}

function formatCardNumber(value) {
    return digits(value).replace(/(.{4})/g, '$1 ').trim();
}

function cardType(value) {
    const number = digits(value);
    if (/^4/.test(number)) return 'visa';
    if (/^(5[1-5]|2[2-7])/.test(number)) return 'mastercard';
    if (/^3[47]/.test(number)) return 'amex';
    if (/^(6011|65|64[4-9])/.test(number)) return 'discover';
    return '';
}

function hasSeparateBilling(address) {
    return Boolean(
        address.billing_first_name || address.billing_last_name || address.billing_address1 ||
        address.billing_address2 || address.billing_city || address.billing_state ||
        address.billing_zip || address.billing_country
    );
}

function valorAddress(source, fallback = {}) {
    const rawCountry = source.country || fallback.country || 'US';
    return {
        firstName: clean(source.firstName || fallback.firstName),
        lastName: clean(source.lastName || fallback.lastName),
        addressLine1: clean(source.addressLine1 || fallback.addressLine1),
        addressLine2: clean(source.addressLine2 || fallback.addressLine2),
        countryName: countryName(rawCountry),
        countryCode: countryCode(rawCountry),
        state: fullStateName(source.state || fallback.state),
        city: clean(source.city || fallback.city),
        zipCode: clean(source.zipCode || fallback.zipCode)
    };
}

function safelyDecrypt(value, decryptValue) {
    if (!value) return '';
    try {
        return clean(decryptValue(value));
    } catch {
        return '';
    }
}

function buildValorProfileExport(profiles = [], options = {}) {
    const decryptValue = typeof options.decrypt === 'function' ? options.decrypt : (value) => value;
    const payload = {};

    for (const profile of Array.isArray(profiles) ? profiles : []) {
        const address = profile.addresses?.[0] || {};
        const payment = profile.payments?.[0] || {};
        const id = valorUuid(profile.id);
        const separateBilling = hasSeparateBilling(address);
        const shippingSource = {
            firstName: address.first_name,
            lastName: address.last_name,
            addressLine1: address.address1,
            addressLine2: address.address2,
            country: address.country,
            state: address.state,
            city: address.city,
            zipCode: address.zip
        };
        const shipping = valorAddress(shippingSource);
        const billing = separateBilling ? valorAddress({
            firstName: address.billing_first_name,
            lastName: address.billing_last_name,
            addressLine1: address.billing_address1,
            addressLine2: address.billing_address2,
            country: address.billing_country,
            state: address.billing_state,
            city: address.billing_city,
            zipCode: address.billing_zip
        }, shippingSource) : { ...shipping };
        const cardNumber = safelyDecrypt(payment.card_encrypted, decryptValue);
        const cardCvv = safelyDecrypt(payment.cvv_encrypted, decryptValue);
        const shippingName = `${shipping.firstName} ${shipping.lastName}`.trim();

        payload[id] = {
            id,
            name: clean(profile.profile_name),
            email: clean(address.email),
            phoneNumber: digits(address.phone),
            billingSameAsShipping: !separateBilling,
            totalSpent: 0,
            personalCustomsCode: '',
            pinCode: '',
            idNumber: '',
            birthday: '',
            shipping,
            billing,
            card: {
                holder: clean(payment.card_name) || shippingName,
                number: formatCardNumber(cardNumber),
                expiration: `${twoDigit(payment.exp_month)}/${twoDigit(payment.exp_year)}`,
                cvv: digits(cardCvv),
                type: cardType(cardNumber)
            },
            selected: false
        };
    }

    return payload;
}

module.exports = {
    buildValorProfileExport,
    cardType,
    countryCode,
    countryName,
    formatCardNumber,
    fullStateName,
    valorUuid
};

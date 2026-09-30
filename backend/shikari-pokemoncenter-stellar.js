'use strict';

function twoDigitYear(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length === 4 ? text.slice(-2) : text.padStart(2, '0');
}

function twoDigitMonth(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.padStart(2, '0');
}

function countryForStellar(value) {
    const text = String(value || '').trim();
    if (!text) return 'US';
    if (/^(united states|usa|us|u\.s\.|u\.s\.a\.)$/i.test(text)) return 'US';
    return text;
}

function stateForStellar(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const normalized = text.toLowerCase().replace(/[^a-z]/g, '');
    const states = {
        alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
        colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
        hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
        kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
        massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
        missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', newhampshire: 'NH',
        newjersey: 'NJ', newmexico: 'NM', newyork: 'NY', northcarolina: 'NC',
        northdakota: 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
        rhodeisland: 'RI', southcarolina: 'SC', southdakota: 'SD', tennessee: 'TN',
        texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
        westvirginia: 'WV', wisconsin: 'WI', wyoming: 'WY', districtofcolumbia: 'DC',
        dc: 'DC', puertorico: 'PR'
    };
    if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
    return states[normalized] || text;
}

function cardTypeForNumber(cardNumber) {
    const digits = String(cardNumber || '').replace(/\D/g, '');
    if (/^4/.test(digits)) return 'Visa';
    if (/^(5[1-5]|2[2-7])/.test(digits)) return 'MasterCard';
    if (/^3[47]/.test(digits)) return 'Amex';
    if (/^6/.test(digits)) return 'Discover';
    return '';
}

function buildStellarRowsFromImportedProfiles(profiles = []) {
    return (Array.isArray(profiles) ? profiles : []).map((profile) => {
        const ship = {
            firstName: profile.first_name || '',
            lastName: profile.last_name || '',
            country: countryForStellar(profile.country),
            address: profile.address1 || '',
            address2: profile.address2 || '',
            state: stateForStellar(profile.state),
            city: profile.city || '',
            zipcode: profile.zip || ''
        };
        const hasBilling = !!(
            profile.billing_first_name || profile.billing_last_name || profile.billing_address1 ||
            profile.billing_address2 || profile.billing_city || profile.billing_state ||
            profile.billing_zip || profile.billing_country || profile.billing_phone
        );
        const bill = hasBilling ? {
            firstName: profile.billing_first_name || '',
            lastName: profile.billing_last_name || '',
            country: countryForStellar(profile.billing_country || profile.country),
            address: profile.billing_address1 || '',
            address2: profile.billing_address2 || '',
            state: stateForStellar(profile.billing_state),
            city: profile.billing_city || '',
            zipcode: profile.billing_zip || ''
        } : { ...ship };

        return {
            profileName: profile.profile_name || '',
            email: profile.email || '',
            phone: profile.phone || '',
            shipping: ship,
            billingAsShipping: !hasBilling,
            oneCheckoutPerProfile: false,
            billing: bill,
            payment: {
                cardName: profile.card_name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
                cardType: cardTypeForNumber(profile.card),
                cardNumber: profile.card || '',
                cardMonth: twoDigitMonth(profile.exp_month),
                cardYear: twoDigitYear(profile.exp_year),
                cardCvv: profile.cvv || ''
            }
        };
    });
}

module.exports = {
    buildStellarRowsFromImportedProfiles,
    cardTypeForNumber,
    countryForStellar,
    stateForStellar,
    twoDigitMonth,
    twoDigitYear
};

function cleanTargetAddressPart(value = '') {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeTargetStreetSuffix(token = '') {
    const map = {
        street: 'st', st: 'st', str: 'st',
        lane: 'ln', ln: 'ln',
        road: 'rd', rd: 'rd',
        avenue: 'ave', ave: 'ave', av: 'ave',
        boulevard: 'blvd', blvd: 'blvd',
        drive: 'dr', dr: 'dr',
        court: 'ct', ct: 'ct',
        circle: 'cir', cir: 'cir',
        highway: 'hwy', hwy: 'hwy',
        parkway: 'pkwy', pkwy: 'pkwy',
        place: 'pl', pl: 'pl',
        terrace: 'ter', ter: 'ter',
        trail: 'trl', trl: 'trl',
        way: 'way'
    };
    return map[token] || token;
}

const TARGET_STREET_SUFFIXES = new Set([
    'st', 'ln', 'rd', 'ave', 'blvd', 'dr', 'ct', 'cir', 'hwy', 'pkwy', 'pl', 'ter', 'trl', 'way'
]);

// These words describe a delivery point inside one physical street address. They may appear
// before or after the street suffix in profile "jigs", and spelling is not always consistent.
const TARGET_SECONDARY_ADDRESS_WORDS = new Set([
    'apt', 'apartment', 'apartments', 'appartment', 'unit', 'suite', 'ste',
    'floor', 'fl', 'flat', 'level', 'lvl', 'building', 'bldg', 'blding',
    'buildng', 'bulding', 'room', 'rm', 'door', 'pmb', 'mailbox', 'box',
    'dorm', 'basement', 'cellar', 'barn', 'lot', 'trailer', 'rear', 'front'
]);

function normalizeTargetState(value = '') {
    const raw = cleanTargetAddressPart(value).replace(/[^a-z]/g, '');
    const map = {
        northcarolina: 'nc', nc: 'nc', virginia: 'va', va: 'va', southcarolina: 'sc', sc: 'sc',
        maryland: 'md', md: 'md', delaware: 'de', de: 'de', georgia: 'ga', ga: 'ga', florida: 'fl', fl: 'fl',
        newyork: 'ny', ny: 'ny', pennsylvania: 'pa', pa: 'pa', newjersey: 'nj', nj: 'nj'
    };
    return map[raw] || raw;
}

function targetBaseStreetParts(address = {}) {
    const line1 = cleanTargetAddressPart(address.address1 || '');
    const tokens = line1.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const rawHouse = tokens[0] && /^\d+[a-z]?$/.test(tokens[0]) ? tokens.shift() : '';
    const houseMatch = String(rawHouse || '').match(/^(\d+)([a-z]?)$/i);
    const house = houseMatch ? houseMatch[1] : rawHouse;
    const house_variant = houseMatch ? (houseMatch[2] || '') : '';
    const normalizedTokens = tokens.map(normalizeTargetStreetSuffix);
    const streetTokens = normalizedTokens.filter((token) => {
        if (!token || TARGET_STREET_SUFFIXES.has(token) || TARGET_SECONDARY_ADDRESS_WORDS.has(token)) return false;
        // Unit/building identifiers are not street names. Preserve spelled street words, including
        // deliberate misspellings, so the fuzzy comparison can still recognize the same street.
        return !/^\d+[a-z]?$/.test(token) && !/^[a-z]\d+$/.test(token);
    });
    const matchingTokens = streetTokens.length ? streetTokens : normalizedTokens.filter((token) => !TARGET_STREET_SUFFIXES.has(token));
    return {
        house,
        house_variant,
        street: normalizedTokens.join(' '),
        street_tokens: matchingTokens,
        street_compact: matchingTokens.join('').replace(/[^a-z0-9]/g, ''),
        city: cleanTargetAddressPart(address.city || ''),
        state: normalizeTargetState(address.state || ''),
        zip: cleanTargetAddressPart(address.zip || '').replace(/[^0-9]/g, '').slice(0, 5)
    };
}

function targetStringSimilarity(a = '', b = '') {
    a = String(a || ''); b = String(b || '');
    if (a === b) return 1;
    if (!a || !b) return 0;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        let last = prev[0]; prev[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const old = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
            last = old;
        }
    }
    return 1 - (prev[b.length] / Math.max(a.length, b.length));
}

function targetConsonantSkeleton(value = '') {
    return String(value || '').replace(/[^a-z]/g, '').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
}

function hasMatchingTargetStreetAnchor(aTokens = [], bTokens = []) {
    for (const aToken of aTokens) {
        for (const bToken of bTokens) {
            const shortest = Math.min(aToken.length, bToken.length);
            if (shortest < 6 || aToken[0] !== bToken[0]) continue;
            if (aToken === bToken || targetStringSimilarity(aToken, bToken) >= 0.72) return true;
            const aSkeleton = targetConsonantSkeleton(aToken);
            const bSkeleton = targetConsonantSkeleton(bToken);
            if (Math.min(aSkeleton.length, bSkeleton.length) >= 4 && targetStringSimilarity(aSkeleton, bSkeleton) >= 0.72) return true;
        }
    }
    return false;
}

function sameTargetPhysicalAddress(a = {}, b = {}) {
    const aa = targetBaseStreetParts(a), bb = targetBaseStreetParts(b);
    if (!aa.house || !bb.house || aa.house !== bb.house) return false;
    if (aa.zip && bb.zip && aa.zip !== bb.zip) return false;
    if (aa.state && bb.state && aa.state !== bb.state) return false;
    if (aa.city && bb.city && aa.city !== bb.city) return false;
    if (!aa.street_compact || !bb.street_compact) return false;
    return targetStringSimilarity(aa.street_compact, bb.street_compact) >= 0.70
        || hasMatchingTargetStreetAnchor(aa.street_tokens, bb.street_tokens);
}

module.exports = {
    cleanTargetAddressPart,
    normalizeTargetStreetSuffix,
    normalizeTargetState,
    targetBaseStreetParts,
    targetStringSimilarity,
    targetConsonantSkeleton,
    hasMatchingTargetStreetAnchor,
    sameTargetPhysicalAddress
};

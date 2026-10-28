const crypto = require('crypto');
const {
    hasMatchingTargetStreetAnchor,
    normalizeTargetStreetSuffix,
    targetBaseStreetParts,
    sameTargetPhysicalAddress
} = require('./target-physical-address');

const REQUIRED_USPS_SECONDARY_DESIGNATORS = Object.freeze([
    'APT', 'BLDG', 'DEPT', 'FL', 'HNGR', 'KEY', 'LOT', 'PIER',
    'RM', 'SLIP', 'SPC', 'STOP', 'STE', 'TRLR', 'UNIT', '#'
]);

const OPTIONAL_USPS_SECONDARY_DESIGNATORS = Object.freeze([
    'BSMT', 'FRNT', 'LBBY', 'LOWR', 'OFC', 'PH', 'REAR', 'SIDE', 'UPPR'
]);

const TARGET_SUFFIX_LABELS = Object.freeze({
    st: 'Street', ln: 'Lane', rd: 'Road', ave: 'Avenue', blvd: 'Boulevard',
    dr: 'Drive', ct: 'Court', cir: 'Circle', hwy: 'Highway', pkwy: 'Parkway',
    pl: 'Place', ter: 'Terrace', trl: 'Trail', way: 'Way'
});

function cleanAddressValue(value = '') {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function titleAddressWord(value = '') {
    const word = String(value || '').toLowerCase();
    return word ? word[0].toUpperCase() + word.slice(1) : '';
}

function majorityValue(addresses = [], field = '') {
    const counts = new Map();
    for (const address of addresses) {
        const value = cleanAddressValue(address?.[field]);
        if (!value) continue;
        const key = field === 'zip' ? (value.match(/\d{5}/)?.[0] || value) : value.toLowerCase();
        const entry = counts.get(key) || { value, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.value.length - b.value.length)[0]?.value || '';
}

function suffixesFromAddress(address = {}) {
    return cleanAddressValue(address.address1).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
        .map(normalizeTargetStreetSuffix)
        .filter((token) => Object.prototype.hasOwnProperty.call(TARGET_SUFFIX_LABELS, token));
}

function clusterStreetTokens(addresses = []) {
    const clusters = [];
    for (const address of addresses) {
        const tokens = targetBaseStreetParts(address).street_tokens || [];
        for (const token of tokens) {
            if (!token || token.length < 3) continue;
            let cluster = clusters.find((item) => item.tokens.has(token)
                || hasMatchingTargetStreetAnchor([...item.tokens.keys()], [token]));
            if (!cluster) {
                cluster = { tokens: new Map(), appearances: 0, firstIndex: clusters.length };
                clusters.push(cluster);
            }
            cluster.tokens.set(token, (cluster.tokens.get(token) || 0) + 1);
            cluster.appearances += 1;
        }
    }
    const minimumAppearances = addresses.length > 1 ? Math.max(2, Math.ceil(addresses.length * 0.4)) : 1;
    const selected = clusters.filter((cluster) => cluster.appearances >= minimumAppearances);
    const usable = selected.length ? selected : clusters.sort((a, b) => b.appearances - a.appearances).slice(0, 1);
    return usable
        .sort((a, b) => a.firstIndex - b.firstIndex)
        .map((cluster) => [...cluster.tokens.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0])
        .filter(Boolean);
}

function canonicalTargetSourceAddress(sourceAddresses = []) {
    const addresses = (Array.isArray(sourceAddresses) ? sourceAddresses : []).filter((address) => address?.address1);
    if (!addresses.length) throw new Error('The selected profiles have no usable shipping address.');
    const firstAddress = addresses[0];
    if (addresses.some((address) => !sameTargetPhysicalAddress(firstAddress, address))) {
        throw new Error('Select profiles from one physical-address group before randomizing.');
    }

    const houseCounts = new Map();
    for (const address of addresses) {
        const house = targetBaseStreetParts(address).house;
        if (house) houseCounts.set(house, (houseCounts.get(house) || 0) + 1);
    }
    const house = [...houseCounts.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] || '';
    const streetTokens = clusterStreetTokens(addresses);

    const suffixCounts = new Map();
    for (const address of addresses) {
        for (const suffix of suffixesFromAddress(address)) suffixCounts.set(suffix, (suffixCounts.get(suffix) || 0) + 1);
    }
    const suffix = [...suffixCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
    if (!house || !streetTokens.length || !suffix) throw new Error('Could not determine a complete base street address from the selected profiles.');

    const zipRaw = majorityValue(addresses, 'zip');
    return {
        address1: [house, ...streetTokens.map(titleAddressWord), TARGET_SUFFIX_LABELS[suffix]].join(' '),
        address2: '',
        city: majorityValue(addresses, 'city'),
        state: majorityValue(addresses, 'state'),
        zip: zipRaw.match(/\d{5}/)?.[0] || zipRaw
    };
}

function shuffledDesignators(randomInt = crypto.randomInt) {
    const values = [...REQUIRED_USPS_SECONDARY_DESIGNATORS, ...OPTIONAL_USPS_SECONDARY_DESIGNATORS];
    for (let index = values.length - 1; index > 0; index -= 1) {
        const swap = randomInt(0, index + 1);
        [values[index], values[swap]] = [values[swap], values[index]];
    }
    return values;
}

function buildTargetUspsRandomizationPlan({ profileIds = [], sourceAddresses = [], randomInt = crypto.randomInt } = {}) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('Select at least one Target profile to randomize.');
    const source = canonicalTargetSourceAddress(sourceAddresses);
    const designators = shuffledDesignators(randomInt);
    const reusableRequiredDesignators = designators.filter((designator) => REQUIRED_USPS_SECONDARY_DESIGNATORS.includes(designator));
    const usedLines = new Set();

    const assignments = ids.map((profileId, index) => {
        // Optional/no-range designators can appear only once because repeating one would create
        // the exact same address. Larger batches continue cycling through range-required types.
        const designator = index < designators.length
            ? designators[index]
            : reusableRequiredDesignators[(index - designators.length) % reusableRequiredDesignators.length];
        const requiresRange = REQUIRED_USPS_SECONDARY_DESIGNATORS.includes(designator);
        let secondaryRange = '';
        let address1 = '';
        for (let attempt = 0; attempt < 100; attempt += 1) {
            secondaryRange = requiresRange ? String(randomInt(1000, 10000)) : '';
            address1 = `${source.address1} ${designator}${secondaryRange ? ` ${secondaryRange}` : ''}`;
            if (!usedLines.has(address1)) break;
        }
        if (usedLines.has(address1)) throw new Error('Could not create a unique USPS secondary address for every selected profile.');
        usedLines.add(address1);
        return {
            profile_id: profileId,
            address1,
            address2: '',
            city: source.city,
            state: source.state,
            zip: source.zip,
            designator,
            secondary_range: secondaryRange
        };
    });
    return { source, assignments };
}

function validateTargetUspsRandomizationPlan({ profileIds = [], sourceAddresses = [], assignments = [] } = {}) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
    const source = canonicalTargetSourceAddress(sourceAddresses);
    if (!Array.isArray(assignments) || assignments.length !== ids.length) throw new Error('Preview the randomized addresses again before saving.');
    const expected = new Set(ids);
    const seenIds = new Set();
    const seenLines = new Set();

    const normalized = assignments.map((assignment) => {
        const profileId = String(assignment?.profile_id || '').trim();
        if (!expected.has(profileId) || seenIds.has(profileId)) throw new Error('The randomized address preview does not match the selected profiles.');
        seenIds.add(profileId);
        const address1 = cleanAddressValue(assignment.address1);
        const suffix = address1.slice(source.address1.length).trim();
        if (!address1.startsWith(`${source.address1} `) || seenLines.has(address1)) throw new Error('The randomized address preview contains an invalid or duplicate address.');
        seenLines.add(address1);

        let valid = OPTIONAL_USPS_SECONDARY_DESIGNATORS.includes(suffix);
        if (!valid) {
            valid = REQUIRED_USPS_SECONDARY_DESIGNATORS.some((designator) => {
                const escaped = designator === '#' ? '#' : designator;
                return new RegExp(`^${escaped} \\d{4}$`).test(suffix);
            });
        }
        if (!valid) throw new Error('Every randomized address must use an approved USPS designator and a four-digit number when required.');
        if (cleanAddressValue(assignment.address2)) throw new Error('Randomized USPS secondary details must stay on Address Line 1.');
        if (cleanAddressValue(assignment.city).toLowerCase() !== source.city.toLowerCase()
            || cleanAddressValue(assignment.state).toLowerCase() !== source.state.toLowerCase()
            || (cleanAddressValue(assignment.zip).match(/\d{5}/)?.[0] || '') !== source.zip) {
            throw new Error('The randomized address preview no longer matches the selected physical address.');
        }
        return { profile_id: profileId, address1, address2: '', city: source.city, state: source.state, zip: source.zip };
    });
    return { source, assignments: normalized };
}

module.exports = {
    REQUIRED_USPS_SECONDARY_DESIGNATORS,
    OPTIONAL_USPS_SECONDARY_DESIGNATORS,
    canonicalTargetSourceAddress,
    buildTargetUspsRandomizationPlan,
    validateTargetUspsRandomizationPlan
};

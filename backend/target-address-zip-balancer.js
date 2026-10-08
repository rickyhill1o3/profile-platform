function cleanAddressValue(value = '') {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function normalizeFiveDigitZip(value = '') {
    const match = cleanAddressValue(value).match(/\d{5}/);
    return match ? match[0] : '';
}

function normalizedAddressKey(address = {}) {
    return [
        address.address1,
        address.address2,
        address.city,
        address.state,
        normalizeFiveDigitZip(address.zip)
    ].map((value) => cleanAddressValue(value).toLowerCase().replace(/[^a-z0-9]/g, '')).join('|');
}

function normalizeBalanceDestinations(addresses = [], selectedZip = '') {
    const zip = normalizeFiveDigitZip(selectedZip);
    if (!zip) throw new Error('Choose a valid five-digit ZIP code.');

    const normalized = (Array.isArray(addresses) ? addresses : [])
        .map((address) => ({
            address1: cleanAddressValue(address?.address1),
            address2: cleanAddressValue(address?.address2),
            city: cleanAddressValue(address?.city),
            state: cleanAddressValue(address?.state),
            zip
        }))
        .filter((address) => address.address1 || address.address2 || address.city || address.state);

    if (!normalized.length) throw new Error('Enter at least one destination address.');
    if (normalized.length > 25) throw new Error('Use no more than 25 destination addresses at one time.');
    for (const address of normalized) {
        if (!address.address1 || !address.city || !address.state) {
            throw new Error('Every destination needs Address Line 1, City, and State.');
        }
    }

    const seen = new Set();
    for (const address of normalized) {
        const key = normalizedAddressKey(address);
        if (seen.has(key)) throw new Error('Each destination address must be unique.');
        seen.add(key);
    }
    return normalized;
}

function profileAddress(profile = {}) {
    return profile.addresses?.[0] || profile.address || {};
}

function buildZipAddressBalancePlan({ profiles = [], addresses = [], zip = '' } = {}) {
    const selectedZip = normalizeFiveDigitZip(zip);
    const destinations = normalizeBalanceDestinations(addresses, selectedZip);
    const eligibleProfiles = (Array.isArray(profiles) ? profiles : [])
        .filter((profile) => normalizeFiveDigitZip(profileAddress(profile).zip) === selectedZip)
        .slice()
        .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), undefined, { numeric: true }));

    if (!eligibleProfiles.length) throw new Error(`No Target profiles use ZIP ${selectedZip}.`);

    const base = Math.floor(eligibleProfiles.length / destinations.length);
    const remainder = eligibleProfiles.length % destinations.length;
    const quotas = destinations.map((_, index) => base + (index < remainder ? 1 : 0));
    const destinationIndexByKey = new Map(destinations.map((address, index) => [normalizedAddressKey(address), index]));
    const keptByDestination = destinations.map(() => []);
    const movePool = [];

    for (const profile of eligibleProfiles) {
        const destinationIndex = destinationIndexByKey.get(normalizedAddressKey(profileAddress(profile)));
        if (destinationIndex == null || keptByDestination[destinationIndex].length >= quotas[destinationIndex]) {
            movePool.push(profile);
        } else {
            keptByDestination[destinationIndex].push(profile);
        }
    }

    const assignments = [];
    let poolIndex = 0;
    destinations.forEach((destination, destinationIndex) => {
        const kept = keptByDestination[destinationIndex];
        for (const profile of kept) {
            assignments.push({
                profile_id: profile.id,
                destination_index: destinationIndex,
                address: destination,
                changed: false
            });
        }
        while (kept.length < quotas[destinationIndex]) {
            const profile = movePool[poolIndex++];
            if (!profile) throw new Error('Could not build a complete address distribution plan.');
            assignments.push({
                profile_id: profile.id,
                destination_index: destinationIndex,
                address: destination,
                changed: normalizedAddressKey(profileAddress(profile)) !== normalizedAddressKey(destination)
            });
            kept.push(profile);
        }
    });

    const distribution = destinations.map((address, index) => ({
        index,
        address,
        profile_count: quotas[index],
        changed_count: assignments.filter((assignment) => assignment.destination_index === index && assignment.changed).length
    }));

    return {
        zip: selectedZip,
        eligible_count: eligibleProfiles.length,
        destination_count: destinations.length,
        changed_count: assignments.filter((assignment) => assignment.changed).length,
        unchanged_count: assignments.filter((assignment) => !assignment.changed).length,
        destinations,
        distribution,
        assignments
    };
}

function addZipScopedIdealCounts(groups = []) {
    const rows = (Array.isArray(groups) ? groups : []).map((group) => ({ ...group }));
    const byZip = new Map();
    for (const row of rows) {
        const zip = normalizeFiveDigitZip(row.sample_address?.zip) || 'no-zip';
        if (!byZip.has(zip)) byZip.set(zip, []);
        byZip.get(zip).push(row);
    }

    for (const zipRows of byZip.values()) {
        zipRows.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
        const profileCount = zipRows.reduce((sum, row) => sum + Number(row.profile_ids?.length || 0), 0);
        const base = zipRows.length ? Math.floor(profileCount / zipRows.length) : 0;
        const remainder = zipRows.length ? profileCount % zipRows.length : 0;
        zipRows.forEach((row, index) => {
            const actual = Number(row.profile_ids?.length || 0);
            row.zip = normalizeFiveDigitZip(row.sample_address?.zip);
            row.zip_profile_count = profileCount;
            row.zip_address_count = zipRows.length;
            row.ideal_count = base + (index < remainder ? 1 : 0);
            row.actual_count = actual;
            row.delta = actual - row.ideal_count;
        });
    }
    return rows.sort((a, b) => String(a.zip || '').localeCompare(String(b.zip || '')) || String(a.label || '').localeCompare(String(b.label || '')));
}

module.exports = {
    cleanAddressValue,
    normalizeFiveDigitZip,
    normalizedAddressKey,
    normalizeBalanceDestinations,
    buildZipAddressBalancePlan,
    addZipScopedIdealCounts
};

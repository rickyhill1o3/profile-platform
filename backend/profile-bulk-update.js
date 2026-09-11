const PROFILE_STATE_BY_CODE = Object.freeze({
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
});

const PROFILE_STATE_BY_NAME = new Map(
    Object.values(PROFILE_STATE_BY_CODE).map((name) => [name.toLowerCase(), name])
);

function normalizeBulkProfileState(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    return PROFILE_STATE_BY_CODE[input.toUpperCase()] || PROFILE_STATE_BY_NAME.get(input.toLowerCase()) || '';
}

module.exports = {
    PROFILE_STATE_BY_CODE,
    normalizeBulkProfileState
};

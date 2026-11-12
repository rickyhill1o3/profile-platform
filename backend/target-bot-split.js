const TARGET_BOT_SPLIT_BOTS = Object.freeze(['refract', 'valor', 'shikari', 'polar']);
const DEFAULT_ACTIVE_TARGET_SPLIT_BOTS = Object.freeze(['valor', 'shikari', 'polar']);

function normalizeSplitBot(value = '') {
    const bot = String(value || '').trim().toLowerCase();
    return TARGET_BOT_SPLIT_BOTS.includes(bot) ? bot : '';
}

function normalizeActiveSplitBots(values, fallback = DEFAULT_ACTIVE_TARGET_SPLIT_BOTS) {
    const requested = new Set((Array.isArray(values) ? values : []).map(normalizeSplitBot).filter(Boolean));
    const normalized = TARGET_BOT_SPLIT_BOTS.filter((bot) => requested.has(bot));
    if (normalized.length) return normalized;
    return Array.isArray(fallback) ? TARGET_BOT_SPLIT_BOTS.filter((bot) => fallback.includes(bot)) : [];
}

function stableText(value = '') {
    return String(value == null ? '' : value).trim();
}

function rotateBots(bots, offset = 0) {
    const length = bots.length;
    const start = ((Number(offset) || 0) % length + length) % length;
    return [...bots.slice(start), ...bots.slice(0, start)];
}

function buildBalancedTargetBotSplit(rows = [], options = {}) {
    const revision = Math.max(0, Number.parseInt(options.revision, 10) || 0);
    const activeBots = normalizeActiveSplitBots(options.activeBots);
    const unique = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = stableText(row?.id);
        if (!id || unique.has(id)) continue;
        unique.set(id, {
            id,
            address_key: stableText(row?.address_key) || `profile:${id}`,
            address_label: stableText(row?.address_label) || 'Address unavailable',
            profile_name: stableText(row?.profile_name)
        });
    }

    const groups = new Map();
    for (const row of unique.values()) {
        if (!groups.has(row.address_key)) {
            groups.set(row.address_key, {
                address_key: row.address_key,
                address_label: row.address_label,
                profiles: []
            });
        }
        groups.get(row.address_key).profiles.push(row);
    }

    const orderedGroups = [...groups.values()]
        .map((group) => ({
            ...group,
            profiles: group.profiles.sort((a, b) => a.id.localeCompare(b.id))
        }))
        .sort((a, b) => b.profiles.length - a.profiles.length || a.address_key.localeCompare(b.address_key));

    const assignments = {};
    const address_keys = {};
    const totals = Object.fromEntries(TARGET_BOT_SPLIT_BOTS.map((bot) => [bot, 0]));
    const address_breakdown = [];

    orderedGroups.forEach((group, groupIndex) => {
        const size = group.profiles.length;
        const base = Math.floor(size / activeBots.length);
        const remainder = size % activeBots.length;
        const quotas = Object.fromEntries(TARGET_BOT_SPLIT_BOTS.map((bot) => [bot, activeBots.includes(bot) ? base : 0]));
        const tieOrder = rotateBots(activeBots, revision + groupIndex);
        const botsWithExtra = new Set();

        for (let extra = 0; extra < remainder; extra += 1) {
            const chosen = activeBots.filter((bot) => !botsWithExtra.has(bot)).sort((a, b) => {
                const aProjected = totals[a] + quotas[a];
                const bProjected = totals[b] + quotas[b];
                return aProjected - bProjected || tieOrder.indexOf(a) - tieOrder.indexOf(b);
            })[0];
            quotas[chosen] += 1;
            botsWithExtra.add(chosen);
        }

        const remaining = { ...quotas };
        const assignmentOrder = rotateBots(activeBots, revision + groupIndex);
        let cursor = 0;
        for (const profile of group.profiles) {
            let chosen = '';
            for (let attempt = 0; attempt < assignmentOrder.length; attempt += 1) {
                const candidate = assignmentOrder[(cursor + attempt) % assignmentOrder.length];
                if (remaining[candidate] > 0) {
                    chosen = candidate;
                    cursor = (cursor + attempt + 1) % assignmentOrder.length;
                    break;
                }
            }
            if (!chosen) chosen = activeBots[0];
            assignments[profile.id] = chosen;
            address_keys[profile.id] = profile.address_key;
            remaining[chosen] = Math.max(0, remaining[chosen] - 1);
            totals[chosen] += 1;
        }

        address_breakdown.push({
            address_key: group.address_key,
            address_label: group.address_label,
            total: size,
            counts: { ...quotas }
        });
    });

    return {
        version: 1,
        revision,
        active_bots: activeBots,
        assignments,
        address_keys,
        counts: totals,
        total_profiles: unique.size,
        address_breakdown
    };
}

function isSplitCurrent(split = {}, rows = [], activeBots = null) {
    if (!Array.isArray(split?.active_bots)) return false;
    const expectedActiveBots = normalizeActiveSplitBots(activeBots || split.active_bots);
    const savedActiveBots = normalizeActiveSplitBots(split.active_bots);
    if (expectedActiveBots.join('|') !== savedActiveBots.join('|')) return false;
    const expected = new Set((Array.isArray(rows) ? rows : []).map((row) => stableText(row?.id)).filter(Boolean));
    const assignments = split && typeof split.assignments === 'object' && split.assignments ? split.assignments : {};
    const addressKeys = split && typeof split.address_keys === 'object' && split.address_keys ? split.address_keys : {};
    const assignedIds = Object.keys(assignments).filter((id) => normalizeSplitBot(assignments[id]));
    if (expected.size !== assignedIds.length) return false;
    const rowById = new Map((Array.isArray(rows) ? rows : []).map((row) => [stableText(row?.id), stableText(row?.address_key)]));
    return assignedIds.every((id) => expected.has(id)
        && expectedActiveBots.includes(normalizeSplitBot(assignments[id]))
        && stableText(addressKeys[id]) === rowById.get(id));
}

module.exports = {
    TARGET_BOT_SPLIT_BOTS,
    DEFAULT_ACTIVE_TARGET_SPLIT_BOTS,
    normalizeSplitBot,
    normalizeActiveSplitBots,
    buildBalancedTargetBotSplit,
    isSplitCurrent
};

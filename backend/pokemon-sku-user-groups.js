'use strict';

function normalizePokemonSku(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\s+/g, '');
}

function normalizePokemonComparisonSkus(values = []) {
    const normalized = [];
    const seen = new Set();

    (Array.isArray(values) ? values : []).forEach((value) => {
        const sku = normalizePokemonSku(value);
        if (!sku || seen.has(sku)) return;
        seen.add(sku);
        normalized.push(sku);
    });

    return normalized;
}

function productSkus(value) {
    return String(value || '')
        .split(/[\n,]+/)
        .map(normalizePokemonSku)
        .filter(Boolean);
}

function combinations(indices, size, start = 0, current = [], output = []) {
    if (current.length === size) {
        output.push([...current]);
        return output;
    }

    for (let index = start; index < indices.length; index += 1) {
        current.push(indices[index]);
        combinations(indices, size, index + 1, current, output);
        current.pop();
    }

    return output;
}

function buildPokemonSkuGroupDefinitions(skus = []) {
    const normalizedSkus = normalizePokemonComparisonSkus(skus);
    const indices = normalizedSkus.map((_, index) => index);
    const groups = [];

    for (let size = normalizedSkus.length; size >= 1; size -= 1) {
        combinations(indices, size).forEach((selectedIndices) => {
            groups.push({
                id: selectedIndices.join('-'),
                match_count: selectedIndices.length,
                skus: selectedIndices.map((index) => normalizedSkus[index]),
                user_ids: []
            });
        });
    }

    return groups;
}

function groupPokemonUsersByComparedSkus(rows = [], skus = []) {
    const normalizedSkus = normalizePokemonComparisonSkus(skus);
    const requestedSkuSet = new Set(normalizedSkus);
    const matchedByUser = new Map();

    (Array.isArray(rows) ? rows : []).forEach((row) => {
        const userId = String(row?.user_id || '').trim();
        if (!userId) return;

        const selectedSkus = productSkus(row?.catalog_products?.sku || row?.sku)
            .filter((sku) => requestedSkuSet.has(sku));
        if (!selectedSkus.length) return;

        if (!matchedByUser.has(userId)) matchedByUser.set(userId, new Set());
        selectedSkus.forEach((sku) => matchedByUser.get(userId).add(sku));
    });

    const groups = buildPokemonSkuGroupDefinitions(normalizedSkus);
    const groupMap = new Map(groups.map((group) => [group.id, group]));

    matchedByUser.forEach((matchedSkus, userId) => {
        const selectedIndices = normalizedSkus
            .map((sku, index) => matchedSkus.has(sku) ? index : -1)
            .filter((index) => index >= 0);
        const group = groupMap.get(selectedIndices.join('-'));
        if (group) group.user_ids.push(userId);
    });

    groups.forEach((group) => group.user_ids.sort((a, b) => a.localeCompare(b)));
    return groups;
}

module.exports = {
    normalizePokemonSku,
    normalizePokemonComparisonSkus,
    productSkus,
    buildPokemonSkuGroupDefinitions,
    groupPokemonUsersByComparedSkus
};

function clean(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function usableHttpUrl(value) {
    const raw = clean(value);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
    } catch (_) {
        return '';
    }
}

function usableTargetTitle(value, sku) {
    const title = clean(value).replace(/\s*:\s*Target\s*$/i, '').trim();
    const compact = title.toLowerCase();
    if (!title || compact === clean(sku).toLowerCase()) return '';
    if (/^(target|target\s*:\s*expect more\.?\s*pay less\.?)$/i.test(title)) return '';
    if (/access denied|robot or human|page not found|something went wrong/i.test(title)) return '';
    return title;
}

function usableTargetPrice(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Number(number.toFixed(2));
}

function sameMoney(a, b) {
    const aa = a === '' || a === null || a === undefined ? null : Number(a);
    const bb = b === '' || b === null || b === undefined ? null : Number(b);
    if (!Number.isFinite(aa) || !Number.isFinite(bb)) return aa === bb;
    return Number(aa.toFixed(2)) === Number(bb.toFixed(2));
}

function buildTargetCatalogRefreshPatch(existing = {}, lookup = {}, now = new Date().toISOString()) {
    const patch = {};
    const changedFields = [];
    const title = usableTargetTitle(lookup.product_name, existing.sku || lookup.sku);
    const imageUrl = usableHttpUrl(lookup.image_url);
    const productUrl = usableHttpUrl(lookup.product_url);
    const price = usableTargetPrice(lookup.default_max_price);
    const incomingBrand = clean(lookup.brand);
    const existingBrand = clean(existing.brand);
    const brand = incomingBrand && (incomingBrand.toLowerCase() !== 'target' || !existingBrand)
        ? incomingBrand
        : '';

    if (title && title !== clean(existing.product_name)) {
        patch.product_name = title;
        changedFields.push('name');
    }
    if (imageUrl && imageUrl !== clean(existing.image_url)) {
        patch.image_url = imageUrl;
        changedFields.push('image');
    }
    if (productUrl && productUrl !== clean(existing.product_url)) {
        patch.product_url = productUrl;
        changedFields.push('url');
    }
    if (price !== null && !sameMoney(price, existing.default_max_price)) {
        patch.default_max_price = price;
        changedFields.push('price');
    }
    if (brand && brand !== existingBrand) {
        patch.brand = brand;
        changedFields.push('brand');
    }

    const lookupUsable = !!(title || imageUrl || price !== null);
    if (changedFields.length) {
        patch.metadata = {
            ...(existing.metadata || {}),
            ...(lookup.metadata || {}),
            last_target_rescan_at: now,
            target_rescan_changed_fields: changedFields
        };
    }

    return { patch, changedFields, lookupUsable };
}

module.exports = {
    usableTargetTitle,
    usableTargetPrice,
    buildTargetCatalogRefreshPatch
};

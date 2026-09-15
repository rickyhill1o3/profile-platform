function normalizeTargetEventEmail(value = '') {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].trim().toLowerCase() : '';
}

function normalizeTargetEventProfileName(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9@._+-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractTargetEventProfileNumber(value = '') {
    const text = normalizeTargetEventProfileName(value);
    const match = text.match(/(?:^|\b)target\s*(?:profile\s*)?(?:#\s*)?(\d{1,6})(?:\b|$)/i)
        || text.match(/(?:^|\s)(\d{1,6})(?:\s|$)/);
    return match ? String(Number(match[1])) : '';
}

function targetProfileIdentityEmails(profile = {}) {
    const candidates = [];
    for (const address of profile.addresses || []) candidates.push(address?.email);
    for (const account of profile.accounts || []) {
        candidates.push(account?.login_email, account?.email, account?.account_email);
    }
    const targetCredential = profile.store_credentials?.target || {};
    candidates.push(targetCredential.login_email, targetCredential.email);
    return [...new Set(candidates.map(normalizeTargetEventEmail).filter(Boolean))];
}

function setUniqueIdentity(map, duplicates, key, profile) {
    if (!key || !profile) return;
    if (map.has(key) && String(map.get(key)?.id || '') !== String(profile.id || '')) {
        duplicates.add(key);
        map.delete(key);
        return;
    }
    if (!duplicates.has(key)) map.set(key, profile);
}

function buildTargetProfileOwnershipIndex(profiles = []) {
    const byId = new Map();
    const byEmail = new Map();
    const byName = new Map();
    const byProfileNumber = new Map();
    const duplicateEmails = new Set();
    const duplicateNames = new Set();
    const duplicateProfileNumbers = new Set();

    for (const profile of profiles || []) {
        const profileId = String(profile?.id || '');
        if (!profileId) continue;
        byId.set(profileId, profile);
        for (const email of targetProfileIdentityEmails(profile)) {
            setUniqueIdentity(byEmail, duplicateEmails, email, profile);
        }
        setUniqueIdentity(
            byName,
            duplicateNames,
            normalizeTargetEventProfileName(profile.profile_name || ''),
            profile
        );
        setUniqueIdentity(
            byProfileNumber,
            duplicateProfileNumbers,
            extractTargetEventProfileNumber(profile.profile_name || ''),
            profile
        );
    }

    return { byId, byEmail, byName, byProfileNumber };
}

function resolveOwnedTargetProfile(index, parsed = {}, options = {}) {
    const accountEmail = normalizeTargetEventEmail(parsed.accountEmail || parsed.account_email || '');
    if (accountEmail) {
        const exactProfile = index?.byEmail?.get(accountEmail) || null;
        if (exactProfile || !options.allowProfileFallbackWhenEmailUnmatched) return exactProfile;
    }
    if (!options.allowProfileFallback) return null;

    const profileName = normalizeTargetEventProfileName(parsed.profileName || parsed.profile_name || '');
    if (profileName && index?.byName?.has(profileName)) return index.byName.get(profileName);
    const profileNumber = extractTargetEventProfileNumber(parsed.profileName || parsed.profile_name || '');
    return profileNumber ? (index?.byProfileNumber?.get(profileNumber) || null) : null;
}

function storedTargetEventBelongsToProfile(event = {}, profile = {}) {
    if (!event?.profile_id || String(event.profile_id) !== String(profile?.id || '')) return false;
    const eventEmail = normalizeTargetEventEmail(event.account_email || '');
    if (!eventEmail) return false;
    return targetProfileIdentityEmails(profile).includes(eventEmail);
}

function addTargetEvent(bucket, event, seenKeys) {
    if (!bucket || !event) return false;
    const orderId = String(event.order_id || '').trim();
    const stableId = String(event.id || '').trim();
    const key = orderId
        ? `${event.category || 'other'}:order:${orderId}`
        : `${event.category || 'other'}:event:${stableId}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    bucket.push(event);
    return true;
}

function buildUserScopedTargetEvents({ profiles = [], storedEvents = [], ownedOrders = [], classifyPayload }) {
    const index = buildTargetProfileOwnershipIndex(profiles);
    const eventsByProfile = new Map((profiles || []).map((profile) => [String(profile.id), []]));
    const seenByProfile = new Map((profiles || []).map((profile) => [String(profile.id), new Set()]));
    const acceptedStoredEvents = [];
    let matchedEvents = 0;

    for (const row of storedEvents || []) {
        const profile = index.byId.get(String(row?.profile_id || ''));
        if (!profile || !storedTargetEventBelongsToProfile(row, profile)) continue;
        const profileId = String(profile.id);
        const event = {
            id: String(row.webhook_log_id || row.id || ''),
            created_at: row.event_at || row.created_at,
            category: row.category || 'other',
            address_version_id: row.address_version_id || null,
            reason: row.reason || '',
            order_id: row.order_id || '',
            product: row.product || '',
            sku: row.sku || '',
            bot: row.bot || '',
            account_email: normalizeTargetEventEmail(row.account_email || '')
        };
        if (addTargetEvent(eventsByProfile.get(profileId), event, seenByProfile.get(profileId))) {
            acceptedStoredEvents.push(row);
            matchedEvents += 1;
        }
    }

    for (const order of ownedOrders || []) {
        const rawPayload = order?.raw_payload || {};
        const parsed = typeof classifyPayload === 'function' ? (classifyPayload(rawPayload) || {}) : {};
        const metadata = order?.metadata || {};
        const accountEmail = normalizeTargetEventEmail(
            parsed.accountEmail || metadata.checkout_account_email || metadata.account_email || ''
        );
        const profile = resolveOwnedTargetProfile(index, {
            accountEmail,
            profileName: parsed.profileName || metadata.profile_name || rawPayload.profile_name || ''
        }, {
            // The order row is already filtered by user_id, so a unique profile name may safely
            // recover an older profile whose login email was edited after checkout.
            allowProfileFallback: true,
            allowProfileFallbackWhenEmailUnmatched: true
        });
        if (!profile) continue;
        const profileId = String(profile.id);
        const event = {
            id: `order:${order.id || order.external_order_id || ''}`,
            created_at: order.created_at,
            category: 'success',
            address_version_id: null,
            reason: 'Successful checkout',
            order_id: parsed.orderId || order.external_order_id || '',
            product: order.product_name || '',
            sku: order.sku || '',
            bot: order.source || '',
            account_email: accountEmail || targetProfileIdentityEmails(profile)[0] || ''
        };
        if (addTargetEvent(eventsByProfile.get(profileId), event, seenByProfile.get(profileId))) matchedEvents += 1;
    }

    return { eventsByProfile, acceptedStoredEvents, matchedEvents, ownershipIndex: index };
}

module.exports = {
    normalizeTargetEventEmail,
    normalizeTargetEventProfileName,
    extractTargetEventProfileNumber,
    targetProfileIdentityEmails,
    buildTargetProfileOwnershipIndex,
    resolveOwnedTargetProfile,
    storedTargetEventBelongsToProfile,
    buildUserScopedTargetEvents
};

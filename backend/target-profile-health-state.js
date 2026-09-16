function targetHealthTimestamp(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function targetHealthStatusFromEvent(event) {
    return ['success', 'reseller', 'order_id', 'other'].includes(event?.category)
        ? event.category
        : 'no_activity';
}

function targetAddressVersionChangeTime(version = null, addressVersions = []) {
    if (!version) return { timestamp: 0, iso: null };
    const validFromMs = targetHealthTimestamp(version.valid_from);
    const createdAtMs = targetHealthTimestamp(version.created_at);
    const hasPreviousAddressVersion = (Array.isArray(addressVersions) ? addressVersions : [])
        .some((candidate) => String(candidate?.id || '') !== String(version.id || ''));

    // The first address version is a baseline and may intentionally be backfilled to the
    // profile's original date. Every later fingerprint is a real address change, so its database
    // creation time is the lower bound. This also repairs rows that an older dashboard refresh
    // accidentally rewound to the profile's original timestamp.
    const timestamp = hasPreviousAddressVersion
        ? Math.max(validFromMs, createdAtMs)
        : (validFromMs || createdAtMs);
    return {
        timestamp,
        iso: timestamp ? new Date(timestamp).toISOString() : null
    };
}

function deriveTargetProfileHealthState({ events = [], addressVersions = [], profileModifiedAt = null } = {}) {
    const orderedEvents = [...(Array.isArray(events) ? events : [])]
        .sort((a, b) => targetHealthTimestamp(b?.created_at) - targetHealthTimestamp(a?.created_at));
    const orderedVersions = [...(Array.isArray(addressVersions) ? addressVersions : [])]
        .sort((a, b) => targetHealthTimestamp(b?.valid_from) - targetHealthTimestamp(a?.valid_from));
    const latestEvent = orderedEvents[0] || null;
    const lastResellerEvent = orderedEvents.find((event) => event?.category === 'reseller') || null;
    const lastResellerMs = targetHealthTimestamp(lastResellerEvent?.created_at);
    const currentVersion = orderedVersions.find((version) => version?.is_current || !version?.valid_to) || orderedVersions[0] || null;
    const currentVersionChange = targetAddressVersionChangeTime(currentVersion, orderedVersions);
    const currentVersionMs = currentVersionChange.timestamp;
    const hasPreviousAddressVersion = Boolean(currentVersion && orderedVersions.some((version) => String(version?.id || '') !== String(currentVersion.id || '')));
    const lastResellerVersionId = String(lastResellerEvent?.address_version_id || '');
    const currentVersionId = String(currentVersion?.id || '');

    // A new address version is only created when the address fingerprint changes. That makes this
    // stricter than profile.updated_at, which can also move when a password or another field changes.
    const addressChangedAfterReseller = Boolean(
        lastResellerMs &&
        currentVersionMs > lastResellerMs &&
        hasPreviousAddressVersion &&
        (!lastResellerVersionId || lastResellerVersionId !== currentVersionId)
    );
    const postChangeEvents = addressChangedAfterReseller
        ? orderedEvents.filter((event) => targetHealthTimestamp(event?.created_at) >= currentVersionMs)
        : [];

    if (addressChangedAfterReseller && !postChangeEvents.length) {
        return {
            current_status: 'standby',
            reseller_needs_attention: false,
            standby_since: currentVersionChange.iso,
            standby_reason: 'address_changed_after_reseller',
            address_changed_after_reseller: true,
            latest_post_change_event: null,
            last_reseller_event: lastResellerEvent
        };
    }

    if (addressChangedAfterReseller && postChangeEvents.length) {
        return {
            current_status: targetHealthStatusFromEvent(postChangeEvents[0]),
            reseller_needs_attention: postChangeEvents[0]?.category === 'reseller',
            standby_since: null,
            standby_reason: null,
            address_changed_after_reseller: true,
            latest_post_change_event: postChangeEvents[0],
            last_reseller_event: lastResellerEvent
        };
    }

    const profileModifiedMs = targetHealthTimestamp(profileModifiedAt);
    const resellerNeedsAttention = Boolean(lastResellerMs && lastResellerMs >= profileModifiedMs);
    return {
        current_status: resellerNeedsAttention ? 'reseller' : targetHealthStatusFromEvent(latestEvent),
        reseller_needs_attention: resellerNeedsAttention,
        standby_since: null,
        standby_reason: null,
        address_changed_after_reseller: false,
        latest_post_change_event: null,
        last_reseller_event: lastResellerEvent
    };
}

module.exports = {
    deriveTargetProfileHealthState,
    targetAddressVersionChangeTime,
    targetHealthStatusFromEvent,
    targetHealthTimestamp
};

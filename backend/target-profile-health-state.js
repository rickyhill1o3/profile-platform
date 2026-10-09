function targetHealthTimestamp(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function targetHealthStatusFromEvent(event) {
    return ['success', 'reseller', 'order_id', 'other'].includes(event?.category)
        ? event.category
        : 'no_activity';
}

function targetHealthEventTime(event = null) {
    return targetHealthTimestamp(event?.event_at || event?.created_at);
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
        .sort((a, b) => targetHealthEventTime(b) - targetHealthEventTime(a));
    const orderedVersions = [...(Array.isArray(addressVersions) ? addressVersions : [])]
        .sort((a, b) => targetHealthTimestamp(b?.valid_from) - targetHealthTimestamp(a?.valid_from));
    const latestEvent = orderedEvents[0] || null;
    const latestEventMs = targetHealthEventTime(latestEvent);
    const lastResellerEvent = orderedEvents.find((event) => event?.category === 'reseller') || null;
    const lastResellerMs = targetHealthEventTime(lastResellerEvent);
    const currentVersion = orderedVersions.find((version) => version?.is_current || !version?.valid_to) || orderedVersions[0] || null;
    const currentVersionChange = targetAddressVersionChangeTime(currentVersion, orderedVersions);
    const currentVersionMs = currentVersionChange.timestamp;
    const hasPreviousAddressVersion = Boolean(currentVersion && orderedVersions.some((version) => String(version?.id || '') !== String(currentVersion.id || '')));
    const lastResellerVersionId = String(lastResellerEvent?.address_version_id || '');
    const currentVersionId = String(currentVersion?.id || '');

    // Saving an existing Target profile creates a new current version, even when its address did
    // not change. A changed profile must wait in standby until a newer checkout tests the saved
    // details. This applies after every prior result: success, reseller, order ID, or other.
    const profileChangedAfterLatestAttempt = Boolean(
        currentVersion &&
        hasPreviousAddressVersion &&
        currentVersionMs &&
        (!latestEventMs || currentVersionMs > latestEventMs)
    );
    const addressChangedAfterReseller = Boolean(
        lastResellerMs &&
        currentVersionMs > lastResellerMs &&
        hasPreviousAddressVersion &&
        (!lastResellerVersionId || lastResellerVersionId !== currentVersionId)
    );
    const postChangeEvents = currentVersionMs
        ? orderedEvents.filter((event) => targetHealthEventTime(event) >= currentVersionMs)
        : [];

    if (profileChangedAfterLatestAttempt && !postChangeEvents.length) {
        return {
            current_status: 'standby',
            reseller_needs_attention: false,
            standby_since: currentVersionChange.iso,
            standby_reason: 'profile_changed_waiting_for_checkout',
            profile_changed_after_checkout: true,
            address_changed_after_reseller: addressChangedAfterReseller,
            latest_post_change_event: null,
            last_reseller_event: lastResellerEvent
        };
    }

    if (postChangeEvents.length) {
        return {
            current_status: targetHealthStatusFromEvent(postChangeEvents[0]),
            reseller_needs_attention: postChangeEvents[0]?.category === 'reseller',
            standby_since: null,
            standby_reason: null,
            profile_changed_after_checkout: false,
            address_changed_after_reseller: addressChangedAfterReseller,
            latest_post_change_event: postChangeEvents[0],
            last_reseller_event: lastResellerEvent
        };
    }

    const resellerNeedsAttention = latestEvent?.category === 'reseller';
    return {
        current_status: resellerNeedsAttention ? 'reseller' : targetHealthStatusFromEvent(latestEvent),
        reseller_needs_attention: resellerNeedsAttention,
        standby_since: null,
        standby_reason: null,
        profile_changed_after_checkout: false,
        address_changed_after_reseller: false,
        latest_post_change_event: null,
        last_reseller_event: lastResellerEvent
    };
}

module.exports = {
    deriveTargetProfileHealthState,
    targetAddressVersionChangeTime,
    targetHealthEventTime,
    targetHealthStatusFromEvent,
    targetHealthTimestamp
};

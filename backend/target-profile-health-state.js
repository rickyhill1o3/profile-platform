function targetHealthTimestamp(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function targetHealthStatusFromEvent(event) {
    return ['success', 'reseller', 'order_id', 'other'].includes(event?.category)
        ? event.category
        : 'no_activity';
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
    const currentVersionMs = targetHealthTimestamp(currentVersion?.valid_from);
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
            standby_since: currentVersion?.valid_from || null,
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
    targetHealthStatusFromEvent,
    targetHealthTimestamp
};

function pokemonCenterHealthTimestamp(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function cleanPokemonCenterValue(value = '') {
    return String(value || '')
        .replace(/\|\|/g, ' ')
        .replace(/\*\*/g, ' ')
        .replace(/__+/g, ' ')
        .replace(/~~/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizePokemonCenterIdentity(value = '') {
    return cleanPokemonCenterValue(value)
        .toLowerCase()
        .replace(/[^a-z0-9@._+-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizePokemonCenterEmail(value = '') {
    const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].trim().toLowerCase() : '';
}

function pokemonCenterFieldMap(payload = {}) {
    const embed = Array.isArray(payload?.embeds) ? (payload.embeds[0] || {}) : {};
    const fields = {};
    for (const field of Array.isArray(embed?.fields) ? embed.fields : []) {
        const key = cleanPokemonCenterValue(field?.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
        if (key) fields[key] = cleanPokemonCenterValue(field?.value || '');
    }
    return { embed, fields };
}

function normalizePokemonCenterSite(value = '') {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isPokemonCenterSite(value = '') {
    const site = normalizePokemonCenterSite(value);
    return site === 'pokemon' || site === 'pokemoncenter' || site === 'pokemoncenterus' || site === 'pokecenter' || site === 'pc';
}

function classifyPokemonCenterProfileWebhook(payload = {}) {
    const { embed, fields } = pokemonCenterFieldMap(payload || {});
    const title = cleanPokemonCenterValue(embed?.title || payload?.title || '');
    const description = cleanPokemonCenterValue(embed?.description || payload?.description || payload?.message || '');
    const site = cleanPokemonCenterValue(fields.site || payload?.site || '');
    const combined = `${title} ${description}`.toLowerCase();
    if (!isPokemonCenterSite(site)) {
        return { category: '', title, description, site, accountEmail: '', profileName: '', orderId: '', product: '', sku: '', reason: '' };
    }

    let category = '';
    let reason = title || description || 'Pokémon Center checkout event';
    if (/successful checkout|checkout success|successfully checked out/.test(combined)) {
        category = 'success';
        reason = 'Successful checkout';
    } else if (/payment declined|card declined|insufficient funds|credit limit|decision manager|declin(?:e|ed)|payment rejected|order has been rejected/.test(combined)) {
        category = 'payment_decline';
        reason = description || title || 'Payment declined';
    } else if (/checkout error|failed|failure|unable|out of stock|\boos\b|cancel(?:led|ed)?|error/.test(combined)) {
        category = 'other';
        reason = description || title || 'Other checkout error';
    }

    return {
        category,
        title,
        description,
        site,
        accountEmail: normalizePokemonCenterEmail(fields.email || fields.account || payload?.email || payload?.account || ''),
        profileName: cleanPokemonCenterValue(fields.profile || fields['profile name'] || payload?.profile || payload?.profile_name || ''),
        orderId: cleanPokemonCenterValue(fields['order id'] || fields.order || payload?.order_id || payload?.order_number || ''),
        product: cleanPokemonCenterValue(fields.product || payload?.product || payload?.product_name || ''),
        sku: cleanPokemonCenterValue(fields.sku || payload?.sku || ''),
        reason
    };
}

function pokemonCenterProfileEmails(profile = {}) {
    const values = [];
    for (const address of profile?.addresses || []) values.push(address?.email);
    for (const account of profile?.accounts || []) values.push(account?.login_email, account?.email, account?.account_email);
    const credential = profile?.store_credentials?.pokemoncenter || {};
    values.push(credential.login_email, credential.email);
    return [...new Set(values.map(normalizePokemonCenterEmail).filter(Boolean))];
}

function buildPokemonCenterProfileIndex(profiles = []) {
    const byId = new Map();
    const byName = new Map();
    const byEmail = new Map();
    for (const profile of profiles || []) {
        const id = String(profile?.id || '');
        if (!id) continue;
        byId.set(id, profile);
        const name = normalizePokemonCenterIdentity(profile?.profile_name || '');
        if (name) {
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(profile);
        }
        for (const email of pokemonCenterProfileEmails(profile)) {
            if (!byEmail.has(email)) byEmail.set(email, []);
            byEmail.get(email).push(profile);
        }
    }
    return { byId, byName, byEmail };
}

function onePokemonCenterProfile(rows = []) {
    const unique = [...new Map((rows || []).map((profile) => [String(profile?.id || ''), profile])).values()].filter((profile) => profile?.id);
    return unique.length === 1 ? unique[0] : null;
}

function resolveOwnedPokemonCenterProfile(index, parsed = {}) {
    const name = normalizePokemonCenterIdentity(parsed?.profileName || parsed?.profile_name || '');
    const email = normalizePokemonCenterEmail(parsed?.accountEmail || parsed?.account_email || '');
    const nameMatches = name ? (index?.byName?.get(name) || []) : [];

    // Stellar's Profile field is authoritative for Pokémon Center. Its Email field can be the
    // first queue entry and may belong to a different attempt, so use email only to break a
    // duplicate-name tie or when the webhook does not contain a profile name.
    if (nameMatches.length === 1) return nameMatches[0];
    if (nameMatches.length > 1 && email) {
        const narrowed = nameMatches.filter((profile) => pokemonCenterProfileEmails(profile).includes(email));
        return onePokemonCenterProfile(narrowed);
    }
    if (!nameMatches.length && email) return onePokemonCenterProfile(index?.byEmail?.get(email) || []);
    return null;
}

function pokemonCenterEventTime(event = {}) {
    return pokemonCenterHealthTimestamp(event?.event_at || event?.created_at);
}

function pokemonCenterEventDayKey(event = {}, timeZone = 'America/New_York') {
    const timestamp = pokemonCenterEventTime(event);
    if (!timestamp) return '';
    const date = new Date(timestamp);
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(date).reduce((result, part) => {
            if (part.type !== 'literal') result[part.type] = part.value;
            return result;
        }, {});
        return `${parts.year}-${parts.month}-${parts.day}`;
    } catch (_) {
        return date.toISOString().slice(0, 10);
    }
}

function derivePokemonCenterProfileHealthState({ events = [], timeZone = 'America/New_York' } = {}) {
    const ordered = [...(Array.isArray(events) ? events : [])]
        .sort((a, b) => pokemonCenterEventTime(b) - pokemonCenterEventTime(a));
    const latestChange = ordered.find((event) => event?.category === 'profile_changed') || null;
    const latestChangeMs = pokemonCenterEventTime(latestChange);
    const allLatestAttempt = ordered.find((event) => ['success', 'payment_decline', 'other'].includes(event?.category)) || null;
    const attemptsAfterLatestChange = ordered.filter((event) => {
        if (!['success', 'payment_decline', 'other'].includes(event?.category)) return false;
        return !latestChangeMs || pokemonCenterEventTime(event) > latestChangeMs;
    });
    const latestAttempt = attemptsAfterLatestChange[0] || null;

    if (latestChangeMs && !latestAttempt) {
        return {
            current_status: 'standby',
            standby_since: latestChange?.event_at || latestChange?.created_at || null,
            standby_reason: 'profile_changed_waiting_for_checkout',
            latest_attempt: allLatestAttempt,
            latest_change: latestChange,
            current_activity_day: null,
            latest_day_counts: summarizePokemonCenterEvents([])
        };
    }

    if (!latestAttempt) {
        return {
            current_status: 'no_activity',
            standby_since: null,
            standby_reason: null,
            latest_attempt: null,
            latest_change: latestChange,
            current_activity_day: null,
            latest_day_counts: summarizePokemonCenterEvents([])
        };
    }

    // Pokémon Center normally accepts only the first successful checkout for the same
    // information on a release day. Later same-day attempts can be declined even though the
    // profile is good, so one success wins over every later decline on that activity day.
    const currentActivityDay = pokemonCenterEventDayKey(latestAttempt, timeZone);
    const latestDayAttempts = attemptsAfterLatestChange.filter((event) => (
        pokemonCenterEventDayKey(event, timeZone) === currentActivityDay
    ));
    const statusOrder = ['success', 'payment_decline', 'other'];
    const currentStatus = statusOrder.find((category) => (
        latestDayAttempts.some((event) => event?.category === category)
    )) || 'no_activity';
    const statusEvent = latestDayAttempts.find((event) => event?.category === currentStatus) || latestAttempt;

    return {
        current_status: currentStatus,
        standby_since: null,
        standby_reason: null,
        latest_attempt: statusEvent,
        latest_change: latestChange,
        current_activity_day: currentActivityDay,
        latest_day_counts: summarizePokemonCenterEvents(latestDayAttempts)
    };
}

function summarizePokemonCenterEvents(events = []) {
    const summary = { success: 0, payment_decline: 0, other: 0, total: 0 };
    for (const event of events || []) {
        if (!['success', 'payment_decline', 'other'].includes(event?.category)) continue;
        summary[event.category] += 1;
        summary.total += 1;
    }
    return summary;
}

function addPokemonCenterEvent(bucket, event, seen = new Set()) {
    if (!bucket || !event) return false;
    const id = String(event?.webhook_log_id || event?.id || '').trim();
    const key = id || [event.category, event.event_at || event.created_at, event.profile_name, event.product, event.reason].join('|');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    bucket.push(event);
    return true;
}

module.exports = {
    addPokemonCenterEvent,
    buildPokemonCenterProfileIndex,
    classifyPokemonCenterProfileWebhook,
    derivePokemonCenterProfileHealthState,
    isPokemonCenterSite,
    normalizePokemonCenterEmail,
    normalizePokemonCenterIdentity,
    pokemonCenterEventDayKey,
    pokemonCenterEventTime,
    pokemonCenterProfileEmails,
    resolveOwnedPokemonCenterProfile,
    summarizePokemonCenterEvents
};

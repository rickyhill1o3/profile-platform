function cleanEmailList(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => /^\S+@\S+\.\S+$/.test(value)))];
}

function buildProfileAccountsByUserStore(assignmentRows = [], exactEmailsByProfileStore = new Map(), fallbackEmailsByProfileId = new Map()) {
    const summaries = new Map();

    (Array.isArray(assignmentRows) ? assignmentRows : []).forEach((row) => {
        const userId = String(row?.user_id || '');
        const profileId = String(row?.profile_id || '');
        if (!userId || !profileId) return;

        [...new Set(Array.isArray(row.stores) ? row.stores : [])].forEach((store) => {
            const cleanStore = String(store || '').trim().toLowerCase();
            if (!cleanStore) return;

            const exactEmails = cleanEmailList(Array.from(exactEmailsByProfileStore.get(`${profileId}:${cleanStore}`) || []));
            const fallbackEmails = cleanEmailList(Array.from(fallbackEmailsByProfileId.get(profileId) || []));
            const loginEmails = exactEmails.length ? exactEmails : fallbackEmails;
            const key = `${userId}:${cleanStore}`;
            if (!summaries.has(key)) summaries.set(key, []);
            summaries.get(key).push({
                profile_id: row.profile_id,
                profile_name: row.profile_name || '',
                login_email: loginEmails[0] || '',
                login_emails: loginEmails
            });
        });
    });

    summaries.forEach((profiles) => {
        profiles.sort((a, b) => {
            const aLabel = a.profile_name || a.login_email || a.profile_id || '';
            const bLabel = b.profile_name || b.login_email || b.profile_id || '';
            return String(aLabel).localeCompare(String(bLabel));
        });
    });

    return summaries;
}

module.exports = { buildProfileAccountsByUserStore, cleanEmailList };

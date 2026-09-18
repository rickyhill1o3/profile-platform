(function exposeProfileSyncState(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ProfileSyncState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProfileSyncState() {
    function mergeStoreRows(cachedStores = [], freshStores = []) {
        const merged = [];
        const indexBySite = new Map();

        [...(cachedStores || []), ...(freshStores || [])].forEach((store) => {
            const site = String(store?.site || '').trim();
            if (!site) return;
            if (indexBySite.has(site)) {
                merged[indexBySite.get(site)] = store;
                return;
            }
            indexBySite.set(site, merged.length);
            merged.push(store);
        });

        return merged;
    }

    function mergeUser(cachedUser, freshUser) {
        return {
            ...(cachedUser || {}),
            ...(freshUser || {}),
            stores: mergeStoreRows(cachedUser?.stores, freshUser?.stores)
        };
    }

    function mergeUserCache(cachedUsers = [], freshUsers = [], replaceUserSet = false) {
        const cached = Array.isArray(cachedUsers) ? cachedUsers : [];
        const fresh = Array.isArray(freshUsers) ? freshUsers : [];
        const cachedById = new Map(cached.map((user) => [String(user?.id || ''), user]));

        if (replaceUserSet) {
            return fresh
                .filter((user) => user?.id)
                .map((user) => mergeUser(cachedById.get(String(user.id)), user));
        }

        const merged = cached.slice();
        const indexById = new Map(merged.map((user, index) => [String(user?.id || ''), index]));
        fresh.forEach((user) => {
            const id = String(user?.id || '');
            if (!id) return;
            if (indexById.has(id)) {
                const index = indexById.get(id);
                merged[index] = mergeUser(merged[index], user);
                return;
            }
            indexById.set(id, merged.length);
            merged.push(mergeUser(null, user));
        });

        return merged;
    }

    return { mergeUserCache };
});

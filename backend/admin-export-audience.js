function shouldExcludeCurrentUser({ currentUserRole = '', currentUserId = '', selectedUserId = '', excludeCurrentUser = false } = {}) {
    return currentUserRole === 'super_admin'
        && Boolean(currentUserId)
        && !String(selectedUserId || '').trim()
        && excludeCurrentUser === true;
}

function applyExcludeCurrentUserFilter(query, options = {}) {
    if (!query || typeof query.neq !== 'function') return query;
    if (!shouldExcludeCurrentUser(options)) return query;
    return query.neq(options.column || 'user_id', options.currentUserId);
}

module.exports = {
    applyExcludeCurrentUserFilter,
    shouldExcludeCurrentUser
};

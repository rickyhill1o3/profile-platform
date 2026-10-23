'use strict';

const MAX_EXTRA_TARGET_ACCOUNTS = 10;

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function parseExtraTargetAccountLines(raw = '') {
  const valid = [];
  const invalid = [];
  const duplicateInput = [];
  const seen = new Set();

  String(raw || '').split(/\r?\n/).forEach((sourceLine, index) => {
    const line = String(sourceLine || '').trim();
    if (!line) return;

    const separator = line.indexOf(':');
    const email = normalizeEmail(separator >= 0 ? line.slice(0, separator) : line);
    const password = separator >= 0 ? line.slice(separator + 1) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
      invalid.push({ line: index + 1, email: email || null, reason: 'Expected email:password' });
      return;
    }
    if (seen.has(email)) {
      duplicateInput.push({ line: index + 1, email });
      return;
    }
    seen.add(email);
    valid.push({ email, password });
  });

  return { valid, invalid, duplicateInput };
}

function clampDesiredCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count)) return MAX_EXTRA_TARGET_ACCOUNTS;
  return Math.max(1, Math.min(MAX_EXTRA_TARGET_ACCOUNTS, count));
}

function stableRotation(value, length) {
  if (!length) return 0;
  const text = String(value || '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % length;
}

function normalizeDistributionProfiles(user = {}) {
  const source = Array.isArray(user.profiles)
    ? user.profiles
    : (Array.isArray(user.profile_ids) ? user.profile_ids.map((id) => ({ id })) : []);
  const seen = new Set();
  return source
    .map((profile) => ({
      id: String(profile?.id || '').trim(),
      address_key: String(profile?.address_key || profile?.id || '').trim()
    }))
    .filter((profile) => {
      if (!profile.id || seen.has(profile.id)) return false;
      seen.add(profile.id);
      return true;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function planEvenAssignments({ users = [], accounts = [], currentAssignments = [], cycleId = '', mode = 'fill' } = {}) {
  const eligibleUsers = (Array.isArray(users) ? users : [])
    .filter((user) => user && user.id)
    .map((user) => ({ ...user, profiles: normalizeDistributionProfiles(user) }))
    .filter((user) => user.profiles.length)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const enabledAccounts = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => account && account.id && String(account.status || 'available') === 'available')
    .sort((left, right) => normalizeEmail(left.login_email).localeCompare(normalizeEmail(right.login_email)));
  const eligibleIds = new Set(eligibleUsers.map((user) => String(user.id)));
  const accountIds = new Set(enabledAccounts.map((account) => String(account.id)));
  const userById = new Map(eligibleUsers.map((user) => [String(user.id), user]));
  const validProfilesByUser = new Map(eligibleUsers.map((user) => [
    String(user.id),
    new Set(user.profiles.map((profile) => profile.id))
  ]));
  const profileById = new Map(eligibleUsers.flatMap((user) => user.profiles.map((profile) => [profile.id, profile])));
  const activeAssignments = (Array.isArray(currentAssignments) ? currentAssignments : [])
    .filter((assignment) => assignment && !assignment.released_at);

  const counts = new Map(eligibleUsers.map((user) => [String(user.id), 0]));
  const profileCounts = new Map(eligibleUsers.flatMap((user) => user.profiles.map((profile) => [profile.id, 0])));
  const addressCounts = new Map(eligibleUsers.flatMap((user) => [
    ...new Set(user.profiles.map((profile) => profile.address_key))
  ].map((addressKey) => [`${user.id}:${addressKey}`, 0])));
  const kept = [];
  const release = [];
  const preservedAccountIds = new Set();
  const sortedPreserved = [...activeAssignments].sort((left, right) => String(left.assigned_at || '').localeCompare(String(right.assigned_at || '')));
  sortedPreserved.forEach((assignment) => {
    const userId = String(assignment.user_id);
    const profileId = String(assignment.template_profile_id || '');
    const accountId = String(assignment.account_id || '');
    const user = userById.get(userId);
    const profile = profileById.get(profileId);
    const isValid = mode !== 'new_cycle'
      && user
      && eligibleIds.has(userId)
      && accountIds.has(accountId)
      && validProfilesByUser.get(userId)?.has(profileId)
      && profile
      && !preservedAccountIds.has(accountId);
    if (!isValid) {
      release.push(assignment);
      return;
    }
    kept.push(assignment);
    counts.set(userId, (counts.get(userId) || 0) + 1);
    profileCounts.set(profileId, (profileCounts.get(profileId) || 0) + 1);
    const addressCountKey = `${userId}:${profile.address_key}`;
    addressCounts.set(addressCountKey, (addressCounts.get(addressCountKey) || 0) + 1);
    preservedAccountIds.add(accountId);
  });

  const available = enabledAccounts.filter((account) => !preservedAccountIds.has(String(account.id)));
  const rotation = stableRotation(cycleId, eligibleUsers.length);
  const rotatedUsers = eligibleUsers.length
    ? eligibleUsers.slice(rotation).concat(eligibleUsers.slice(0, rotation))
    : [];
  const userRank = new Map(rotatedUsers.map((user, index) => [String(user.id), index]));
  const create = [];

  available.forEach((account) => {
    const candidates = [...eligibleUsers];
    if (!candidates.length) return;
    candidates.sort((left, right) => {
      const countDifference = (counts.get(String(left.id)) || 0) - (counts.get(String(right.id)) || 0);
      if (countDifference) return countDifference;
      return (userRank.get(String(left.id)) || 0) - (userRank.get(String(right.id)) || 0);
    });
    const user = candidates[0];
    const userId = String(user.id);
    const addressGroups = new Map();
    user.profiles.forEach((profile) => {
      if (!addressGroups.has(profile.address_key)) addressGroups.set(profile.address_key, []);
      addressGroups.get(profile.address_key).push(profile);
    });
    const addressRotation = stableRotation(`${cycleId}:${userId}:address`, addressGroups.size);
    const addresses = [...addressGroups.keys()].sort();
    const rotatedAddresses = addresses.slice(addressRotation).concat(addresses.slice(0, addressRotation));
    const addressRank = new Map(rotatedAddresses.map((addressKey, index) => [addressKey, index]));
    rotatedAddresses.sort((left, right) => {
      const countDifference = (addressCounts.get(`${userId}:${left}`) || 0) - (addressCounts.get(`${userId}:${right}`) || 0);
      if (countDifference) return countDifference;
      return (addressRank.get(left) || 0) - (addressRank.get(right) || 0);
    });
    const addressKey = rotatedAddresses[0];
    const profileCandidates = [...(addressGroups.get(addressKey) || [])];
    const profileRotation = stableRotation(`${cycleId}:${userId}:${addressKey}:profile`, profileCandidates.length);
    const rotatedProfiles = profileCandidates.slice(profileRotation).concat(profileCandidates.slice(0, profileRotation));
    const profileRank = new Map(rotatedProfiles.map((profile, index) => [profile.id, index]));
    rotatedProfiles.sort((left, right) => {
      const countDifference = (profileCounts.get(left.id) || 0) - (profileCounts.get(right.id) || 0);
      if (countDifference) return countDifference;
      return (profileRank.get(left.id) || 0) - (profileRank.get(right.id) || 0);
    });
    const profile = rotatedProfiles[0];
    if (!profile) return;
    create.push({
      account_id: account.id,
      user_id: user.id,
      template_profile_id: profile.id,
      cycle_id: cycleId
    });
    counts.set(userId, (counts.get(userId) || 0) + 1);
    profileCounts.set(profile.id, (profileCounts.get(profile.id) || 0) + 1);
    const addressCountKey = `${userId}:${addressKey}`;
    addressCounts.set(addressCountKey, (addressCounts.get(addressCountKey) || 0) + 1);
  });

  return {
    keep: kept,
    release,
    create,
    unassignedAccountIds: available
      .filter((account) => !create.some((assignment) => String(assignment.account_id) === String(account.id)))
      .map((account) => account.id),
    counts: Object.fromEntries([...counts.entries()]),
    profile_counts: Object.fromEntries([...profileCounts.entries()]),
    address_counts: Object.fromEntries([...addressCounts.entries()])
  };
}

function resolveAssignmentAtTime(assignments = [], eventAt = new Date()) {
  const eventTime = new Date(eventAt).getTime();
  if (!Number.isFinite(eventTime)) return null;
  return (Array.isArray(assignments) ? assignments : [])
    .filter((assignment) => {
      const assignedAt = new Date(assignment.assigned_at).getTime();
      const releasedAt = assignment.released_at ? new Date(assignment.released_at).getTime() : Number.POSITIVE_INFINITY;
      return Number.isFinite(assignedAt) && assignedAt <= eventTime && eventTime < releasedAt;
    })
    .sort((left, right) => new Date(right.assigned_at).getTime() - new Date(left.assigned_at).getTime())[0] || null;
}

function buildSyntheticTargetProfile(template = {}, account = {}, assignment = {}, index = 0) {
  const loginEmail = normalizeEmail(account.login_email);
  const syntheticId = `target-extra:${assignment.id || account.id || index}`;
  const address = { ...(template.addresses?.[0] || {}), profile_id: syntheticId, email: loginEmail };
  const baseCredentials = { ...(template.store_credentials || {}) };
  const targetCredential = {
    ...(baseCredentials.target || {}),
    profile_id: syntheticId,
    store: 'target',
    login_email: loginEmail,
    login_password: account.login_password || '',
    gmail_app_password: null,
    amazon_2fa_secret: null,
    use_aycd_inbox: false
  };
  return {
    ...template,
    id: syntheticId,
    profile_name: `${template.profile_name || 'Target'} - Extra Target ${index + 1}`,
    account_type: 'target',
    addresses: [address],
    payments: (template.payments || []).map((payment) => ({ ...payment, profile_id: syntheticId })),
    accounts: [{
      profile_id: syntheticId,
      provider: 'target',
      login_email: loginEmail,
      login_password: account.login_password || '',
      gmail_app_password: null,
      amazon_2fa_secret: null
    }],
    store_assignments: ['target'],
    store_credentials: { ...baseCredentials, target: targetCredential },
    is_target_extra_account: true,
    target_extra_assignment_id: assignment.id || null
  };
}

module.exports = {
  MAX_EXTRA_TARGET_ACCOUNTS,
  normalizeEmail,
  parseExtraTargetAccountLines,
  clampDesiredCount,
  planEvenAssignments,
  resolveAssignmentAtTime,
  buildSyntheticTargetProfile
};

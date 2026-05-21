
function normalizeAlias(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\|\|/g, '')
    .trim();
}

async function matchDiscordUser(normalized, aliases = []) {
  const profile = normalizeAlias(normalized.profile);
  const email = normalizeAlias(normalized.email);
  const proxy = normalizeAlias(normalized.proxy);

  for (const alias of aliases) {
    if (!alias) continue;

    if (profile && normalizeAlias(alias.profile_alias) === profile) {
      return alias;
    }

    if (email && normalizeAlias(alias.email_alias) === email) {
      return alias;
    }

    if (proxy && normalizeAlias(alias.proxy_alias) === proxy) {
      return alias;
    }
  }

  return null;
}

function buildDiscordMention(user) {
  if (!user?.discord_user_id) return '';
  return `<@${user.discord_user_id}>`;
}

module.exports = {
  matchDiscordUser,
  buildDiscordMention
};

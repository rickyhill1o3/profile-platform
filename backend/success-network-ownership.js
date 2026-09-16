function normalizeGuild(guild = {}) {
  return {
    id: String(guild.id || ''),
    name: String(guild.name || '').slice(0, 200),
    icon: guild.icon || null
  };
}

function mergeManageableGuilds(existingGuilds, guild) {
  const merged = new Map();
  for (const item of Array.isArray(existingGuilds) ? existingGuilds : []) {
    const normalized = normalizeGuild(item);
    if (normalized.id) merged.set(normalized.id, normalized);
  }
  const normalizedGuild = normalizeGuild(guild);
  if (normalizedGuild.id) merged.set(normalizedGuild.id, normalizedGuild);
  return [...merged.values()];
}

function removeManageableGuild(existingGuilds, guildId) {
  const removeId = String(guildId || '');
  return (Array.isArray(existingGuilds) ? existingGuilds : [])
    .map(normalizeGuild)
    .filter(guild => guild.id && guild.id !== removeId);
}

module.exports = { mergeManageableGuilds, removeManageableGuild };


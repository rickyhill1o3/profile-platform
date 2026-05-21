
function maskEmail(email = '') {
  email = String(email || '').replace(/\|\|/g, '').trim();

  const parts = email.split('@');

  if (parts.length !== 2) {
    return 'hidden';
  }

  const [name, domain] = parts;

  return `${name.slice(0, 3)}***@${domain}`;
}

function maskProfile(profile = '') {
  profile = String(profile || '').replace(/\|\|/g, '').trim();

  if (!profile) return 'hidden';

  if (profile.length <= 8) {
    return profile.slice(0, 2) + '***';
  }

  return profile.slice(0, 8) + '***';
}

function buildSuperAdminWebhook(normalized, discordUser = null) {
  return {
    embeds: [
      {
        title: normalized.status,
        description: normalized.product,
        thumbnail: normalized.image ? { url: normalized.image } : undefined,
        footer: {
          text: normalized.footer || normalized.bot
        },
        fields: [
          {
            name: 'Discord User',
            value: discordUser?.discord_user_id
              ? `<@${discordUser.discord_user_id}>`
              : 'Unknown',
            inline: true
          },
          {
            name: 'Bot',
            value: normalized.bot || 'unknown',
            inline: true
          },
          {
            name: 'SKU',
            value: normalized.sku || '-',
            inline: true
          },
          {
            name: 'Mode',
            value: normalized.mode || '-',
            inline: true
          },
          {
            name: 'Quantity',
            value: normalized.quantity || '-',
            inline: true
          },
          {
            name: 'Order Status',
            value: normalized.orderStatus || '-',
            inline: true
          },
          {
            name: 'Fraud Status',
            value: normalized.fraudStatus || '-',
            inline: true
          },
          {
            name: 'Order ID',
            value: normalized.orderId || '-',
            inline: true
          },
          {
            name: 'Email',
            value: normalized.email || '-',
            inline: false
          },
          {
            name: 'Profile',
            value: normalized.profile || '-',
            inline: false
          },
          {
            name: 'Proxy',
            value: normalized.proxy || '-',
            inline: false
          }
        ].filter(Boolean)
      }
    ]
  };
}

function buildAdminWebhook(normalized, discordUser = null) {
  return {
    embeds: [
      {
        title: normalized.status,
        description: normalized.product,
        thumbnail: normalized.image ? { url: normalized.image } : undefined,
        footer: {
          text: normalized.footer || normalized.bot
        },
        fields: [
          {
            name: 'Discord User',
            value: discordUser?.discord_user_id
              ? `<@${discordUser.discord_user_id}>`
              : 'Unknown',
            inline: true
          },
          {
            name: 'Bot',
            value: normalized.bot || 'unknown',
            inline: true
          },
          {
            name: 'SKU',
            value: normalized.sku || '-',
            inline: true
          },
          {
            name: 'Mode',
            value: normalized.mode || '-',
            inline: true
          },
          {
            name: 'Quantity',
            value: normalized.quantity || '-',
            inline: true
          },
          {
            name: 'Order Status',
            value: normalized.orderStatus || '-',
            inline: true
          },
          {
            name: 'Fraud Status',
            value: normalized.fraudStatus || '-',
            inline: true
          },
          {
            name: 'Email',
            value: maskEmail(normalized.email),
            inline: false
          },
          {
            name: 'Profile',
            value: maskProfile(normalized.profile),
            inline: false
          }
        ]
      }
    ]
  };
}

module.exports = {
  maskEmail,
  maskProfile,
  buildAdminWebhook,
  buildSuperAdminWebhook
};

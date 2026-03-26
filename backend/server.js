const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const registerProductCatalogRoutes = require("./product-catalog-routes");

const supabase = require("./database");
const { encrypt, decrypt } = require("./encryption");

const app = express();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

app.use(cors());
app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/webhooks/stripe")) {
        return next();
    }
    express.json()(req, res, next);
});

const phoneRegex = /^[0-9]{10}$/;
const SUPER_ADMIN_EMAIL = "theshoreshacktcg@gmail.com";

/* ================= AUTH HELPERS ================= */

async function auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header) {
        return res.status(401).json({ error: "No token" });
    }

    const token = header.split(" ")[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const { data: user, error } = await supabase
            .from("users")
            .select("*")
            .eq("id", decoded.user_id)
            .single();

        if (error || !user) {
            return res.status(401).json({ error: "User not found" });
        }

        req.user_id = user.id;
        req.role = user.role;
        req.currentUser = user;

        next();
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }
}

function admin(req, res, next) {
    if (req.role !== "admin" && req.role !== "super_admin") {
        return res.status(403).json({ error: "Admin only" });
    }
    next();
}

async function getCurrentUser(req) {
    if (req.currentUser) return req.currentUser;

    const { data: user, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", req.user_id)
        .single();

    if (error || !user) {
        throw new Error("User not found");
    }

    return user;
}

async function getUserById(userId) {
    const { data: user, error } = await supabase
        .from("users")
        .select("*")
        .eq("id", userId)
        .single();

    if (error || !user) {
        return null;
    }

    return user;
}

async function ensureUserNotRevoked(userId) {
    const user = await getUserById(userId);
    if (!user) {
        throw new Error("User not found");
    }
    if (user.revoked) {
        throw new Error("This account has been revoked");
    }
    return user;
}

function safeIn(values) {
    if (!values || values.length === 0) {
        return ["00000000-0000-0000-0000-000000000000"];
    }
    return values;
}

async function canManageTarget(currentUser, targetUser) {
    if (currentUser.role === "super_admin") {
        return true;
    }

    if (!targetUser) {
        return false;
    }

    if (targetUser.role === "super_admin") {
        return false;
    }

    if (targetUser.role === "admin") {
        return false;
    }

    return targetUser.owner_admin_id === currentUser.id;
}

async function getScopeUserIdsForAdmin(currentUser) {
    if (currentUser.role === "super_admin") {
        return null;
    }

    const { data: ownedUsers, error } = await supabase
        .from("users")
        .select("id")
        .eq("owner_admin_id", currentUser.id);

    if (error) {
        throw new Error(error.message);
    }

    const ids = (ownedUsers || []).map((user) => user.id);
    return [...new Set([currentUser.id, ...ids])];
}

async function getUserProfilesWithRelations(userId) {
    const { data, error } = await supabase
        .from("profiles")
        .select(`
      id,
      profile_name,
      account_type,
      addresses(email, phone),
      payments(card_last4)
    `)
        .eq("user_id", userId);

    if (error) {
        throw new Error(error.message);
    }

    return data || [];
}

function findDuplicateInSameGroup(
    profiles,
    currentProfileId,
    group,
    profileName,
    email,
    phone,
    cardLast4
) {
    for (const profile of profiles) {
        if (currentProfileId && profile.id === currentProfileId) {
            continue;
        }

        if (profile.account_type !== group) {
            continue;
        }

        const existingProfileName = profile.profile_name || "";
        const existingEmail = profile.addresses?.[0]?.email || "";
        const existingPhone = profile.addresses?.[0]?.phone || "";
        const existingCardLast4 = profile.payments?.[0]?.card_last4 || "";

        if (profileName && existingProfileName === profileName) {
            return "Profile name is already used in this group";
        }

        if (email && existingEmail === email) {
            return "Email is already used in this group";
        }

        if (phone && existingPhone === phone) {
            return "Phone is already used in this group";
        }

        if (cardLast4 && existingCardLast4 === cardLast4) {
            return "Card is already used in this group";
        }
    }

    return null;
}

async function upsertProfileRelations(profileId, payload) {
    const encryptedCard = encrypt(payload.card || "");
    const encryptedCVV = encrypt(payload.cvv || "");
    const cardLast4 = (payload.card || "").slice(-4);

    const { data: existingAddress } = await supabase
        .from("addresses")
        .select("id")
        .eq("profile_id", profileId)
        .maybeSingle();

    const addressPayload = {
        profile_id: profileId,
        first_name: payload.first_name,
        last_name: payload.last_name,
        email: payload.email,
        phone: payload.phone,
        address1: payload.address1,
        city: payload.city,
        state: payload.state,
        zip: payload.zip
    };

    if (existingAddress?.id) {
        const { error } = await supabase
            .from("addresses")
            .update(addressPayload)
            .eq("id", existingAddress.id);

        if (error) {
            throw new Error(error.message);
        }
    } else {
        const { error } = await supabase
            .from("addresses")
            .insert(addressPayload);

        if (error) {
            throw new Error(error.message);
        }
    }

    const { data: existingPayment } = await supabase
        .from("payments")
        .select("id")
        .eq("profile_id", profileId)
        .maybeSingle();

    const paymentPayload = {
        profile_id: profileId,
        card_encrypted: encryptedCard,
        cvv_encrypted: encryptedCVV,
        card_last4: cardLast4,
        exp_month: payload.exp_month,
        exp_year: payload.exp_year
    };

    if (existingPayment?.id) {
        const { error } = await supabase
            .from("payments")
            .update(paymentPayload)
            .eq("id", existingPayment.id);

        if (error) {
            throw new Error(error.message);
        }
    } else {
        const { error } = await supabase
            .from("payments")
            .insert(paymentPayload);

        if (error) {
            throw new Error(error.message);
        }
    }

    const accountPayload = {
        profile_id: profileId,
        provider: payload.account_type || null,
        login_email: payload.account_login_email || null,
        login_password: payload.account_login_password || null,
        gmail_app_password: payload.gmail_app_password || null,
        amazon_2fa_secret: payload.amazon_2fa_secret || null
    };

    const { data: existingAccount } = await supabase
        .from("accounts")
        .select("id")
        .eq("profile_id", profileId)
        .maybeSingle();

    const hasAnyAccountField = !!(
        accountPayload.login_email ||
        accountPayload.login_password ||
        accountPayload.gmail_app_password ||
        accountPayload.amazon_2fa_secret
    );

    if (existingAccount?.id) {
        const { error } = await supabase
            .from("accounts")
            .update(accountPayload)
            .eq("id", existingAccount.id);

        if (error) {
            throw new Error(error.message);
        }
    } else if (hasAnyAccountField) {
        const { error } = await supabase
            .from("accounts")
            .insert(accountPayload);

        if (error) {
            throw new Error(error.message);
        }
    }
}


async function sendEmail({ to, subject, text, html }) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;

    if (!host || !user || !pass || !from) {
        throw new Error("Email is not configured on the server");
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });

    return transporter.sendMail({ from, to, subject, text, html });
}

function buildAppUrl(pathname) {
    const base = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
    if (!base) return pathname;
    return base + pathname;
}



/* ================= CREDITS + BILLING HELPERS ================= */

const DEFAULT_FREE_CREDITS = Number(process.env.DEFAULT_FREE_CREDITS || 0);

function asWholeCredits(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.round(parsed));
}

function asSignedCredits(value, fallback = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.round(parsed);
}

async function maybeSingle(table, queryBuilder) {
    try {
        return await queryBuilder(supabase.from(table));
    } catch (err) {
        if (String(err.message || "").toLowerCase().includes("does not exist")) {
            return { data: null, error: null };
        }
        throw err;
    }
}

async function maybeMany(table, queryBuilder) {
    try {
        return await queryBuilder(supabase.from(table));
    } catch (err) {
        if (String(err.message || "").toLowerCase().includes("does not exist")) {
            return { data: [], error: null };
        }
        throw err;
    }
}

async function ensureUserCreditBalance(userId) {
    const { data: existing, error } = await maybeSingle("user_credit_balances", (qb) =>
        qb.select("*").eq("user_id", userId).maybeSingle()
    );
    if (error) throw new Error(error.message);
    if (existing?.user_id) return existing;

    const openingBalance = DEFAULT_FREE_CREDITS;
    const { data: inserted, error: insertError } = await supabase
        .from("user_credit_balances")
        .insert({
            user_id: userId,
            balance: openingBalance,
            lifetime_credits_granted: openingBalance,
            lifetime_credits_spent: 0
        })
        .select("*")
        .single();

    if (insertError) {
        if (String(insertError.message || '').toLowerCase().includes('does not exist')) {
            return { user_id: userId, balance: openingBalance, lifetime_credits_granted: openingBalance, lifetime_credits_spent: 0, transient: true };
        }
        throw new Error(insertError.message);
    }

    if (openingBalance > 0) {
        await supabase.from("credit_transactions").insert({
            user_id: userId,
            amount_delta: openingBalance,
            reason: "initial_balance",
            note: `Initial credit balance (${openingBalance})`,
            metadata: { source: "system_initial_balance" }
        });
    }

    return inserted;
}

async function getUserCreditBalance(userId) {
    const balance = await ensureUserCreditBalance(userId);
    return asSignedCredits(balance.balance, DEFAULT_FREE_CREDITS);
}

async function adjustUserCredits({ userId, delta, reason, note = "", metadata = {}, createdBy = null, orderId = null }) {
    const amount = Math.trunc(Number(delta || 0));
    if (!Number.isFinite(amount) || amount === 0) {
        throw new Error("A non-zero credit adjustment is required");
    }

    const current = await ensureUserCreditBalance(userId);
    const nextBalance = asSignedCredits(current.balance, 0) + amount;

    const updates = {
        balance: nextBalance,
        lifetime_credits_granted: asWholeCredits(current.lifetime_credits_granted, 0) + Math.max(amount, 0),
        lifetime_credits_spent: asWholeCredits(current.lifetime_credits_spent, 0) + Math.max(-amount, 0),
        updated_at: new Date().toISOString()
    };

    const { error: updateError } = await supabase
        .from("user_credit_balances")
        .update(updates)
        .eq("user_id", userId);

    if (updateError) throw new Error(updateError.message);

    const { error: txError } = await supabase
        .from("credit_transactions")
        .insert({
            user_id: userId,
            amount_delta: amount,
            reason,
            note,
            order_id: orderId,
            created_by: createdBy,
            balance_after: nextBalance,
            metadata
        });

    if (txError) throw new Error(txError.message);

    return nextBalance;
}

async function getProductCreditCost({ productId = null, site = "", sku = "" }) {
    if (productId) {
        const { data, error } = await supabase
            .from("catalog_products")
            .select("id, credit_cost, site, sku, product_name")
            .eq("id", productId)
            .maybeSingle();
        if (error) throw new Error(error.message);
        if (data?.id) return { credits: asWholeCredits(data.credit_cost, 0), product: data };
    }

    if (site && sku) {
        const { data, error } = await supabase
            .from("catalog_products")
            .select("id, credit_cost, site, sku, product_name")
            .eq("site", String(site).toLowerCase())
            .ilike("sku", String(sku).trim())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw new Error(error.message);
        if (data?.id) return { credits: asWholeCredits(data.credit_cost, 0), product: data };
    }

    return { credits: 0, product: null };
}

async function getCountdownCreditCost({ countdownId = null, productId = null, site = "", sku = "" }) {
    if (!countdownId) return { credits: 0, countdown: null, countdownProduct: null };

    if (productId) {
        const { data, error } = await maybeSingle("countdown_products", (qb) =>
            qb.select("id, credit_cost_override, countdown_id, product_id")
                .eq("countdown_id", countdownId)
                .eq("product_id", productId)
                .maybeSingle()
        );
        if (error) throw new Error(error.message);
        if (data?.id) return { credits: asWholeCredits(data.credit_cost_override, 0), countdown: null, countdownProduct: data };
    }

    if (site && sku) {
        const { data: product } = await supabase
            .from("catalog_products")
            .select("id")
            .eq("site", String(site).toLowerCase())
            .ilike("sku", String(sku).trim())
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (product?.id) return getCountdownCreditCost({ countdownId, productId: product.id });
    }

    const { data: countdown, error: countdownError } = await maybeSingle("drop_countdowns", (qb) =>
        qb.select("id, default_credit_cost, site, label").eq("id", countdownId).maybeSingle()
    );
    if (countdownError) throw new Error(countdownError.message);
    return { credits: asWholeCredits(countdown?.default_credit_cost, 0), countdown: countdown || null, countdownProduct: null };
}

async function resolveOrderCreditCost(payload) {
    const site = String(payload.site || "").trim().toLowerCase();
    const sku = String(payload.sku || payload.product_sku || "").trim();
    const productId = payload.product_id || payload.product_id || null;
    const countdownId = payload.countdown_id || null;

    const productMatch = await getProductCreditCost({ productId, site, sku });
    const countdownMatch = await getCountdownCreditCost({ countdownId, productId: productMatch.product?.id || productId, site, sku });

    const explicitCredits = payload.credits_charged !== undefined && payload.credits_charged !== null
        ? asWholeCredits(payload.credits_charged, 0)
        : null;

    if (explicitCredits !== null) return { credits: explicitCredits, productMatch, countdownMatch };
    if (countdownMatch.credits > 0) return { credits: countdownMatch.credits, productMatch, countdownMatch };
    if (productMatch.credits > 0) return { credits: productMatch.credits, productMatch, countdownMatch };
    return { credits: 0, productMatch, countdownMatch };
}

function normalizeFieldLabel(value = "") {
    return String(value || "")
        .toLowerCase()
        .replace(/&[#a-z0-9]+;/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function cleanFieldValue(value = "") {
    return String(value || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractEmail(value = "") {
    const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return match ? match[0].toLowerCase() : "";
}

function buildFieldMapFromEmbeds(body = {}) {
    const embed = Array.isArray(body.embeds) ? body.embeds[0] || {} : {};
    const map = {};
    for (const field of Array.isArray(embed.fields) ? embed.fields : []) {
        const key = normalizeFieldLabel(field?.name || "");
        if (key) map[key] = cleanFieldValue(field?.value || "");
    }
    return { embed, fields: map };
}

function inferSourceFromPayload(body = {}, embed = {}, fields = {}) {
    const joined = [body.username, embed.footer?.text, embed.author?.name, body.content, embed.title]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    if (joined.includes('stellar')) return 'stellar';
    if (joined.includes('prism')) return 'refract';
    if (joined.includes('refract')) return 'refract';
    return String(body.source || fields.source || 'bot').trim().toLowerCase();
}

function inferSiteFromPayload(body = {}, embed = {}, fields = {}) {
    const direct = cleanFieldValue(body.site || fields.site || "").toLowerCase();
    if (direct) {
        if (direct.includes('target')) return 'target';
        if (direct.includes('walmart')) return 'walmart';
        if (direct.includes('supreme')) return 'supreme';
        if (direct.includes('amazon')) return 'amazon';
        if (direct.includes('pokemon')) return 'pokemon';
        return direct;
    }
    const title = String(embed.title || body.title || "").toLowerCase();
    if (title.includes('walmart')) return 'walmart';
    if (title.includes('target')) return 'target';
    if (title.includes('supreme')) return 'supreme';
    if (title.includes('amazon')) return 'amazon';
    if (title.includes('pokemon')) return 'pokemon';
    return '';
}

function stableExternalOrderId(payload = {}, normalized = {}) {
    const direct = String(
        payload.external_order_id ||
        payload.order_id ||
        payload.id ||
        normalized.order_id ||
        normalized.order_number ||
        ''
    ).trim();
    if (direct) return direct;

    const fingerprint = JSON.stringify({
        source: normalized.source || '',
        site: normalized.site || '',
        account_email: normalized.account_email || '',
        profile_name: normalized.profile_name || '',
        product_name: normalized.product_name || '',
        price: normalized.price || '',
        quantity: normalized.quantity || '',
        timestamp: normalized.timestamp || '',
        raw: payload
    });

    return 'wh_' + crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 32);
}

function normalizeIncomingOrderPayload(payload = {}) {
    const { embed, fields } = buildFieldMapFromEmbeds(payload);
    const source = inferSourceFromPayload(payload, embed, fields);
    const site = inferSiteFromPayload(payload, embed, fields);
    const productName = cleanFieldValue(
        payload.product_name ||
        payload.product?.name ||
        fields['product'] ||
        fields['product name'] ||
        embed.description || ''
    );
    const orderNumber = cleanFieldValue(payload.order_number || fields['order id'] || fields['order number'] || '');
    const accountEmail = extractEmail(payload.user_email || payload.email || fields['account'] || fields['email'] || '');
    const profileName = cleanFieldValue(payload.profile_name || fields['profile'] || '');
    const sku = cleanFieldValue(payload.sku || payload.product_sku || fields['sku'] || '');
    const quantityRaw = payload.quantity ?? fields['quantity'];
    const quantity = Number.isFinite(Number(quantityRaw)) ? Math.max(1, Math.round(Number(quantityRaw))) : 1;
    const priceRaw = payload.price ?? fields['price'] ?? fields['product price'];
    const priceMatch = String(priceRaw || '').replace(/[^0-9.]/g, '');
    const price = priceMatch ? Number(priceMatch) : null;
    const productUrl = cleanFieldValue(payload.product_url || payload.url || fields['input'] || fields['share link'] || '');
    const imageUrl = payload.image_url || payload.product?.image_url || embed.thumbnail?.url || embed.image?.url || '';
    const timestamp = cleanFieldValue(payload.timestamp || embed.timestamp || embed.footer?.text || '');
    const mode = cleanFieldValue(payload.mode || fields['mode'] || '');
    const size = cleanFieldValue(payload.size || fields['product size'] || fields['product - size'] || '');
    const normalized = {
        source,
        site,
        sku,
        product_name: productName,
        quantity,
        price,
        product_url: productUrl,
        image_url: imageUrl,
        timestamp,
        mode,
        size,
        account_email: accountEmail,
        user_email: accountEmail || extractEmail(payload.customer_email || ''),
        profile_name: profileName,
        order_id: orderNumber,
        order_number: orderNumber,
        countdown_id: payload.countdown_id || null,
        raw_payload: payload
    };
    normalized.external_order_id = stableExternalOrderId(payload, normalized);
    return normalized;
}

async function findUserForWebhook(payload) {
    const normalized = normalizeIncomingOrderPayload(payload);

    const candidates = [
        payload.user_id,
        payload.metadata?.user_id,
        payload.client_reference_id,
        payload.userId
    ].filter(Boolean);

    for (const userId of candidates) {
        const user = await getUserById(userId);
        if (user) return user;
    }

    // 1. PROFILE NAME FIRST
    if (normalized.profile_name) {
        const { data: profiles, error } = await supabase
            .from('profiles')
            .select('user_id, profile_name, created_at')
            .ilike('profile_name', String(normalized.profile_name).trim())
            .order('created_at', { ascending: false });

        if (error) throw new Error(error.message);

        if (profiles?.length) {
            const profile = profiles[0];
            if (profile?.user_id) {
                const user = await getUserById(profile.user_id);
                if (user) return user;
            }
        }
    }

    // 2. ACCOUNT EMAIL SECOND
    if (normalized.account_email) {
        const { data: accounts, error: accountError } = await supabase
            .from('accounts')
            .select('profile_id, login_email, created_at')
            .ilike('login_email', String(normalized.account_email).trim())
            .order('created_at', { ascending: false });

        if (accountError) throw new Error(accountError.message);

        if (accounts?.length) {
            const account = accounts[0];

            if (account?.profile_id) {
                const { data: profiles, error: profileError } = await supabase
                    .from('profiles')
                    .select('user_id, created_at')
                    .eq('id', account.profile_id)
                    .order('created_at', { ascending: false });

                if (profileError) throw new Error(profileError.message);

                if (profiles?.length && profiles[0]?.user_id) {
                    const user = await getUserById(profiles[0].user_id);
                    if (user) return user;
                }
            }
        }
    }

    // 3. USER EMAIL LAST
    const emailCandidates = [
        payload.user_email,
        payload.email,
        payload.customer_email,
        payload.metadata?.user_email,
        normalized.user_email,
        normalized.account_email
    ].filter(Boolean);

    for (const email of emailCandidates) {
        const { data: users, error } = await supabase
            .from("users")
            .select("*")
            .ilike("email", String(email).trim())
            .order('created_at', { ascending: false });

        if (error) throw new Error(error.message);
        if (users?.length) return users[0];
    }

    return null;
}

async function createOrderRecord(payload) {
    const insertPayload = {
        user_id: payload.user_id,
        external_order_id: payload.external_order_id,
        source: payload.source || "bot",
        status: payload.status || "success",
        site: payload.site || "",
        sku: payload.sku || payload.product_sku || "",
        product_name: payload.product_name || "",
        countdown_id: payload.countdown_id || null,
        credits_charged: asWholeCredits(payload.credits_charged, 0),
        metadata: payload.metadata || {},
        raw_payload: payload.raw_payload || payload
    };
    const { data, error } = await supabase.from("orders").insert(insertPayload).select("*").single();
    if (error) throw new Error(error.message);
    return data;
}

async function getAppSetting(key, fallback = null) {
    const { data, error } = await maybeSingle('app_settings', (qb) => qb.select('value_json').eq('key', key).maybeSingle());
    if (error) throw new Error(error.message);
    return data?.value_json ?? fallback;
}

async function setAppSetting(key, value) {
    const payload = { key, value_json: value, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('app_settings').upsert(payload, { onConflict: 'key' });
    if (error) throw new Error(error.message);
    return value;
}

function getAdminWebhookSettingKey(userId) {
    return `admin_webhook_settings:${userId}`;
}

function getUserSettingsKey(userId) {
    return `user_settings:${userId}`;
}

async function getAdminWebhookSettings(userId) {
    if (!userId) return {};
    return await getAppSetting(getAdminWebhookSettingKey(userId), {});
}

async function setAdminWebhookSettings(userId, value) {
    if (!userId) throw new Error("Admin user id is required");
    return await setAppSetting(getAdminWebhookSettingKey(userId), value || {});
}

async function getUserSettings(userId) {
    if (!userId) return {};
    return await getAppSetting(getUserSettingsKey(userId), {});
}

async function setUserSettings(userId, value) {
    if (!userId) throw new Error("User id is required");
    return await setAppSetting(getUserSettingsKey(userId), value || {});
}

function normalizeDiscordHandle(value = '') {
    return String(value || '').trim();
}

function getCheckoutBannerText(brandLabel = '') {
    const extra = String(brandLabel || '').trim();
    return extra
        ? `THANK YOU FOR CHECKING OUT WITH THE SHORE SHACK x ${extra.toUpperCase()}`
        : 'THANK YOU FOR CHECKING OUT WITH THE SHORE SHACK';
}

function getApiBaseUrl(req) {
    const configured = String(process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/$/, '');
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}`;
}

async function getActiveInboundWebhook() {
    const { data, error } = await maybeSingle('inbound_webhooks', (qb) =>
        qb.select('*').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle()
    );
    if (error) throw new Error(error.message);
    return data || null;
}

async function createInboundWebhook(req, createdBy = null) {
    const { error: deactivateError } = await supabase.from('inbound_webhooks').update({ is_active: false }).eq('is_active', true);
    if (deactivateError && !String(deactivateError.message || '').toLowerCase().includes('does not exist')) {
        throw new Error(deactivateError.message);
    }

    const token = crypto.randomBytes(18).toString('hex');
    const { data, error } = await supabase
        .from('inbound_webhooks')
        .insert({ token, is_active: true, created_by: createdBy })
        .select('*')
        .single();
    if (error) throw new Error(error.message);
    return { ...data, url: `${getApiBaseUrl(req)}/webhooks/orders/${token}` };
}

function maskEmail(email = '') {
    const value = String(email || '').trim().toLowerCase();
    const parts = value.split('@');
    if (parts.length !== 2) return value || '-';
    const [name, domain] = parts;
    const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
}

const discordWebhookQueues = new Map();

function getDiscordQueue(webhookUrl) {
    const key = String(webhookUrl || '').trim();
    if (!key) throw new Error('Webhook URL is required for queue');

    if (!discordWebhookQueues.has(key)) {
        discordWebhookQueues.set(key, {
            running: false,
            jobs: [],
            lastSentAt: 0
        });
    }

    return discordWebhookQueues.get(key);
}

function enqueueDiscordWebhookJob(webhookUrl, job) {
    return new Promise((resolve, reject) => {
        const queue = getDiscordQueue(webhookUrl);
        queue.jobs.push({
            webhookUrl,
            job,
            resolve,
            reject,
            enqueuedAt: Date.now()
        });
        processDiscordQueue(webhookUrl).catch((err) => {
            console.error('Discord queue processor error:', err);
        });
    });
}

async function processDiscordQueue(webhookUrl) {
    const queue = getDiscordQueue(webhookUrl);
    if (queue.running) return;

    queue.running = true;

    try {
        while (queue.jobs.length) {
            const item = queue.jobs.shift();

            try {
                // small spacing between sends on the same webhook
                const now = Date.now();
                const minGapMs = 1200;
                const waitMs = Math.max(0, minGapMs - (now - queue.lastSentAt));
                if (waitMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                }

                const result = await item.job();
                queue.lastSentAt = Date.now();
                item.resolve(result);
            } catch (err) {
                queue.lastSentAt = Date.now();
                item.reject(err);
            }
        }
    } finally {
        queue.running = false;
    }
}

async function sendDiscordWebhookToTarget({
    webhookUrl,
    order,
    userEmail = '',
    discordHandle = '',
    brandLabel = '',
    username = 'The Shore Shack'
}) {
    const trimmedWebhookUrl = String(webhookUrl || '').trim();
    if (!trimmedWebhookUrl) {
        return { skipped: 'discord_webhook_not_configured' };
    }

    const payload = order.raw_payload || {};
    const normalized = normalizeIncomingOrderPayload(payload);
    const isInsufficient = String(order.status || '') === 'insufficient_credits';
    const mentionText = normalizeDiscordHandle(discordHandle) || maskEmail(userEmail);

    const embed = {
        title: isInsufficient
            ? `Checkout Logged • Credits Needed`
            : `Successful Checkout • ${order.site || normalized.site || order.source || 'Bot'}`,
        description: normalized.product_name || order.product_name || 'Checkout received',
        fields: [
            { name: 'Site', value: String(order.site || normalized.site || '-'), inline: true },
            { name: 'Source', value: String(order.source || normalized.source || '-'), inline: true },
            { name: 'Quantity', value: String(normalized.quantity || 1), inline: true },
            { name: 'Price', value: normalized.price ? `$${Number(normalized.price).toFixed(2)}` : '-', inline: true },
            { name: 'Credits', value: String(order.credits_charged || 0), inline: true }
        ],
        footer: {
            text: isInsufficient
                ? 'Order saved without charging credits'
                : 'Youve Been Served by The Shore Shack'
        },
        timestamp: new Date().toISOString()
    };

    if (normalized.size) {
        embed.fields.push({ name: 'Size', value: normalized.size, inline: true });
    }
    if (normalized.mode) {
        embed.fields.push({ name: 'Mode', value: normalized.mode, inline: true });
    }
    if (normalized.product_url) {
        embed.fields.push({ name: 'Product Link', value: normalized.product_url, inline: false });
    }
    if (normalized.image_url) {
        embed.thumbnail = { url: normalized.image_url };
    }

    const contentText = `Thank you ${mentionText} for checking out with The Shore Shack${brandLabel ? ` x ${brandLabel.toUpperCase()}` : ''}`;

    const body = JSON.stringify({
        username,
        content: contentText,
        embeds: [embed]
    });

    return enqueueDiscordWebhookJob(trimmedWebhookUrl, async () => {
        for (let attempt = 1; attempt <= 5; attempt++) {
            console.log(`Discord queue send attempt ${attempt} -> ${trimmedWebhookUrl.slice(0, 40)}...`);

            const response = await globalThis.fetch(trimmedWebhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body
            });

            if (response.ok) {
                console.log(`Discord queue send success on attempt ${attempt}`);
                return { success: true, attempt, queued: true };
            }

            const contentType = response.headers.get('content-type') || '';
            let text = '';
            let json = null;

            if (contentType.includes('application/json')) {
                json = await response.json().catch(() => null);
                text = JSON.stringify(json || {});
            } else {
                text = await response.text().catch(() => '');
            }

            console.error(`Discord queue send response ${response.status} on attempt ${attempt}: ${text}`);

            if (response.status === 429) {
                let retryAfterMs = 5000;

                if (json?.retry_after != null) {
                    retryAfterMs = Math.ceil(Number(json.retry_after) * 1000);
                } else {
                    const retryAfterHeader = response.headers.get('retry-after');
                    if (retryAfterHeader) {
                        retryAfterMs = Math.ceil(Number(retryAfterHeader) * 1000) || retryAfterMs;
                    }
                }

                console.log(`Discord queue rate limited. Waiting ${retryAfterMs}ms before retry...`);
                await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
                continue;
            }

            // Cloudflare / hard block: back off harder
            if (response.status === 403 || response.status === 1015 || text.includes('Error 1015') || text.includes('rate limited')) {
                const backoffMs = 15000 * attempt;
                console.log(`Discord queue Cloudflare/backoff wait ${backoffMs}ms...`);
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                continue;
            }

            throw new Error(`Discord webhook failed (${response.status}): ${text || response.statusText}`);
        }

        throw new Error('Discord webhook failed after maximum retry attempts');
    });
}

async function sendCheckoutDiscordNotifications(order, user) {
    const results = [];
    const userEmail = String(user?.email || '');
    const userSettings = user?.id ? await getUserSettings(user.id) : {};
    const discordHandle = normalizeDiscordHandle(userSettings?.discord_handle || '');

    const globalSettings = await getAppSetting('webhook_settings', {});
    const globalWebhookUrl = String(globalSettings?.discord_webhook_url || '').trim();

    if (globalWebhookUrl) {
        results.push({
            scope: 'super_admin',
            ...(await sendDiscordWebhookToTarget({
                webhookUrl: globalWebhookUrl,
                order,
                userEmail,
                discordHandle,
                brandLabel: '',
                username: 'The Shore Shack'
            }))
        });
    } else {
        results.push({ scope: 'super_admin', skipped: 'discord_webhook_not_configured' });
    }

    if (user?.owner_admin_id) {
        const adminSettings = await getAdminWebhookSettings(user.owner_admin_id);
        const adminWebhookUrl = String(adminSettings?.discord_webhook_url || '').trim();
        const brandLabel = String(adminSettings?.brand_label || '').trim();

        if (adminWebhookUrl) {
            results.push({
                scope: 'owner_admin',
                admin_user_id: user.owner_admin_id,
                ...(await sendDiscordWebhookToTarget({
                    webhookUrl: adminWebhookUrl,
                    order,
                    userEmail,
                    discordHandle,
                    brandLabel,
                    username: 'The Shore Shack'
                }))
            });
        } else {
            results.push({
                scope: 'owner_admin',
                admin_user_id: user.owner_admin_id,
                skipped: 'discord_webhook_not_configured'
            });
        }
    }

    return results;
}

async function recordSuccessfulCheckout(payload) {
    const normalized = normalizeIncomingOrderPayload(payload);
    const externalOrderId = normalized.external_order_id;
    if (!externalOrderId) throw new Error("external_order_id could not be determined");

    const { data: existing, error: existingError } = await maybeSingle("orders", (qb) =>
        qb.select("*").eq("external_order_id", externalOrderId).maybeSingle()
    );
    if (existingError) throw new Error(existingError.message);
    if (existing?.id) return { order: existing, duplicate: true };

    const user = await findUserForWebhook({ ...payload, ...normalized });
    if (!user?.id) throw new Error("Could not match webhook payload to a user");

    await ensureUserCreditBalance(user.id);
    const resolvedCost = await resolveOrderCreditCost({ ...payload, ...normalized });
    const creditsToCharge = asWholeCredits(resolvedCost.credits, 0);
    const currentBalance = await getUserCreditBalance(user.id);
    const insufficientCredits = creditsToCharge > currentBalance;

    const order = await createOrderRecord({
        ...payload,
        ...normalized,
        user_id: user.id,
        external_order_id: externalOrderId,
        status: insufficientCredits ? 'insufficient_credits' : 'success',
        credits_charged: creditsToCharge,
        metadata: {
            ...(payload.metadata || {}),
            matched_user_email: user.email,
            requested_credits: creditsToCharge,
            insufficient_credits: insufficientCredits
        },
        raw_payload: payload
    });

    let balanceAfter = currentBalance;
    if (creditsToCharge > 0) {
        balanceAfter = await adjustUserCredits({
            userId: user.id,
            delta: -creditsToCharge,
            reason: insufficientCredits ? "successful_checkout_negative_balance" : "successful_checkout",
            note: insufficientCredits
                ? `Credits charged into negative balance for checkout ${externalOrderId}`
                : `Credits charged for successful checkout ${externalOrderId}`,
            metadata: {
                source: normalized.source || payload.source || "bot_webhook",
                site: normalized.site || payload.site || "",
                sku: normalized.sku || payload.sku || payload.product_sku || "",
                countdown_id: normalized.countdown_id || payload.countdown_id || null,
                charged_while_negative: insufficientCredits
            },
            orderId: order.id
        });
    }

    let discordRelay = [{ skipped: "not_attempted" }];
    try {
        discordRelay = await sendCheckoutDiscordNotifications(order, user);
    } catch (discordErr) {
        console.error("Discord relay failed:", discordErr);
        discordRelay = [{ error: discordErr.message || String(discordErr) }];
    }

    return {
        order,
        duplicate: false,
        credits_charged: creditsToCharge,
        requested_credits: creditsToCharge,
        balance_after: balanceAfter,
        user_id: user.id,
        insufficient_credits: insufficientCredits,
        discord_relay: discordRelay
    };
}

app.post("/webhooks/stripe", bodyParser.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe) {
        console.error("Stripe webhook hit but Stripe is not configured");
        return res.status(400).json({ error: "Stripe is not configured" });
    }

    try {
        console.log("Stripe webhook hit");

        const signature = req.headers["stripe-signature"];
        const secret = process.env.STRIPE_WEBHOOK_SECRET;

        if (!signature || !secret) {
            throw new Error("Missing Stripe signature or webhook secret");
        }

        console.log("Stripe webhook info:", {
            hasSignature: !!signature,
            hasSecret: !!secret,
            secretPrefix: secret ? String(secret).slice(0, 8) : null,
            bodyIsBuffer: Buffer.isBuffer(req.body),
            bodyLength: Buffer.isBuffer(req.body) ? req.body.length : null
        });

        const event = stripe.webhooks.constructEvent(req.body, signature, secret);

        console.log("Stripe event type:", event.type);

        if (event.type === "checkout.session.completed") {
            const session = event.data.object || {};
            console.log("Stripe checkout session completed:", {
                sessionId: session.id,
                customer_email: session.customer_email || session.customer_details?.email || null,
                metadata: session.metadata || {}
            });

            const user = await findUserForWebhook(session);
            if (!user?.id) {
                console.error("Stripe webhook user not found");
                return res.json({ received: true, skipped: "user_not_found" });
            }

            const credits = asWholeCredits(session.metadata?.credits, 0);
            const externalOrderId = String(session.id || "");

            const { data: existing } = await maybeSingle("orders", (qb) =>
                qb.select("id").eq("external_order_id", externalOrderId).maybeSingle()
            );

            if (existing?.id) {
                console.log("Stripe purchase already processed:", existing.id);
                return res.json({ received: true, duplicate: true });
            }

            await createOrderRecord({
                user_id: user.id,
                external_order_id: externalOrderId,
                source: "stripe",
                status: "paid",
                product_name: `${credits} credit purchase`,
                credits_charged: 0,
                metadata: {
                    checkout_type: "credit_purchase",
                    credits_purchased: credits,
                    customer_email: session.customer_details?.email || session.customer_email || ""
                },
                raw_payload: session
            });

            if (credits > 0) {
                const balance = await adjustUserCredits({
                    userId: user.id,
                    delta: credits,
                    reason: "stripe_purchase",
                    note: `Purchased ${credits} credits via Stripe`,
                    metadata: { stripe_checkout_session_id: session.id },
                    createdBy: null
                });

                console.log("Stripe credits added successfully:", {
                    creditsAdded: credits,
                    balanceAfter: balance?.balance
                });
            }
        }

        res.json({ received: true });
    } catch (err) {
        console.error("Stripe webhook error:", err);
        res.status(400).json({ error: err.message });
    }
});

app.get("/credits/me", auth, async (req, res) => {
    try {
        const balanceRow = await ensureUserCreditBalance(req.user_id);
        res.json({
            balance: asWholeCredits(balanceRow.balance, 0),
            free_starter_credits: DEFAULT_FREE_CREDITS,
            lifetime_credits_granted: asWholeCredits(balanceRow.lifetime_credits_granted, 0),
            lifetime_credits_spent: asWholeCredits(balanceRow.lifetime_credits_spent, 0),
            monthly_fee_cents: Number(process.env.MONTHLY_MEMBERSHIP_FEE_CENTS || 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/billing/create-checkout-session", auth, async (req, res) => {
    try {
        if (!stripe) return res.status(400).json({ error: "Stripe is not configured yet" });

        const credits = asWholeCredits(req.body?.credits, 0);
        if (credits <= 0) return res.status(400).json({ error: "credits must be greater than 0" });

        const user = await getCurrentUser(req);
        const successUrl = buildAppUrl("/dashboard.html?credits=success");
        const cancelUrl = buildAppUrl("/dashboard.html?credits=cancel");

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            client_reference_id: user.id,
            customer_email: user.email,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: {
                user_id: user.id,
                user_email: user.email,
                credits: String(credits)
            },
            line_items: [{
                quantity: 1,
                price_data: {
                    currency: (process.env.STRIPE_CURRENCY || "usd"),
                    unit_amount: credits * 100,
                    product_data: {
                        name: `${credits} Credits`,
                        description: `$1 = 1 credit`
                    }
                }
            }]
        });

        res.json({ url: session.url, id: session.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function validateInboundWebhookToken(req) {
    const active = await getActiveInboundWebhook();
    if (!active?.token) return true;
    const token = String(req.params.token || req.query.token || '').trim();
    return token && token === active.token;
}

app.post(["/webhooks/orders", "/webhooks/orders/:token"], async (req, res) => {
    try {
        console.log("Inbound webhook hit", {
            path: req.originalUrl,
            hasToken: !!req.params.token,
            tokenPreview: req.params.token ? String(req.params.token).slice(0, 8) : null
        });

        const active = await getActiveInboundWebhook();
        console.log("Active webhook token preview:", active?.token ? String(active.token).slice(0, 8) : null);

        const allowed = await validateInboundWebhookToken(req);

        if (!allowed) {
            console.log("Inbound webhook rejected: invalid token", {
                provided: req.params.token ? String(req.params.token).slice(0, 8) : null,
                expected: active?.token ? String(active.token).slice(0, 8) : null
            });
            return res.status(401).json({ error: "Invalid webhook url" });
        }

        console.log("Inbound webhook accepted");

        const result = await recordSuccessfulCheckout(req.body || {});
        console.log("Inbound webhook processed successfully");
        res.json({ success: true, ...result });
    } catch (err) {
        console.error("Inbound webhook error:", err);
        res.status(400).json({ error: err.message });
    }
});

app.get("/admin/credits/users", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const scopedUserIds = await getScopeUserIdsForAdmin(currentUser);

        let query = supabase.from("users").select("id, email, role, owner_admin_id, created_at").order("created_at", { ascending: false });
        if (scopedUserIds && scopedUserIds.length) query = query.in("id", scopedUserIds);

        const { data: users, error } = await query;
        if (error) return res.status(500).json({ error: error.message });

        const userIds = (users || []).map((row) => row.id);
        const balancesByUser = new Map();
        if (userIds.length) {
            const { data: balances, error: balanceError } = await maybeMany("user_credit_balances", (qb) =>
                qb.select("*").in("user_id", userIds)
            );
            if (balanceError) return res.status(500).json({ error: balanceError.message });
            (balances || []).forEach((row) => balancesByUser.set(row.user_id, row));
        }

        const insufficientCounts = new Map();
        if (userIds.length) {
            const { data: flaggedOrders, error: flaggedError } = await supabase
                .from("orders")
                .select("user_id, status")
                .in("user_id", userIds)
                .eq("status", "insufficient_credits");
            if (flaggedError) return res.status(500).json({ error: flaggedError.message });
            for (const row of flaggedOrders || []) {
                insufficientCounts.set(row.user_id, (insufficientCounts.get(row.user_id) || 0) + 1);
            }
        }

        const items = [];
        for (const user of users || []) {
            const balance = balancesByUser.get(user.id) || await ensureUserCreditBalance(user.id);
            const creditsBalance = asSignedCredits(balance.balance, 0);
            items.push({
                ...user,
                credits_balance: creditsBalance,
                lifetime_credits_granted: asWholeCredits(balance.lifetime_credits_granted, 0),
                lifetime_credits_spent: asWholeCredits(balance.lifetime_credits_spent, 0),
                insufficient_orders: insufficientCounts.get(user.id) || 0,
                needs_removal: creditsBalance < 0
            });
        }

        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/admin/users/:id/credits", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const targetUser = await getUserById(req.params.id);
        if (!(await canManageTarget(currentUser, targetUser))) {
            return res.status(403).json({ error: "You do not have access to this user." });
        }

        const amount = Math.trunc(Number(req.body?.amount || 0));
        if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: "amount must be a non-zero integer" });

        const balance = await adjustUserCredits({
            userId: targetUser.id,
            delta: amount,
            reason: amount > 0 ? "admin_adjustment_add" : "admin_adjustment_remove",
            note: String(req.body?.note || "").trim(),
            metadata: { admin_email: currentUser.email },
            createdBy: currentUser.id
        });

        res.json({ success: true, balance });
    } catch (err) {
        const status = err.message === "Insufficient credits" ? 400 : 500;
        res.status(status).json({ error: err.message });
    }
});


app.get("/admin/users/:id/credits/history", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const targetUser = await getUserById(req.params.id);
        if (!(await canManageTarget(currentUser, targetUser))) {
            return res.status(403).json({ error: "You do not have access to this user." });
        }

        const [balanceRow, txRows, orderRows] = await Promise.all([
            ensureUserCreditBalance(targetUser.id),
            (async () => {
                const { data, error } = await maybeMany("credit_transactions", (qb) =>
                    qb.select("*").eq("user_id", targetUser.id).order("created_at", { ascending: false }).limit(250)
                );
                if (error) throw new Error(error.message);
                return data || [];
            })(),
            (async () => {
                const { data, error } = await maybeMany("orders", (qb) =>
                    qb.select("*").eq("user_id", targetUser.id).order("created_at", { ascending: false }).limit(250)
                );
                if (error) throw new Error(error.message);
                return data || [];
            })()
        ]);

        res.json({
            user: { id: targetUser.id, email: targetUser.email, role: targetUser.role },
            balance: asSignedCredits(balanceRow.balance, 0),
            lifetime_credits_granted: asWholeCredits(balanceRow.lifetime_credits_granted, 0),
            lifetime_credits_spent: asWholeCredits(balanceRow.lifetime_credits_spent, 0),
            needs_removal: asSignedCredits(balanceRow.balance, 0) < 0,
            transactions: txRows,
            orders: orderRows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/orders", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const scopedUserIds = await getScopeUserIdsForAdmin(currentUser);

        let query = supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(250);
        if (scopedUserIds && scopedUserIds.length) query = query.in("user_id", scopedUserIds);

        const { data: orders, error } = await query;
        if (error) return res.status(500).json({ error: error.message });

        const userIds = [...new Set((orders || []).map((row) => row.user_id).filter(Boolean))];
        const userMap = new Map();
        if (userIds.length) {
            const { data: users, error: usersError } = await supabase.from("users").select("id, email").in("id", userIds);
            if (usersError) return res.status(500).json({ error: usersError.message });
            (users || []).forEach((row) => userMap.set(row.id, row.email));
        }

        res.json({
            items: (orders || []).map((row) => ({
                ...row,
                user_email: userMap.get(row.user_id) || row.user_id
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/admin/orders/:id/refund-credits", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { data: order, error } = await supabase.from("orders").select("*").eq("id", req.params.id).maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!order?.id) return res.status(404).json({ error: "Order not found" });

        const targetUser = await getUserById(order.user_id);
        if (!(await canManageTarget(currentUser, targetUser))) {
            return res.status(403).json({ error: "You do not have access to this user." });
        }

        const amount = asWholeCredits(req.body?.amount, order.credits_charged || 0);
        if (amount <= 0) return res.status(400).json({ error: "Refund amount must be greater than 0" });

        const balance = await adjustUserCredits({
            userId: order.user_id,
            delta: amount,
            reason: "order_refund_credit",
            note: String(req.body?.note || "Manual credit refund").trim(),
            metadata: { order_id: order.id, external_order_id: order.external_order_id, refunded_by: currentUser.email },
            createdBy: currentUser.id,
            orderId: order.id
        });

        const { error: updateError } = await supabase.from("orders").update({
            metadata: { ...(order.metadata || {}), refund_credits: amount, refund_note: String(req.body?.note || "").trim() },
            status: order.status === "refunded" ? "refunded" : `${order.status || "success"}_credited`
        }).eq("id", order.id);
        if (updateError) return res.status(500).json({ error: updateError.message });

        res.json({ success: true, balance });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.get('/admin/webhooks/settings', auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const active = await getActiveInboundWebhook();
        const globalSettings = await getAppSetting('webhook_settings', {});
        const adminSettings = await getAdminWebhookSettings(currentUser.id);

        res.json({
            inbound_webhook_url: active?.token ? `${getApiBaseUrl(req)}/webhooks/orders/${active.token}` : '',
            discord_webhook_url: String(globalSettings?.discord_webhook_url || ''),
            admin_discord_webhook_url: String(adminSettings?.discord_webhook_url || ''),
            admin_brand_label: String(adminSettings?.brand_label || ''),
            can_create_inbound: currentUser.role === 'super_admin',
            is_super_admin: currentUser.role === 'super_admin'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/webhooks/incoming/create', auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (currentUser.role !== 'super_admin') {
            return res.status(403).json({ error: 'Only super admin can create the shared website webhook.' });
        }

        const webhook = await createInboundWebhook(req, currentUser.id);
        res.json({ success: true, inbound_webhook_url: webhook.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/webhooks/settings', auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        const adminDiscordWebhookUrl = String(req.body?.admin_discord_webhook_url || '').trim();
        const adminBrandLabel = String(req.body?.admin_brand_label || '').trim();

        await setAdminWebhookSettings(currentUser.id, {
            discord_webhook_url: adminDiscordWebhookUrl,
            brand_label: adminBrandLabel
        });

        const response = {
            success: true,
            admin_discord_webhook_url: adminDiscordWebhookUrl,
            admin_brand_label: adminBrandLabel
        };

        if (currentUser.role === 'super_admin') {
            const discordWebhookUrl = String(req.body?.discord_webhook_url || '').trim();
            await setAppSetting('webhook_settings', { discord_webhook_url: discordWebhookUrl });
            response.discord_webhook_url = discordWebhookUrl;
        }

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/webhooks/settings', auth, admin, async (req, res) => {
    try {
        const discordWebhookUrl = String(req.body?.discord_webhook_url || '').trim();
        await setAppSetting('webhook_settings', { discord_webhook_url: discordWebhookUrl });
        res.json({ success: true, discord_webhook_url: discordWebhookUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ================= AUTH ROUTES ================= */

app.post("/auth/signup", async (req, res) => {
    const { email, password, invite_code } = req.body;

    const { data: invite, error: inviteError } = await supabase
        .from("invite_codes")
        .select("*")
        .eq("code", invite_code)
        .eq("used", false)
        .eq("canceled", false)
        .single();

    if (inviteError || !invite) {
        return res.status(400).json({ error: "Invalid invite code" });
    }

    const hash = await bcrypt.hash(password, 10);
    const inviteRole = invite.invite_role || "user";

    const insertPayload = {
        email,
        password_hash: hash,
        role: inviteRole,
        revoked: false,
        owner_admin_id: inviteRole === "user" ? invite.created_by_admin_id || null : null
    };

    const { data: user, error } = await supabase
        .from("users")
        .insert(insertPayload)
        .select()
        .single();

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    await supabase
        .from("invite_codes")
        .update({
            used: true,
            used_by: user.id
        })
        .eq("id", invite.id);

    try {
        await sendEmail({
            to: user.email,
            subject: "Welcome to The Shore Shack TCG",
            text: "Thanks for signing up for The Shore Shack TCG. You can now log in and configure your profiles and product selections.",
            html: "<h2>Welcome to The Shore Shack TCG</h2><p>Thanks for signing up. You can now log in and configure your profiles and product selections.</p>"
        });
    } catch (mailErr) {
        console.error("Welcome email failed:", mailErr.message);
    }

    try {
        await ensureUserCreditBalance(user.id);
    } catch (creditErr) {
        console.error("Credit balance init failed:", creditErr.message);
    }

    res.json({ success: true });
});

app.post("/auth/login", async (req, res) => {
    const { email, password } = req.body;

    const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .single();

    if (!user) {
        return res.status(401).json({ error: "Wrong password" });
    }

    if (user.revoked) {
        return res.status(403).json({ error: "This account has been revoked" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
        return res.status(401).json({ error: "Wrong password" });
    }

    const token = jwt.sign(
        { user_id: user.id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

    const creditBalance = await getUserCreditBalance(user.id);

    res.json({
        token,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            owner_admin_id: user.owner_admin_id || null,
            revoked: !!user.revoked,
            credits_balance: creditBalance,
            discord_handle: normalizeDiscordHandle((await getUserSettings(user.id))?.discord_handle || '')
        }
    });
});

app.get("/auth/me", auth, async (req, res) => {
    try {
        const user = req.currentUser || await getCurrentUser(req);

        const creditBalance = await getUserCreditBalance(user.id);

        res.json({
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                owner_admin_id: user.owner_admin_id || null,
                revoked: !!user.revoked,
                credits_balance: creditBalance,
                discord_handle: normalizeDiscordHandle((await getUserSettings(user.id))?.discord_handle || '')
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/user/settings", auth, async (req, res) => {
    try {
        const settings = await getUserSettings(req.user_id);
        res.json({
            discord_handle: normalizeDiscordHandle(settings?.discord_handle || '')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/user/settings", auth, async (req, res) => {
    try {
        const discordHandle = normalizeDiscordHandle(req.body?.discord_handle || '');
        const updated = await setUserSettings(req.user_id, { discord_handle: discordHandle });
        res.json({
            success: true,
            discord_handle: normalizeDiscordHandle(updated?.discord_handle || discordHandle)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/auth/forgot-password", async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        if (!email) return res.status(400).json({ error: "Email is required" });

        const { data: user, error } = await supabase
            .from("users")
            .select("id, email")
            .ilike("email", email)
            .maybeSingle();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const successMessage = { message: "If this email exists, a reset link has been sent." };
        if (!user) return res.json(successMessage);

        const resetToken = jwt.sign(
            { user_id: user.id, purpose: "password_reset" },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        const resetUrl = buildAppUrl("/reset-password.html?token=" + encodeURIComponent(resetToken));

        try {
            await sendEmail({
                to: user.email,
                subject: "The Shore Shack Password Reset",
                text: "Use this link to reset your password: " + resetUrl,
                html: `<h2>The Shore Shack Password Reset</h2><p>Use the link below to reset your password.</p><p><a href="${resetUrl}">Reset Password</a></p><p>If the button does not work, copy and paste this link into your browser:</p><p>${resetUrl}</p>`
            });
        } catch (mailErr) {
            console.error("Reset email failed:", mailErr.message);
            return res.status(500).json({ error: "Email failed" });
        }

        res.json(successMessage);
    } catch (err) {
        console.error("Forgot password crash:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post("/auth/reset-password", async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) {
            return res.status(400).json({ error: "Token and new password are required" });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(400).json({ error: "Invalid or expired reset token" });
        }

        if (decoded?.purpose !== "password_reset" || !decoded?.user_id) {
            return res.status(400).json({ error: "Invalid reset token" });
        }

        const hash = await bcrypt.hash(newPassword, 10);

        const { error } = await supabase
            .from("users")
            .update({ password_hash: hash })
            .eq("id", decoded.user_id);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* ================= CHANGE PASSWORD ================= */

app.post("/change-password", auth, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const user = await ensureUserNotRevoked(req.user_id);

        const valid = await bcrypt.compare(oldPassword, user.password_hash);
        if (!valid) {
            return res.status(400).json({ error: "Wrong password" });
        }

        const hash = await bcrypt.hash(newPassword, 10);

        await supabase
            .from("users")
            .update({ password_hash: hash })
            .eq("id", req.user_id);

        res.json({ success: true });
    } catch (err) {
        const status = err.message === "This account has been revoked" ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
});

/* ================= USER PROFILES ================= */

app.get("/profiles", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);

        const { data, error } = await supabase
            .from("profiles")
            .select(`
        *,
        addresses(*),
        payments(*),
        accounts(*)
      `)
            .eq("user_id", req.user_id)
            .order("created_at", { ascending: false });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        (data || []).forEach((profile) => {
            if (profile.payments?.length) {
                const payment = profile.payments[0];
                try {
                    payment.card_number = decrypt(payment.card_encrypted);
                    payment.cvv = decrypt(payment.cvv_encrypted);
                } catch {
                    payment.card_number = "";
                    payment.cvv = "";
                }
            }
        });

        res.json(data || []);
    } catch (err) {
        const status = err.message === "This account has been revoked" ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
});

app.post("/profiles", auth, async (req, res) => {
    try {
        const data = req.body;
        const cardLast4 = (data.card || "").slice(-4);

        await ensureUserNotRevoked(req.user_id);

        if (!phoneRegex.test(data.phone || "")) {
            return res.status(400).json({ error: "Phone must be xxxxxxxxxx" });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const duplicateError = findDuplicateInSameGroup(
            existingProfiles,
            null,
            data.account_type,
            data.profile_name,
            data.email,
            data.phone,
            cardLast4
        );

        if (duplicateError) {
            return res.status(400).json({ error: duplicateError });
        }

        const { data: createdProfile, error: profileError } = await supabase
            .from("profiles")
            .insert({
                user_id: req.user_id,
                profile_name: data.profile_name,
                account_type: data.account_type
            })
            .select()
            .single();

        if (profileError || !createdProfile) {
            return res.status(500).json({ error: profileError?.message || "Profile creation failed" });
        }

        await upsertProfileRelations(createdProfile.id, data);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Profile creation failed" });
    }
});

app.put("/profiles/:id", auth, async (req, res) => {
    try {
        const id = req.params.id;
        const data = req.body;
        const cardLast4 = (data.card || "").slice(-4);

        await ensureUserNotRevoked(req.user_id);

        if (!phoneRegex.test(data.phone || "")) {
            return res.status(400).json({ error: "Phone must be xxxxxxxxxx" });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const duplicateError = findDuplicateInSameGroup(
            existingProfiles,
            id,
            data.account_type,
            data.profile_name,
            data.email,
            data.phone,
            cardLast4
        );

        if (duplicateError) {
            return res.status(400).json({ error: duplicateError });
        }

        const { error: profileError } = await supabase
            .from("profiles")
            .update({
                profile_name: data.profile_name,
                account_type: data.account_type
            })
            .eq("id", id)
            .eq("user_id", req.user_id);

        if (profileError) {
            return res.status(500).json({ error: profileError.message });
        }

        await upsertProfileRelations(id, data);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Profile update failed" });
    }
});

app.delete("/profiles/:id", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);

        const id = req.params.id;

        await supabase.from("accounts").delete().eq("profile_id", id);
        await supabase.from("payments").delete().eq("profile_id", id);
        await supabase.from("addresses").delete().eq("profile_id", id);

        const { error } = await supabase
            .from("profiles")
            .delete()
            .eq("id", id)
            .eq("user_id", req.user_id);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        const status = err.message === "This account has been revoked" ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
});

/* ================= ADMIN USERS ================= */

app.get("/admin/users", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        const loadAll = req.query.all === "1";
        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const limit = loadAll ? 1000 : Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 10);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        const ownerAdminId = req.query.owner_admin_id || "";
        const roleFilter = req.query.role || "";
        const createdAfter = req.query.created_after || "";
        const createdBefore = req.query.created_before || "";

        let usersQuery = supabase
            .from("users")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false });

        if (!loadAll) {
            usersQuery = usersQuery.range(from, to);
        }

        if (currentUser.role !== "super_admin") {
            usersQuery = usersQuery.eq("owner_admin_id", currentUser.id);
        } else {
            if (ownerAdminId) {
                usersQuery = usersQuery.eq("owner_admin_id", ownerAdminId);
            }
            if (roleFilter) {
                usersQuery = usersQuery.eq("role", roleFilter);
            }
            if (createdAfter) {
                usersQuery = usersQuery.gte("created_at", createdAfter);
            }
            if (createdBefore) {
                usersQuery = usersQuery.lte("created_at", createdBefore);
            }
        }

        const { data: users, error, count } = await usersQuery;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const ownerIds = [...new Set((users || []).map((u) => u.owner_admin_id).filter(Boolean))];
        let ownerMap = {};

        if (ownerIds.length) {
            const { data: owners } = await supabase
                .from("users")
                .select("id, email")
                .in("id", ownerIds);

            ownerMap = Object.fromEntries((owners || []).map((o) => [o.id, o.email]));
        }

        const userIds = (users || []).map((u) => u.id);
        let profileCountMap = {};

        if (userIds.length) {
            const { data: profiles } = await supabase
                .from("profiles")
                .select("id, user_id")
                .in("user_id", userIds);

            for (const p of profiles || []) {
                profileCountMap[p.user_id] = (profileCountMap[p.user_id] || 0) + 1;
            }
        }

        const output = (users || []).map((u) => ({
            ...u,
            profile_count: profileCountMap[u.id] || 0,
            owner_admin_email: u.owner_admin_id ? ownerMap[u.owner_admin_id] || "" : ""
        }));

        res.json({
            items: output,
            page: loadAll ? 1 : page,
            limit,
            total: count || output.length || 0,
            total_pages: loadAll ? 1 : Math.ceil((count || 0) / limit)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/admin-owners", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        if (currentUser.role !== "super_admin") {
            return res.json([{ id: currentUser.id, email: currentUser.email }]);
        }

        const { data, error } = await supabase
            .from("users")
            .select("id, email")
            .in("role", ["admin", "super_admin"])
            .order("email", { ascending: true });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json(data || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/admin/users/:id/revoke", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const targetId = req.params.id;
        const targetUser = await getUserById(targetId);

        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }

        if (targetUser.role === "super_admin") {
            return res.status(400).json({ error: "Super admin account cannot be revoked" });
        }

        if (currentUser.role !== "super_admin") {
            const allowed = await canManageTarget(currentUser, targetUser);
            if (!allowed) {
                return res.status(403).json({ error: "You can only manage users in your own admin tree" });
            }
            if (targetUser.role === "admin") {
                return res.status(403).json({ error: "Only super admin can revoke admins" });
            }
        }

        const { error } = await supabase
            .from("users")
            .update({ revoked: true })
            .eq("id", targetId);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/admin/users/:id/restore", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const targetId = req.params.id;
        const targetUser = await getUserById(targetId);

        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }

        if (targetUser.role === "super_admin") {
            return res.status(400).json({ error: "Super admin account cannot be restored here" });
        }

        if (currentUser.role !== "super_admin") {
            const allowed = await canManageTarget(currentUser, targetUser);
            if (!allowed) {
                return res.status(403).json({ error: "You can only manage users in your own admin tree" });
            }
            if (targetUser.role === "admin") {
                return res.status(403).json({ error: "Only super admin can restore admins" });
            }
        }

        const { error } = await supabase
            .from("users")
            .update({ revoked: false })
            .eq("id", targetId);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/admin/users/:id/promote", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        if (currentUser.role !== "super_admin") {
            return res.status(403).json({ error: "Only super admin can promote users to admin" });
        }

        const targetId = req.params.id;
        const targetUser = await getUserById(targetId);

        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }

        if (targetUser.role !== "user") {
            return res.status(400).json({ error: "Only user accounts can be promoted" });
        }

        const { error } = await supabase
            .from("users")
            .update({
                role: "admin",
                owner_admin_id: null,
                revoked: false
            })
            .eq("id", targetId);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/admin/users/:id/demote", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        if (currentUser.role !== "super_admin") {
            return res.status(403).json({ error: "Only super admin can demote admins" });
        }

        const targetId = req.params.id;
        const targetUser = await getUserById(targetId);

        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }

        if (targetUser.role !== "admin") {
            return res.status(400).json({ error: "Only admin accounts can be demoted" });
        }

        if (targetUser.email === SUPER_ADMIN_EMAIL) {
            return res.status(400).json({ error: "Super admin cannot be demoted" });
        }

        const superAdminId = currentUser.id;

        const { error: reassignError } = await supabase
            .from("users")
            .update({ owner_admin_id: superAdminId })
            .eq("owner_admin_id", targetUser.id);

        if (reassignError) {
            return res.status(500).json({ error: reassignError.message });
        }

        const { error: demoteError } = await supabase
            .from("users")
            .update({
                role: "user",
                owner_admin_id: superAdminId,
                revoked: false
            })
            .eq("id", targetUser.id);

        if (demoteError) {
            return res.status(500).json({ error: demoteError.message });
        }

        res.json({
            success: true,
            message: "Admin demoted and all owned users moved to super admin"
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/admin/users/:id", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const targetId = req.params.id;
        const targetUser = await getUserById(targetId);

        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }

        if (targetUser.role === "super_admin") {
            return res.status(400).json({ error: "Super admin account cannot be deleted" });
        }

        if (currentUser.role !== "super_admin") {
            const allowed = await canManageTarget(currentUser, targetUser);
            if (!allowed) {
                return res.status(403).json({ error: "You can only delete users in your own admin tree" });
            }
            if (targetUser.role === "admin") {
                return res.status(403).json({ error: "Only super admin can delete admins" });
            }
        }

        if (currentUser.role === "super_admin" && targetUser.role === "admin") {
            await supabase
                .from("users")
                .update({ owner_admin_id: currentUser.id })
                .eq("owner_admin_id", targetUser.id);
        }

        const { data: profiles, error: profilesError } = await supabase
            .from("profiles")
            .select("id")
            .eq("user_id", targetId);

        if (profilesError) {
            return res.status(500).json({ error: profilesError.message });
        }

        const profileIds = (profiles || []).map((profile) => profile.id);

        if (profileIds.length) {
            await supabase.from("accounts").delete().in("profile_id", profileIds);
            await supabase.from("payments").delete().in("profile_id", profileIds);
            await supabase.from("addresses").delete().in("profile_id", profileIds);
            await supabase.from("profiles").delete().in("id", profileIds);
        }

        await supabase.from("invite_codes").delete().eq("used_by", targetId);

        const { error: deleteError } = await supabase
            .from("users")
            .delete()
            .eq("id", targetId);

        if (deleteError) {
            return res.status(500).json({ error: deleteError.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ================= ADMIN INVITES ================= */

app.post("/admin/create-invite", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        const requestedRole = req.body?.invite_role || "user";
        const quantityRaw = Number(req.body?.quantity || 1);
        const quantity = Number.isInteger(quantityRaw) ? quantityRaw : 1;

        if (!["user", "admin"].includes(requestedRole)) {
            return res.status(400).json({ error: "Invalid invite role" });
        }

        if (quantity < 1 || quantity > 10) {
            return res.status(400).json({ error: "Quantity must be between 1 and 10" });
        }

        if (requestedRole === "admin") {
            if (currentUser.role !== "super_admin") {
                return res.status(403).json({ error: "Only super admin can create admin invites" });
            }

            if (quantity !== 1) {
                return res.status(400).json({ error: "Admin invites can only be created one at a time" });
            }
        }

        const inviteRows = Array.from({ length: quantity }, () => ({
            code: uuidv4().slice(0, 8),
            used: false,
            canceled: false,
            created_by_admin_id: currentUser.id,
            invite_role: requestedRole
        }));

        const { data, error } = await supabase
            .from("invite_codes")
            .insert(inviteRows)
            .select();

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({
            success: true,
            invite_role: requestedRole,
            quantity,
            codes: (data || []).map((row) => row.code)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/invites", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        const loadAll = req.query.all === "1";
        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const limit = loadAll ? 1000 : Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 10);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        let inviteQuery = supabase
            .from("invite_codes")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false });

        if (!loadAll) {
            inviteQuery = inviteQuery.range(from, to);
        }

        if (currentUser.role !== "super_admin") {
            inviteQuery = inviteQuery.eq("created_by_admin_id", currentUser.id);
        }

        const { data: invites, error, count } = await inviteQuery;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const usedByIds = [...new Set((invites || []).map((i) => i.used_by).filter(Boolean))];
        const createdByIds = [...new Set((invites || []).map((i) => i.created_by_admin_id).filter(Boolean))];
        const allLookupIds = [...new Set([...usedByIds, ...createdByIds])];

        let emailMap = {};
        if (allLookupIds.length) {
            const { data: users } = await supabase
                .from("users")
                .select("id, email")
                .in("id", allLookupIds);

            emailMap = Object.fromEntries((users || []).map((u) => [u.id, u.email]));
        }

        const output = (invites || []).map((invite) => ({
            ...invite,
            used_by_email: invite.used_by ? emailMap[invite.used_by] || "" : "",
            created_by_admin_email: invite.created_by_admin_id ? emailMap[invite.created_by_admin_id] || "" : ""
        }));

        res.json({
            items: output,
            page: loadAll ? 1 : page,
            limit,
            total: count || output.length || 0,
            total_pages: loadAll ? 1 : Math.ceil((count || 0) / limit)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch("/admin/invites/:id/cancel", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        let lookup = supabase
            .from("invite_codes")
            .select("*")
            .eq("id", req.params.id);

        if (currentUser.role !== "super_admin") {
            lookup = lookup.eq("created_by_admin_id", currentUser.id);
        }

        const { data: invite, error: inviteError } = await lookup.single();

        if (inviteError || !invite) {
            return res.status(404).json({ error: "Invite not found" });
        }

        const { error } = await supabase
            .from("invite_codes")
            .update({ canceled: true })
            .eq("id", req.params.id);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete("/admin/invites/:id", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        let lookup = supabase
            .from("invite_codes")
            .select("*")
            .eq("id", req.params.id);

        if (currentUser.role !== "super_admin") {
            lookup = lookup.eq("created_by_admin_id", currentUser.id);
        }

        const { data: invite, error: inviteError } = await lookup.single();

        if (inviteError || !invite) {
            return res.status(404).json({ error: "Invite not found" });
        }

        const { error } = await supabase
            .from("invite_codes")
            .delete()
            .eq("id", req.params.id);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ================= EXPORT ================= */

app.get("/admin/export/accounts", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);

        let query = supabase
            .from("users")
            .select("id, email, role")
            .order("email", { ascending: true });

        if (currentUser.role !== "super_admin") {
            const ownedIds = await getScopeUserIdsForAdmin(currentUser);
            query = query.in("id", safeIn(ownedIds));
        }

        const { data, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let items = (data || []).filter(
            (u) => u.role === "user" || u.role === "admin" || u.role === "super_admin"
        );

        if (
            currentUser.role === "super_admin" &&
            !items.some((u) => u.id === currentUser.id)
        ) {
            items.unshift({
                id: currentUser.id,
                email: currentUser.email,
                role: currentUser.role
            });
        }

        const deduped = [];
        const seen = new Set();

        items.forEach((u) => {
            if (!u || !u.id || seen.has(u.id)) return;
            seen.add(u.id);
            deduped.push(u);
        });

        res.json(deduped);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/export/count", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { user_id, group } = req.query;

        let query = supabase
            .from("profiles")
            .select("id, user_id, account_type");

        if (currentUser.role === "super_admin") {
            if (user_id) {
                query = query.eq("user_id", user_id);
            }
            if (group) {
                query = query.eq("account_type", group);
            }
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) {
                query = query.eq("user_id", user_id);
            }

            if (group) {
                query = query.eq("account_type", group);
            }
        }

        const { data, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ count: (data || []).length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/export/profiles-json", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { user_id, group } = req.query;
        const filename = (req.query.filename || "profiles").replace(/[^a-zA-Z0-9-_]/g, "");

        let query = supabase
            .from("profiles")
            .select(`
                *,
                addresses(*),
                payments(*),
                accounts(*)
            `)
            .order("created_at", { ascending: false });

        if (currentUser.role === "super_admin") {
            if (user_id) query = query.eq("user_id", user_id);
            if (group) query = query.eq("account_type", group);
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) query = query.eq("user_id", user_id);
            if (group) query = query.eq("account_type", group);
        }

        const { data: profiles, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const rows = (profiles || []).map((profile) => {
            const address = profile.addresses?.[0] || {};
            const payment = profile.payments?.[0] || {};

            let cardNumber = "";
            let cardCvv = "";

            try {
                cardNumber = payment.card_encrypted ? decrypt(payment.card_encrypted) : "";
            } catch { }

            try {
                cardCvv = payment.cvv_encrypted ? decrypt(payment.cvv_encrypted) : "";
            } catch { }

            const billingSameAsShipping =
                !address.billing_first_name &&
                !address.billing_last_name &&
                !address.billing_address1 &&
                !address.billing_city &&
                !address.billing_state &&
                !address.billing_zip &&
                !address.billing_phone;

            return {
                id: profile.id,
                createdAt: profile.created_at ? new Date(profile.created_at).getTime() : Date.now(),
                updatedAt: profile.updated_at ? new Date(profile.updated_at).getTime() : Date.now(),
                name: profile.profile_name || "",
                email: address.email || "",
                oneTimeUse: false,
                shipping: {
                    firstName: address.first_name || "",
                    lastName: address.last_name || "",
                    address1: address.address1 || "",
                    address2: address.address2 || "",
                    city: address.city || "",
                    province: address.state || "",
                    postalCode: address.zip || "",
                    country: address.country || "United States",
                    phone: address.phone || ""
                },
                billing: {
                    sameAsShipping: billingSameAsShipping,
                    firstName: address.billing_first_name || "",
                    lastName: address.billing_last_name || "",
                    address1: address.billing_address1 || "",
                    address2: address.billing_address2 || "",
                    city: address.billing_city || "",
                    province: address.billing_state || null,
                    postalCode: address.billing_zip || "",
                    country: address.billing_country || null,
                    phone: address.billing_phone || ""
                },
                payment: {
                    name: payment.card_name || `${address.first_name || ""} ${address.last_name || ""}`.trim(),
                    num: cardNumber,
                    year: payment.exp_year || "",
                    month: payment.exp_month || "",
                    cvv: cardCvv
                }
            };
        });

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.json"`);
        res.send(JSON.stringify(rows, null, 2));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.get("/admin/export/accounts-txt", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { user_id, group } = req.query;
        const filename = (req.query.filename || "accounts").replace(/[^a-zA-Z0-9-_]/g, "");

        let query = supabase
            .from("profiles")
            .select(`
                id,
                user_id,
                account_type,
                created_at,
                accounts(*)
            `)
            .order("created_at", { ascending: false });

        if (currentUser.role === "super_admin") {
            if (user_id) query = query.eq("user_id", user_id);
            if (group) query = query.eq("account_type", group);
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) query = query.eq("user_id", user_id);
            if (group) query = query.eq("account_type", group);
        }

        const { data: profiles, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        const rows = (profiles || [])
            .map((profile) => {
                const account = profile.accounts?.[0] || {};
                const email = (account.login_email || "").trim();
                const password = (account.login_password || "").trim();

                if (!email && !password) return null;

                return `${email}:::${password}:::proxie`;
            })
            .filter(Boolean);

        const output = ["account email:account password", ...rows].join("\n");

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.txt"`);
        res.send(output);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


/* ================= SUPER ADMIN BOOTSTRAP ================= */

async function ensureSuperAdmin() {
    const password = process.env.SUPER_ADMIN_PASSWORD;

    const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("email", SUPER_ADMIN_EMAIL)
        .maybeSingle();

    if (!user) {
        if (!password) {
            throw new Error("SUPER_ADMIN_PASSWORD is required to create the initial super admin");
        }

        const hash = await bcrypt.hash(password, 10);

        const { error } = await supabase
            .from("users")
            .insert({
                email: SUPER_ADMIN_EMAIL,
                password_hash: hash,
                role: "super_admin",
                revoked: false,
                owner_admin_id: null
            });

        if (error) {
            throw new Error(error.message);
        }

        console.log("Super admin account created");
        return;
    }

    const { error } = await supabase
        .from("users")
        .update({
            role: "super_admin",
            revoked: false,
            owner_admin_id: null
        })
        .eq("email", SUPER_ADMIN_EMAIL);

    if (error) {
        throw new Error(error.message);
    }

    console.log("Super admin account ensured");
}

registerProductCatalogRoutes({
    app,
    supabase,
    auth,
    admin,
    getCurrentUser,
    ensureUserNotRevoked
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
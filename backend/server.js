
// ===== BOXLUNCH URL HELPERS =====
function slugifyBoxLunchTitle(title = "") {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-boxlunch-exclusive$/, "---boxlunch-exclusive");
}

function extractBoxLunchProductIdFromImage(imageUrl = "") {
  const match = String(imageUrl).match(/\/(\d{6,})_hi\b/i);
  return match ? match[1] : "";
}

function buildBoxLunchUrl({ title = "", image = "", url = "" }) {
  if (url) return url;

  const productId = extractBoxLunchProductIdFromImage(image);
  if (productId && title) {
    const slug = slugifyBoxLunchTitle(title);
    return `https://www.boxlunch.com/product/${slug}/${productId}.html`;
  }

  if (title) {
    return `https://www.boxlunch.com/search?q=${encodeURIComponent(title)}`;
  }

  return "";
}



function slugifyProductTitle(title = "") {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildHotTopicUrl({ title = "", image = "", url = "" }) {
  if (url) return url;
  const productId = extractBoxLunchProductIdFromImage(image);
  if (productId && title) {
    const slug = slugifyProductTitle(title);
    return `https://www.hottopic.com/product/${slug}/${productId}.html`;
  }
  if (title) {
    return `https://www.hottopic.com/search?q=${encodeURIComponent(title)}`;
  }
  return "";
}

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const Stripe = require("stripe");
const cheerio = require("cheerio");
const registerProductCatalogRoutes = require("./product-catalog-routes");
const registerShopRoutes = require("./shop-routes");

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


let shopRoutes = null;

// =========================
// SUPABASE DISCOUNTS SYSTEM (FINAL CLEAN)
// =========================

async function getDiscount(code) {
    const { data } = await supabase
        .from("discounts")
        .select("*")
        .eq("code", code.toUpperCase())
        .single();

    return data;
}

// CREATE (ADMIN)
app.post("/api/discounts", auth, admin, async (req, res) => {
    const d = req.body;

    const { error } = await supabase.from("discounts").insert([{
        code: d.code.toUpperCase(),
        type: d.type,
        value: Number(d.value || 0),
        usage_limit: Number(d.usage_limit || 0),
        one_time_per_user: !!d.one_time_per_user,
        expires_at: d.expires_at || null,
        min_cart_value: Number(d.min_cart_value || 0),
        active: true,
        usage_count: 0,
        used_by: []
    }]);

    if (error) return res.json({ error: error.message });

    res.json({ success: true });
});

// GET ALL (ADMIN)
app.get("/api/discounts", auth, admin, async (req, res) => {
    const { data } = await supabase.from("discounts").select("*");
    res.json(data);
});

// DELETE
app.delete("/api/discounts/:code", auth, admin, async (req, res) => {
    await supabase
        .from("discounts")
        .delete()
        .eq("code", req.params.code.toUpperCase());

    res.json({ success: true });
});

// APPLY (PUBLIC)
async function validateDiscountCode({ code, cartTotal = 0, shippingTotal = 0, email = "" }) {
    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!normalizedCode) {
        return { ok: false, error: "Discount code is required" };
    }

    const d = await getDiscount(normalizedCode);

    if (!d || !d.active) {
        return { ok: false, error: "Invalid code" };
    }

    if (d.expires_at && new Date() > new Date(d.expires_at)) {
        return { ok: false, error: "Expired code" };
    }

    if (d.usage_limit && d.usage_count >= d.usage_limit) {
        return { ok: false, error: "Usage limit reached" };
    }

    const usedBy = Array.isArray(d.used_by) ? d.used_by : [];
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (d.one_time_per_user && normalizedEmail && usedBy.includes(normalizedEmail)) {
        return { ok: false, error: "Already used" };
    }

    if (Number(cartTotal || 0) < Number(d.min_cart_value || 0)) {
        return { ok: false, error: "Minimum not met" };
    }

    let discountAmount = 0;
    let shippingDiscount = 0;

    if (d.type === "percent") {
        discountAmount = Number(cartTotal || 0) * (Number(d.value || 0) / 100);
    } else if (d.type === "fixed") {
        discountAmount = Number(d.value || 0);
    } else if (d.type === "free_shipping") {
        shippingDiscount = Number(shippingTotal || 0);
    }

    discountAmount = Math.max(0, Number(discountAmount.toFixed(2)));
    shippingDiscount = Math.max(0, Number(shippingDiscount.toFixed(2)));

    return {
        ok: true,
        code: d.code,
        discount: d,
        discountAmount,
        shippingDiscount,
        totalDiscount: Number((discountAmount + shippingDiscount).toFixed(2))
    };
}

app.post("/api/discounts/apply", async (req, res) => {
    const { code, cartTotal, email, shippingTotal = 0 } = req.body;

    const d = await getDiscount(code);

    if (!d || !d.active) return res.json({ error: "Invalid code" });

    if (d.expires_at && new Date() > new Date(d.expires_at))
        return res.json({ error: "Expired code" });

    if (d.usage_limit && d.usage_count >= d.usage_limit)
        return res.json({ error: "Usage limit reached" });

    if (d.one_time_per_user && Array.isArray(d.used_by) && d.used_by.includes(email))
        return res.json({ error: "Already used" });

    if (cartTotal < d.min_cart_value)
        return res.json({ error: "Minimum not met" });

    let discountAmount = 0;
    let shippingDiscount = 0;

    if (d.type === "percent") {
        discountAmount = cartTotal * (d.value / 100);
    }

    if (d.type === "fixed") {
        discountAmount = d.value;
    }

    if (d.type === "free_shipping") {
        shippingDiscount = shippingTotal;
    }

    return res.json({
        success: true,
        code: d.code,
        discountType: d.type,
        discountAmount,
        shippingDiscount,
        totalDiscount: discountAmount + shippingDiscount
    });
});
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
        .replace(/\|\|/g, " ")
        .replace(/\*\*/g, " ")
        .replace(/__+/g, " ")
        .replace(/~~/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

function extractMarkdownLink(value = "") {
    const match = String(value || '').match(/\[([^\]]+)\]\(([^)]+)\)/);
    return match ? { text: cleanFieldValue(match[1] || ''), url: String(match[2] || '').trim() } : null;
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
    const productFieldRaw = payload.product_name || payload.product?.name || fields['product'] || fields['product name'] || embed.description || '';
    const productLink = extractMarkdownLink(payload.product_url || payload.url || fields['product'] || fields['share link'] || fields['input'] || '');
    const orderLink = extractMarkdownLink(fields['order id'] || fields['order number'] || payload.order_number || '');
    const productName = cleanFieldValue(productLink?.text || productFieldRaw || '');
    const orderNumber = cleanFieldValue(orderLink?.text || payload.order_number || fields['order id'] || fields['order number'] || '').replace(/^#/, '');
    const accountEmail = extractEmail(payload.user_email || payload.email || fields['account'] || fields['email'] || '');
    const profileName = cleanFieldValue(payload.profile_name || fields['profile'] || '');
    const sku = cleanFieldValue(payload.sku || payload.product_sku || fields['sku'] || '') || cleanFieldValue(productLink?.url || '').match(/(?:A-|ip\/seort\/|ip\/)(\d{6,})/)?.[1] || '';
    const quantityRaw = payload.quantity ?? fields['quantity'];
    const quantity = Number.isFinite(Number(quantityRaw)) ? Math.max(1, Math.round(Number(quantityRaw))) : 1;
    const priceRaw = payload.price ?? fields['price'] ?? fields['product price'];
    const priceMatch = String(priceRaw || '').replace(/[^0-9.]/g, '');
    const price = priceMatch ? Number(priceMatch) : null;
    const productUrl = String(productLink?.url || payload.product_url || payload.url || fields['input'] || fields['share link'] || '').trim();
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

    // 2. ACCOUNT / PROFILE EMAIL SECOND
    if (normalized.account_email) {
        const normalizedEmail = String(normalized.account_email).trim().toLowerCase();
        const { data: accounts, error: accountError } = await supabase
            .from('accounts')
            .select('profile_id, login_email, created_at')
            .ilike('login_email', normalizedEmail)
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

        const { data: profileEmailMatches, error: profileEmailError } = await supabase
            .from('profiles')
            .select('user_id, created_at')
            .ilike('email', normalizedEmail)
            .order('created_at', { ascending: false });
        if (profileEmailError && !String(profileEmailError.message || '').includes('column')) throw new Error(profileEmailError.message);
        if (profileEmailMatches?.length && profileEmailMatches[0]?.user_id) {
            const user = await getUserById(profileEmailMatches[0].user_id);
            if (user) return user;
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

const SUPER_ADMIN_ROUTE_USER_ID = '00000000-0000-0000-0000-000000000000';

async function migrateSuperAdminWebhookRouteIds() {
    const { error } = await supabase
        .from('discord_webhook_routes')
        .update({ user_id: SUPER_ADMIN_ROUTE_USER_ID })
        .eq('scope', 'super_admin')
        .is('user_id', null);
    if (error && !String(error.message || '').toLowerCase().includes('no rows')) {
        throw new Error(error.message);
    }
}

function normalizeDiscordWebhookRouteRow(row = {}) {
    return {
        id: row.id || null,
        scope: String(row.scope || '').trim() || 'admin',
        user_id: row.user_id === SUPER_ADMIN_ROUTE_USER_ID ? null : (row.user_id || null),
        webhook_type: String(row.webhook_type || '').trim() || 'monitor',
        category: String(row.category || 'all').trim() || 'all',
        webhook_url: String(row.webhook_url || '').trim(),
        ping_mode: String(row.ping_mode || 'none').trim() || 'none',
        role_mention: String(row.role_mention || '').trim(),
        is_active: row.is_active !== false
    };
}

async function listDiscordWebhookRoutes({ scope, userId = null, webhookType } = {}) {
    await migrateSuperAdminWebhookRouteIds().catch(() => null);
    let query = supabase
        .from('discord_webhook_routes')
        .select('*')
        .eq('is_active', true);
    if (scope) query = query.eq('scope', scope);
    if (webhookType) query = query.eq('webhook_type', webhookType);
    if (scope === 'super_admin') {
        query = query.eq('user_id', SUPER_ADMIN_ROUTE_USER_ID);
    } else if (userId) {
        query = query.eq('user_id', userId);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data.map(normalizeDiscordWebhookRouteRow) : [];
}

async function upsertDiscordWebhookRoute({ scope, userId = null, webhookType, category = 'all', webhookUrl = '', pingMode = 'none', roleMention = '', isActive = true } = {}) {
    const resolvedUserId = scope === 'super_admin' ? SUPER_ADMIN_ROUTE_USER_ID : (userId || null);
    const normalizedWebhookType = String(webhookType || '').trim();
    const normalizedCategory = normalizedWebhookType.startsWith('checkout_') ? 'all' : (String(category || 'all').trim() || 'all');
    const payload = {
        scope,
        user_id: resolvedUserId,
        webhook_type: normalizedWebhookType,
        category: normalizedCategory,
        webhook_url: String(webhookUrl || '').trim(),
        ping_mode: normalizedWebhookType === 'monitor' ? (String(pingMode || 'none').trim() || 'none') : 'none',
        role_mention: normalizedWebhookType === 'monitor' ? String(roleMention || '').trim() : '',
        is_active: !!isActive,
        updated_at: new Date().toISOString()
    };

    const matchQuery = supabase
        .from('discord_webhook_routes')
        .select('id, category')
        .eq('scope', scope)
        .eq('user_id', resolvedUserId)
        .eq('webhook_type', normalizedWebhookType);

    const { data: existingRows, error: existingError } = normalizedWebhookType.startsWith('checkout_')
        ? await matchQuery
        : await matchQuery.eq('category', normalizedCategory);

    if (existingError) throw new Error(existingError.message);

    const rows = Array.isArray(existingRows) ? existingRows : [];

    if (normalizedWebhookType.startsWith('checkout_') && rows.length) {
        const staleIds = rows.filter((row) => String(row.category || 'all') !== 'all').map((row) => row.id).filter(Boolean);
        if (staleIds.length) {
            const { error: deleteStaleError } = await supabase.from('discord_webhook_routes').delete().in('id', staleIds);
            if (deleteStaleError) throw new Error(deleteStaleError.message);
        }
    }

    const validRows = rows.filter((row) => String(row.category || 'all') === normalizedCategory);
    const primaryRow = validRows[0] || null;
    const duplicateIds = validRows.slice(1).map((row) => row.id).filter(Boolean);

    if (duplicateIds.length) {
        const { error: deleteDupError } = await supabase.from('discord_webhook_routes').delete().in('id', duplicateIds);
        if (deleteDupError) throw new Error(deleteDupError.message);
    }

    if (primaryRow?.id) {
        const { error: updateError } = await supabase.from('discord_webhook_routes').update(payload).eq('id', primaryRow.id);
        if (updateError) throw new Error(updateError.message);
        return;
    }

    const { error: insertError } = await supabase.from('discord_webhook_routes').insert({ ...payload, created_at: new Date().toISOString() });
    if (insertError) throw new Error(insertError.message);
}

async function getWebhookRouteFromDb({ scope, userId = null, webhookType, category = 'all' } = {}) {
    const rows = await listDiscordWebhookRoutes({ scope, userId, webhookType });
    return rows.find((row) => row.category === category) || null;
}

async function migrateWebhookSettingsToSupabase({ currentUser, globalSettings = {}, adminSettings = {} } = {}) {
    if (currentUser?.role === 'super_admin') {
        const existingSuccess = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: 'checkout_success', category: 'all' }).catch(() => null);
        const existingError = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: 'checkout_error', category: 'all' }).catch(() => null);
        if (!existingSuccess && String(globalSettings?.discord_webhook_url || '').trim()) {
            await upsertDiscordWebhookRoute({ scope: 'super_admin', webhookType: 'checkout_success', category: 'all', webhookUrl: globalSettings.discord_webhook_url });
        }
        if (!existingError && String(globalSettings?.checkout_error_webhook_url || '').trim()) {
            await upsertDiscordWebhookRoute({ scope: 'super_admin', webhookType: 'checkout_error', category: 'all', webhookUrl: globalSettings.checkout_error_webhook_url });
        }
        const monitorGroups = globalSettings?.monitor_groups || {};
        for (const category of ['pokemon','onepiece','sports','othertcg','lowkey']) {
            const cfg = normalizeMonitorGroupConfig(monitorGroups?.[category]);
            const existing = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: 'monitor', category }).catch(() => null);
            if (!existing && String(cfg.webhook_url || '').trim()) {
                await upsertDiscordWebhookRoute({ scope: 'super_admin', webhookType: 'monitor', category, webhookUrl: cfg.webhook_url, pingMode: cfg.ping_mode, roleMention: cfg.role_mention });
            }
        }
    }

    if (currentUser?.id) {
        const existingAdminSuccess = await getWebhookRouteFromDb({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_success', category: 'all' }).catch(() => null);
        const existingAdminError = await getWebhookRouteFromDb({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_error', category: 'all' }).catch(() => null);
        if (!existingAdminSuccess && String(adminSettings?.discord_webhook_url || '').trim()) {
            await upsertDiscordWebhookRoute({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_success', category: 'all', webhookUrl: adminSettings.discord_webhook_url });
        }
        if (!existingAdminError && String(adminSettings?.checkout_error_webhook_url || '').trim()) {
            await upsertDiscordWebhookRoute({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_error', category: 'all', webhookUrl: adminSettings.checkout_error_webhook_url });
        }
        const adminGroups = adminSettings?.monitor_groups || {};
        for (const category of ['pokemon','onepiece','sports','othertcg','lowkey']) {
            const cfg = normalizeMonitorGroupConfig(adminGroups?.[category]);
            const existing = await getWebhookRouteFromDb({ scope: 'admin', userId: currentUser.id, webhookType: 'monitor', category }).catch(() => null);
            if (!existing && String(cfg.webhook_url || '').trim()) {
                await upsertDiscordWebhookRoute({ scope: 'admin', userId: currentUser.id, webhookType: 'monitor', category, webhookUrl: cfg.webhook_url, pingMode: cfg.ping_mode, roleMention: cfg.role_mention });
            }
        }
    }
}

async function getAllAdminMonitorGroupConfigs() {
    const { data: admins, error } = await supabase
        .from('users')
        .select('id, role, email')
        .eq('role', 'admin');
    if (error) throw new Error(error.message);
    const rows = [];
    for (const adminUser of admins || []) {
        const routeRows = await listDiscordWebhookRoutes({ scope: 'admin', userId: adminUser.id, webhookType: 'monitor' }).catch(() => []);
        const monitorGroups = {};
        for (const row of routeRows) {
            monitorGroups[row.category] = { webhook_url: row.webhook_url, ping_mode: row.ping_mode, role_mention: row.role_mention };
        }
        if (!Object.keys(monitorGroups).length) {
            const settings = await getAdminWebhookSettings(adminUser.id).catch(() => ({}));
            Object.assign(monitorGroups, settings?.monitor_groups || {});
        }
        rows.push({ user_id: adminUser.id, role: adminUser.role, email: adminUser.email, monitor_groups: monitorGroups });
    }
    return rows;
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

function normalizeDiscordUserId(value = '') {
    return String(value || '').trim();
}

function formatDiscordMention(value = '', fallbackEmail = '') {
    const raw = String(value || '').trim();
    if (!raw) return maskEmail(fallbackEmail);
    if (/^<@!?\d{17,20}>$/.test(raw)) return raw;
    if (/^\d{17,20}$/.test(raw)) return `<@${raw}>`;
    return raw;
}

function getCheckoutBannerText(mentionText = '', brandLabel = '') {
    const brand = String(brandLabel || '').trim();
    const mention = String(mentionText || '').trim() || 'there';
    return brand
        ? `Thank you ${mention} for checking out with The Shore Shack x ${brand.toUpperCase()}`
        : `Thank you ${mention} for checking out with The Shore Shack`;
}

const discordWebhookQueues = new Map();
const discordDeliveryInFlight = new Set();
const inboundWebhookInFlight = new Map();
const inboundWebhookRecent = new Map();

function cleanupInboundWebhookDedupe(now = Date.now()) {
    for (const [key, expiresAt] of inboundWebhookRecent.entries()) {
        if (Number(expiresAt || 0) <= now) inboundWebhookRecent.delete(key);
    }
}

function claimInboundWebhook(key, windowSeconds = 45) {
    if (!key) return { claimed: true, duplicate: false, reason: '' };
    const now = Date.now();
    cleanupInboundWebhookDedupe(now);
    if (inboundWebhookInFlight.has(key)) return { claimed: false, duplicate: true, reason: 'in_flight' };
    const recentUntil = Number(inboundWebhookRecent.get(key) || 0);
    if (recentUntil > now) return { claimed: false, duplicate: true, reason: 'recent' };
    inboundWebhookInFlight.set(key, now);
    return { claimed: true, duplicate: false, reason: '' };
}

function releaseInboundWebhook(key, windowSeconds = 45) {
    if (!key) return;
    inboundWebhookInFlight.delete(key);
    const ttlMs = Math.max(1, Number(windowSeconds || 45)) * 1000;
    inboundWebhookRecent.set(key, Date.now() + ttlMs);
}

function abandonInboundWebhook(key) {
    if (!key) return;
    inboundWebhookInFlight.delete(key);
}

function isDiscordDeliveryInFlight(dedupeKey = '') {
    return !!dedupeKey && discordDeliveryInFlight.has(String(dedupeKey));
}

function markDiscordDeliveryInFlight(dedupeKey = '') {
    if (!dedupeKey) return;
    discordDeliveryInFlight.add(String(dedupeKey));
}

function clearDiscordDeliveryInFlight(dedupeKey = '') {
    if (!dedupeKey) return;
    discordDeliveryInFlight.delete(String(dedupeKey));
}

function getDiscordDeliveryDedupeKey(webhookUrl = '', order = null) {
    const trimmedWebhookUrl = String(webhookUrl || '').trim();
    if (!trimmedWebhookUrl || !order?.raw_payload) return '';
    const checkoutFingerprint = buildCheckoutDedupeFingerprint(order.raw_payload || {});
    const checkoutType = classifyCheckoutWebhookType(order);
    if (!checkoutFingerprint) return '';
    return `${trimmedWebhookUrl}::${checkoutType}::${checkoutFingerprint}`;
}

function getDiscordQueue(webhookUrl) {
    const key = String(webhookUrl || '').trim();
    if (!key) throw new Error('Webhook URL is required for queue');
    if (!discordWebhookQueues.has(key)) {
        discordWebhookQueues.set(key, { running: false, jobs: [], lastSentAt: 0 });
    }
    return discordWebhookQueues.get(key);
}

function enqueueDiscordWebhookJob(webhookUrl, job) {
    return new Promise((resolve, reject) => {
        const queue = getDiscordQueue(webhookUrl);
        queue.jobs.push({ webhookUrl, job, resolve, reject, enqueuedAt: Date.now() });
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
                const now = Date.now();
                const minGapMs = 1200;
                const waitMs = Math.max(0, minGapMs - (now - queue.lastSentAt));
                if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
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

async function getMonitorWebhookToken() {
    const settings = await getAppSetting('monitor_webhook_settings', {});
    return String(settings?.token || '').trim();
}

async function createMonitorWebhook(req, createdBy = null) {
    const token = crypto.randomBytes(18).toString('hex');
    const current = await getAppSetting('monitor_webhook_settings', {});
    await setAppSetting('monitor_webhook_settings', {
        ...current,
        token,
        created_by: createdBy || null,
        updated_at: new Date().toISOString()
    });
    return { token, url: `${getApiBaseUrl(req)}/webhooks/monitor/${token}` };
}



async function getWebhookLogEntries(limit = 200) {
    const current = await getAppSetting('webhook_event_log', []);
    const rows = Array.isArray(current) ? current : [];
    return rows.slice(0, Math.max(1, Number(limit) || 200));
}

async function appendWebhookLogEntry(entry = {}) {
    const current = await getAppSetting('webhook_event_log', []);
    const rows = Array.isArray(current) ? current : [];
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString('hex');
    const row = {
        id,
        created_at: new Date().toISOString(),
        type: String(entry.type || '').trim() || 'unknown',
        status: String(entry.status || '').trim() || 'received',
        site: String(entry.site || '').trim(),
        product_type: String(entry.product_type || '').trim(),
        product: String(entry.product || '').trim(),
        sku: String(entry.sku || '').trim(),
        error: String(entry.error || '').trim(),
        payload: entry.payload || null,
        parsed_items: Array.isArray(entry.parsed_items) ? entry.parsed_items : [],
        discord_targets: Array.isArray(entry.discord_targets) ? entry.discord_targets : [],
        fingerprint: String(entry.fingerprint || '').trim()
    };
    rows.unshift(row);
    await setAppSetting('webhook_event_log', rows.slice(0, 500));
    return row;
}

async function updateWebhookLogEntry(id, patch = {}) {
    if (!id) return null;
    const current = await getAppSetting('webhook_event_log', []);
    const rows = Array.isArray(current) ? current : [];
    const idx = rows.findIndex((row) => String(row.id) === String(id));
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch };
    await setAppSetting('webhook_event_log', rows.slice(0, 500));
    return rows[idx];
}


async function getMonitorDedupeWindowSeconds() {
    const currentGlobal = await getAppSetting('webhook_settings', {});
    const raw = Number(currentGlobal?.monitor_dedupe_window_seconds);
    if (Number.isFinite(raw) && raw >= 0) return Math.min(600, Math.round(raw));
    return 90;
}

function buildMonitorDedupeFingerprint(site = '', items = []) {
    const normalizedItems = (Array.isArray(items) ? items : []).map((item) => ({
        sku: String(item?.sku || '').trim(),
        title: String(item?.title || '').trim().toLowerCase(),
        price: String(item?.price ?? '').trim().toLowerCase(),
        url: String(item?.url || '').trim().toLowerCase(),
        category: String(item?.category || '').trim().toLowerCase()
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const payload = {
        type: 'monitor',
        site: String(site || '').trim().toLowerCase(),
        items: normalizedItems
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function findRecentDuplicateMonitorLog(fingerprint, windowSeconds) {
    if (!fingerprint || !windowSeconds) return null;
    const current = await getAppSetting('webhook_event_log', []);
    const rows = Array.isArray(current) ? current : [];
    const cutoff = Date.now() - (Number(windowSeconds) * 1000);
    return rows.find((row) => (
        String(row.type || '') === 'monitor' &&
        String(row.fingerprint || '') === String(fingerprint) &&
        String(row.status || '') !== 'duplicate_skipped' &&
        new Date(row.created_at || 0).getTime() >= cutoff
    )) || null;
}


function buildCheckoutDedupeFingerprint(payload = {}) {
    const normalized = normalizeIncomingOrderPayload(payload || {});
    const { embed } = extractEmbedFields(payload || {});
    const checkoutType = classifyCheckoutWebhookType({ raw_payload: payload || {}, status: '' });
    const orderId = String(normalized.external_order_id || normalized.order_id || normalized.order_number || '').trim();
    const site = String(normalized.site || '').trim().toLowerCase();
    const sku = String(normalized.sku || '').trim();
    const title = decodeHtmlEntities(String(normalized.product_name || embed?.title || '')).trim().toLowerCase();
    const payloadForHash = { type: 'checkout', checkoutType, orderId, site, sku, title };
    return crypto.createHash('sha256').update(JSON.stringify(payloadForHash)).digest('hex');
}

async function findRecentDuplicateCheckoutLog(fingerprint, windowSeconds = 45) {
    if (!fingerprint || !windowSeconds) return null;
    const current = await getAppSetting('webhook_event_log', []);
    const rows = Array.isArray(current) ? current : [];
    const cutoff = Date.now() - (Number(windowSeconds) * 1000);
    return rows.find((row) => (
        String(row.type || '') === 'checkout' &&
        String(row.fingerprint || '') === String(fingerprint) &&
        String(row.status || '') !== 'duplicate_skipped' &&
        new Date(row.created_at || 0).getTime() >= cutoff
    )) || null;
}

async function sendCheckoutDiscordNotificationsForPayload(payload = {}, matchedUser = null, extra = {}) {
    const normalized = normalizeIncomingOrderPayload(payload || {});
    const pseudoOrder = {
        raw_payload: payload,
        status: extra.status || 'processed',
        site: normalized.site,
        source: normalized.source,
        credits_charged: 0,
        product_name: normalized.product_name,
        external_order_id: normalized.external_order_id,
        order_number: normalized.order_number,
        sku: normalized.sku
    };
    return sendCheckoutDiscordNotifications(pseudoOrder, matchedUser || null);
}

async function sendUnmatchedCheckoutDiscordNotification(payload = {}, errorMessage = '') {
    const globalSettings = await getAppSetting('webhook_settings', {});
    const webhookUrl = String(globalSettings?.discord_webhook_url || '').trim();
    if (!webhookUrl) return { skipped: 'discord_webhook_not_configured' };
    const normalized = normalizeIncomingOrderPayload(payload || {});
    const body = JSON.stringify({
        username: 'The Shore Shack',
        embeds: [{
            title: 'Checkout Webhook Received • Unmatched User',
            description: normalized.product_name || payload.product_name || 'Checkout webhook received',
            fields: [
                { name: 'Site', value: String(normalized.site || payload.site || '-'), inline: true },
                { name: 'Source', value: String(normalized.source || payload.source || '-'), inline: true },
                { name: 'Profile / Email', value: String(payload.profile_name || payload.email || payload.customer_email || '-'), inline: true },
                { name: 'SKU', value: String(normalized.sku || payload.sku || '-'), inline: true },
                { name: 'Quantity', value: String(normalized.quantity || payload.quantity || 1), inline: true },
                { name: 'Error', value: errorMessage || 'Could not match webhook payload to a user', inline: false },
                { name: 'Product Link', value: String(normalized.product_url || payload.product_url || '-'), inline: false }
            ],
            thumbnail: normalized.image_url ? { url: normalized.image_url } : undefined,
            timestamp: new Date().toISOString()
        }]
    });
    return enqueueDiscordWebhookJob(webhookUrl, async () => {
        const response = await globalThis.fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        if (!response.ok) throw new Error(`Discord webhook failed (${response.status})`);
        return { success: true };
    });
}

function decodeHtmlEntities(value = '') {
    let text = String(value || '');
    if (!text) return '';
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' ',
        mdash: '—',
        ndash: '–',
        rsquo: '’',
        lsquo: '‘',
        rdquo: '”',
        ldquo: '“',
        hellip: '…',
        copy: '©',
        reg: '®',
        trade: '™',
        eacute: 'é',
        Eacute: 'É'
    };
    text = text.replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
        const code = parseInt(h, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
    text = text.replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(named, name) ? named[name] : m);
    return text;
}

function normalizeMonitorType(value = '') {
    const t = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (['pokemon','pokmon'].includes(t)) return 'pokemon';
    if (['onepiece'].includes(t)) return 'onepiece';
    if (['sport','sports','sportscards','sportscard'].includes(t)) return 'sports';
    if (['othertcg','mtg','magic','lorcana','yugioh','yugio','digimon','dragonball','unionarena','weiss'].includes(t)) return 'othertcg';
    if (['lowkey','other','lowkeyflips','flips'].includes(t)) return 'lowkey';
    return '';
}

function classifyMonitorType({ title = '', productType = '', url = '' }) {
    const explicit = normalizeMonitorType(productType);
    if (explicit) return explicit;
    const hay = decodeHtmlEntities(`${title} ${url}`).toLowerCase();
    if (/pokemon|pok[eé]mon/.test(hay)) return 'pokemon';
    if (/one\s*piece/.test(hay)) return 'onepiece';
    if (/magic|mtg|lorcana|yu-?gi-?oh|yugioh|digimon|dragon ball|union arena|weiss/.test(hay)) return 'othertcg';
    if (/topps|panini|upper deck|sports card|baseball card|basketball card|football card|soccer card|hockey card/.test(hay)) return 'sports';
    return 'lowkey';
}


function extractEmbedFields(payload = {}) {
    const embed = Array.isArray(payload.embeds) ? (payload.embeds[0] || {}) : {};
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    const map = {};
    const list = [];
    for (const field of fields) {
        const key = String(field?.name || '').trim().toLowerCase();
        const value = decodeHtmlEntities(String(field?.value || '').trim());
        if (key) map[key] = value;
        list.push({ key, value, raw: field });
    }
    return { embed, fields: map, fieldList: list };
}

function extractMarkdownLink(value = '') {
    const match = String(value || '').match(/\[([^\]]+)\]\(([^)]+)\)/);
    return match ? { text: String(match[1] || '').trim(), url: String(match[2] || '').trim() } : null;
}

function looksLikeUrl(value = '') {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function splitMonitorPipeValues(value = '') {
    return String(value || '')
        .split(/\s*\|\s*/)
        .map((v) => String(v || '').trim())
        .filter(Boolean);
}

function cleanMonitorPriceValue(value) {
    if (value == null) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    const money = raw.match(/\$?\d+(?:\.\d{1,2})?/);
    if (!money) return raw.replace(/^\$+/, '');
    return money[0].replace(/^\$+/, '');
}

function normalizeMonitorSite(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (raw.startsWith('target')) return 'target';
    if (raw.startsWith('walmart')) return 'walmart';
    if (raw.startsWith('amazon')) return 'amazon';
    if (raw.startsWith('hot topic') || raw.startsWith('hottopic')) return 'hottopic';
    if (raw.startsWith('box lunch') || raw.startsWith('boxlunch')) return 'boxlunch';
    return raw;
}


function extractAmazonAsin(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const direct = raw.match(/(B0[A-Z0-9]{8})/i);
    if (direct) return String(direct[1] || '').toUpperCase();
    const fromDp = raw.match(/\/dp\/([A-Z0-9]{10})/i);
    if (fromDp) return String(fromDp[1] || '').toUpperCase();
    return '';
}

function siteAliasesForCatalog(site = '') {
    const normalized = normalizeMonitorSite(site);
    if (normalized === 'amazon') return ['amazon', 'amazonv3'];
    if (normalized === 'target') return ['target', 'targetgo'];
    if (normalized === 'walmart') return ['walmart'];
    return [normalized].filter(Boolean);
}

async function fetchCatalogProductDetailsForMonitor(item = {}) {
    try {
        const aliases = siteAliasesForCatalog(item.site);
        const sku = String(item.sku || '').trim();
        if (!aliases.length || !sku) return null;
        const { data, error } = await supabase
            .from('catalog_products')
            .select('site, sku, product_name, image_url, product_url, default_max_price')
            .in('site', aliases)
            .eq('sku', sku)
            .limit(1)
            .maybeSingle();
        if (error) return null;
        if (!data) return null;
        return {
            title: String(data.product_name || '').trim(),
            image: String(data.image_url || '').trim(),
            url: String(data.product_url || '').trim(),
            price: data.default_max_price == null ? '' : String(Number(data.default_max_price).toFixed(2)),
            site: String(data.site || '').trim().toLowerCase(),
            category: classifyMonitorType({ title: String(data.product_name || ''), productType: '', url: String(data.product_url || '') })
        };
    } catch {
        return null;
    }
}

async function fetchTargetItemDetailsBySku(sku) {
    const clean = String(sku || '').trim();
    if (!clean) return null;
    const url = `https://www.target.com/p/-/A-${encodeURIComponent(clean)}`;
    const response = await globalThis.fetch(url, {
        headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'accept-language': 'en-US,en;q=0.9'
        }
    });
    if (!response.ok) return null;
    const html = await response.text();
    if (!html || html.length < 1000) return null;
    const $ = cheerio.load(html);
    const title = $('meta[property="og:title"]').attr('content') || $('title').text().trim() || '';
    const image = $('meta[property="og:image"]').attr('content') || $('img[src*="target.scene7"]').first().attr('src') || '';
    const priceText = $('meta[property="product:price:amount"]').attr('content') || $('[data-test="product-price"]').first().text().trim() || $('[data-test="current-price"]').first().text().trim() || '';
    const price = cleanMonitorPriceValue(priceText || '');
    let cartLimit = null;
    const limitPatterns = [
        /maxOrderQuantity"?\s*[:=]\s*(\d{1,3})/i,
        /order[_ ]?limit"?\s*[:=]\s*(\d{1,3})/i,
        /max[_ ]?quantity"?\s*[:=]\s*(\d{1,3})/i,
        /limit\s+(?:of\s+)?(\d{1,3})\s+(?:per|qty|quantity)/i
    ];
    for (const pattern of limitPatterns) {
        const m = html.match(pattern);
        if (m) {
            cartLimit = Number(m[1]);
            break;
        }
    }
    return {
        title: decodeHtmlEntities(String(title || '').replace(/\s*:[^:]*Target\s*$/i, '').trim()),
        image: String(image || '').trim(),
        price,
        url,
        cartLimit
    };
}

async function enrichMonitorItems(items = []) {
    const enriched = [];
    for (const item of items) {
        const next = { ...item };
        next.site = normalizeMonitorSite(next.site);
        next.title = decodeHtmlEntities(String(next.title || '').trim());

        if (next.site === 'amazon') {
            const asin = extractAmazonAsin(next.sku || next.url || next.title);
            if (asin) {
                next.sku = asin;
                next.url = next.url || `https://www.amazon.com/dp/${asin}`;
            }
            const catalog = await fetchCatalogProductDetailsForMonitor(next);
            if (catalog) {
                next.title = catalog.title || next.title;
                next.image = catalog.image || next.image;
                next.url = next.url || catalog.url || next.url;
                next.price = cleanMonitorPriceValue(next.price) || cleanMonitorPriceValue(catalog.price) || next.price;
                next.category = catalog.category || next.category;
            }
            next.price = cleanMonitorPriceValue(next.price);
            if (!next.category || next.category === 'lowkey') {
                next.category = classifyMonitorType({ title: next.title, productType: next.productType, url: next.url });
            }
            enriched.push(next);
            continue;
        }

        const needsCatalog = !!next.sku && (!next.image || !next.url || !next.title || !cleanMonitorPriceValue(next.price));
        if (needsCatalog) {
            const catalog = await fetchCatalogProductDetailsForMonitor(next);
            if (catalog) {
                next.title = next.title || catalog.title || next.title;
                next.image = next.image || catalog.image || next.image;
                next.url = next.url || catalog.url || next.url;
                next.price = cleanMonitorPriceValue(next.price) || cleanMonitorPriceValue(catalog.price) || next.price;
                next.category = next.category || catalog.category || next.category;
            }
        }

        const site = String(next.site || '').toLowerCase();
        const needsLookup = site.includes('target') && (!!next.sku) && (!next.image || !next.url || !next.title || !cleanMonitorPriceValue(next.price));
        if (needsLookup) {
            try {
                const details = await fetchTargetItemDetailsBySku(next.sku);
                if (details) {
                    next.title = next.title || details.title || next.title;
                    next.image = next.image || details.image || next.image;
                    next.url = next.url || details.url || next.url;
                    next.price = cleanMonitorPriceValue(next.price) || details.price || next.price;
                    next.cartLimit = next.cartLimit || details.cartLimit || null;
                }
            } catch (err) {
                console.error('Target monitor enrichment failed:', err.message || err);
            }
        }
        next.price = cleanMonitorPriceValue(next.price);
        if (!next.category || next.category === 'lowkey') {
            next.category = classifyMonitorType({ title: next.title, productType: next.productType, url: next.url });
        }
        enriched.push(next);
    }
    return enriched;
}

function extractMonitorItems(payload = {}) {
    const items = [];
    const { embed, fields, fieldList } = extractEmbedFields(payload);
    const baseSite = normalizeMonitorSite(String(payload.site || payload.source || fields['site'] || '').trim().toLowerCase());
    const explicitType = String(payload.product_type || payload.category || fields['category'] || '').trim();
    const baseImage = String(payload.image_url || payload.image || embed.thumbnail?.url || embed.image?.url || '').trim();
    const productFieldValue = String(fields['product'] || '').trim();
    const productFieldLink = extractMarkdownLink(productFieldValue);
    const rawBaseUrl = payload.product_url || payload.url || payload.link || fields['product link'] || productFieldLink?.url || embed.url || '';
    const baseUrl = looksLikeUrl(rawBaseUrl) ? String(rawBaseUrl).trim() : '';
    const basePrice = payload.price ?? payload.Price ?? fields['price'] ?? null;
    const skuFieldRaw = String(fields['sku'] || payload.sku || payload.SKU || '').trim();
    const fallbackSku = extractAmazonAsin(skuFieldRaw || ((baseSite.includes('amazon') && productFieldValue) ? productFieldValue : '')) || skuFieldRaw || ((baseSite.includes('amazon') && productFieldValue) ? productFieldValue : '');
    const amazonAtcLinks = fieldList
        .filter((field) => field.key.startsWith('atc link'))
        .map((field) => ({
            label: String(field.raw?.name || field.key || '').trim(),
            url: extractMarkdownLink(field.value)?.url || ''
        }))
        .filter((row) => row.url);

    const arr = Array.isArray(payload.items) ? payload.items : [];
    for (const row of arr) {
        items.push({
            sku: String(row.sku || row.SKU || '').trim(),
            title: decodeHtmlEntities(String(row.title || row.name || row.product_name || '').trim()),
            price: row.price ?? row.Price ?? null,
            url: String(row.url || row.product_url || row.link || '').trim(),
            image: String(row.image || row.image_url || row.thumbnail || '').trim(),
            site: String(row.site || baseSite).trim().toLowerCase(),
            stock: row.stock ?? row.stock_count ?? row.quantity ?? null,
            cartLimit: row.cart_limit ?? row.max_order_quantity ?? row.cart_limit_qty ?? null,
            productType: String(row.product_type || explicitType || '').trim(),
            atcLinks: Array.isArray(row.atcLinks) ? row.atcLinks : amazonAtcLinks
        });
    }

    const skuFromField = String(fields['instock skus'] || fields['instock sku'] || payload.instock_skus || payload.skus || '').trim();
    const skuList = splitMonitorPipeValues(skuFromField);
    const titleSkuField = String(fields['title/sku'] || fields['title sku'] || payload.title || payload.product_name || '').trim();
    const titleList = splitMonitorPipeValues(titleSkuField);
    const priceList = splitMonitorPipeValues(basePrice || '');

    if (skuList.length) {
        for (let i = 0; i < skuList.length; i += 1) {
            const sku = skuList[i];
            const resolvedSku = extractAmazonAsin(sku) || sku;
            items.push({
                sku: resolvedSku,
                title: decodeHtmlEntities(titleList[i] || titleList[0] || ''),
                price: priceList[i] || priceList[0] || '',
                url: baseUrl,
                image: baseImage,
                site: baseSite,
                stock: payload.stock_count ?? fields['stock'] ?? null,
                cartLimit: payload.cart_limit ?? fields['cart limit'] ?? null,
                productType: explicitType,
                atcLinks: amazonAtcLinks
            });
        }
    }

    if (!items.length) {
        const possibleSku = String(payload.sku || payload.SKU || '').trim();
        items.push({
            sku: possibleSku || fallbackSku,
            title: decodeHtmlEntities(titleList[0] || (productFieldLink?.text || (!looksLikeUrl(productFieldValue) ? productFieldValue : '')) || ''),
            price: priceList[0] || cleanMonitorPriceValue(basePrice || ''),
            url: baseUrl,
            image: baseImage,
            site: baseSite,
            stock: payload.stock_count ?? fields['stock'] ?? null,
            cartLimit: payload.cart_limit ?? fields['cart limit'] ?? null,
            productType: explicitType,
            atcLinks: amazonAtcLinks
        });
    }

    const deduped = [];
    const seen = new Set();
    for (const item of items.filter((x) => x.sku || x.title || x.url)) {
        const key = `${String(item.sku || '').trim()}::${String(item.title || '').trim()}::${String(item.url || '').trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
    }
    return deduped;
}

function buildProductUrl(site, sku, fallbackUrl='', title = '', image = '') {
    if (fallbackUrl) return fallbackUrl;
    const s = String(site||'').toLowerCase();
    const clean = String(sku||'').trim();
    if (s.includes('boxlunch')) {
        return buildBoxLunchUrl({ title, image, url: fallbackUrl });
    }
    if (s.includes('hottopic') || s.includes('hot topic')) {
        return buildHotTopicUrl({ title, image, url: fallbackUrl });
    }
    if (s.includes('amazon')) {
        if (clean) return `https://www.amazon.com/dp/${clean}`;
        return '';
    }
    if (!clean) return '';
    if (s.includes('target')) return `https://www.target.com/p/-/A-${clean}`;
    if (s.includes('walmart')) return `https://www.walmart.com/ip/${clean}`;
    if (s.includes('sams')) return `https://www.samsclub.com/s/${encodeURIComponent(clean)}`;
    return '';
}

function normalizeMonitorGroupConfig(raw) {
    if (typeof raw === 'string') {
        return { webhook_url: String(raw || '').trim(), ping_mode: 'none', role_mention: '' };
    }
    const value = raw && typeof raw === 'object' ? raw : {};
    const pingMode = ['none', 'everyone', 'role'].includes(String(value.ping_mode || '').trim().toLowerCase())
        ? String(value.ping_mode || '').trim().toLowerCase()
        : 'none';
    return {
        webhook_url: String(value.webhook_url || value.url || '').trim(),
        ping_mode: pingMode,
        role_mention: String(value.role_mention || '').trim()
    };
}

function getMonitorMentionText(routeConfig) {
    const config = normalizeMonitorGroupConfig(routeConfig);
    if (config.ping_mode === 'everyone') return '@everyone';
    if (config.ping_mode === 'role' && config.role_mention) return config.role_mention;
    return '';
}

async function sendMonitorDiscordWebhook(routeConfigOrUrl, item) {
    const routeConfig = normalizeMonitorGroupConfig(routeConfigOrUrl);
    const webhookUrl = routeConfig.webhook_url || (typeof routeConfigOrUrl === 'string' ? String(routeConfigOrUrl).trim() : '');
    const finalUrl = buildProductUrl(item.site, item.sku, item.url, item.title, item.image);
    const cleanPrice = cleanMonitorPriceValue(item.price);
    const mentionText = getMonitorMentionText(routeConfig);
    const displayPrice = cleanPrice && cleanPrice.toUpperCase() !== 'N/A' ? `$${cleanPrice}` : '-';
    const fields = [
        { name: 'Site', value: String(item.site || '-'), inline: true },
        { name: 'Category', value: String(item.category || 'lowkey'), inline: true },
        { name: 'SKU', value: String(item.sku || '-'), inline: true },
        { name: 'Price', value: displayPrice, inline: true }
    ];
    if (item.cartLimit != null && String(item.cartLimit).trim() !== '') {
        fields.push({ name: 'Cart Limit', value: String(item.cartLimit), inline: true });
    }
    if (finalUrl) {
        fields.push({ name: 'Product Link', value: finalUrl, inline: false });
    }
    const atcLinks = Array.isArray(item.atcLinks) ? item.atcLinks.filter((row) => row && row.url) : [];
    if (atcLinks.length) {
        const allowedQty = new Set(['1', '3', '5']);
        const formattedAtcLinks = atcLinks
            .map((row) => {
                const qtyMatch = String(row.label || '').match(/(\d+)x/i);
                const qty = qtyMatch ? String(qtyMatch[1]) : '';
                if (qty && !allowedQty.has(qty)) return null;
                const label = qty ? `ATC ${qty}x` : String(row.label || 'ATC').replace(/^ATC Link\s*/i, 'ATC ');
                return `[${label}](${row.url})`;
            })
            .filter(Boolean)
            .slice(0, 3);
        if (formattedAtcLinks.length) {
            fields.push({ name: 'ATC Links', value: formattedAtcLinks.join(' • '), inline: false });
        }
    }
    const body = JSON.stringify({
        username: 'In Stock Monitor',
        content: mentionText || undefined,
        allowed_mentions: { parse: ['everyone', 'roles'] },
        embeds: [{
            title: decodeHtmlEntities(item.title || item.sku || 'In stock item'),
            description: 'Item restocked',
            url: finalUrl || undefined,
            fields,
            thumbnail: item.image ? { url: item.image } : undefined,
            timestamp: new Date().toISOString()
        }]
    });
    return enqueueDiscordWebhookJob(webhookUrl, async () => {
        for (let attempt = 1; attempt <= 5; attempt++) {
            const response = await globalThis.fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            if (response.ok) return { success: true, attempt, ping_mode: routeConfig.ping_mode || 'none', role_mention: routeConfig.role_mention || '' };
            const text = await response.text().catch(() => '');
            if (response.status === 429) {
                let retryMs = 5000;
                try {
                    const parsed = JSON.parse(text || '{}');
                    if (parsed?.retry_after != null) retryMs = Math.ceil(Number(parsed.retry_after) * 1000);
                } catch {}
                await new Promise((resolve) => setTimeout(resolve, retryMs));
                continue;
            }
            throw new Error(`Discord webhook failed (${response.status}): ${text || response.statusText}`);
        }
        throw new Error('Discord webhook failed after maximum retry attempts');
    });
}

function maskEmail(email = '') {
    const value = String(email || '').trim().toLowerCase();
    const parts = value.split('@');
    if (parts.length !== 2) return value || '-';
    const [name, domain] = parts;
    const maskedName = name.length <= 2 ? `${name[0] || '*'}*` : `${name.slice(0, 2)}***`;
    return `${maskedName}@${domain}`;
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
    const checkoutType = classifyCheckoutWebhookType(order);
    const isInsufficient = String(order.status || '') === 'insufficient_credits';
    const mentionText = checkoutType === 'success' ? formatDiscordMention(discordHandle, userEmail) : '';

    const siteLabel = String(order.site || normalized.site || order.source || 'Bot');
    let title = '';
    let footerText = '';
    let description = '';

    if (checkoutType === 'error') {
        const { embed } = extractEmbedFields(payload);
        const rawTitle = decodeHtmlEntities(String(embed?.title || '')).replace(/\*\*/g, '').trim();
        const rawDesc = decodeHtmlEntities(String(embed?.description || '')).trim();
        title = `${rawTitle || 'Checkout Error'} • ${siteLabel}`;
        description = rawDesc || normalized.product_name || order.product_name || 'Checkout error received';
        footerText = 'Checkout error captured by The Shore Shack';
    } else {
        title = isInsufficient
            ? `Checkout Logged • Credits Needed`
            : `Successful Checkout • ${siteLabel}`;
        description = normalized.product_name || order.product_name || 'Checkout received';
        footerText = isInsufficient
            ? 'Order saved without charging credits'
            : 'Youve Been Served by The Shore Shack';
    }

    const priceNumber = Number(normalized.price);
    const priceValue = Number.isFinite(priceNumber) ? `$${priceNumber.toFixed(2)}` : '-';

    const embed = {
        title,
        description,
        fields: [
            { name: 'Site', value: String(order.site || normalized.site || '-'), inline: true },
            { name: 'Source', value: String(order.source || normalized.source || '-'), inline: true },
            { name: 'Quantity', value: String(normalized.quantity || 1), inline: true },
            { name: 'Price', value: priceValue, inline: true }
        ],
        footer: { text: footerText },
        timestamp: new Date().toISOString()
    };

    if (checkoutType === 'success') {
        embed.fields.push({ name: 'Credits', value: String(order.credits_charged || 0), inline: true });
    }

    if (normalized.sku) {
        embed.fields.push({ name: 'SKU', value: String(normalized.sku), inline: true });
    }
    if (normalized.order_number || normalized.external_order_id || order.external_order_id) {
        embed.fields.push({ name: 'Order ID', value: String(normalized.order_number || normalized.external_order_id || order.external_order_id), inline: true });
    }
    if (normalized.profile_name && checkoutType !== 'success') {
        embed.fields.push({ name: 'Profile', value: String(normalized.profile_name), inline: true });
    }
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

    const body = JSON.stringify({
        username,
        content: checkoutType === 'success' ? getCheckoutBannerText(mentionText, brandLabel) : '',
        allowed_mentions: { parse: ['users'] },
        embeds: [embed]
    });

    const deliveryDedupeKey = getDiscordDeliveryDedupeKey(trimmedWebhookUrl, order);
    if (isDiscordDeliveryInFlight(deliveryDedupeKey)) {
        console.log(`Discord delivery in-flight dedupe skipped -> ${trimmedWebhookUrl.slice(0, 40)}...`);
        return { success: true, queued: false, dedupe_skipped: true, dedupe_reason: 'in_flight' };
    }

    markDiscordDeliveryInFlight(deliveryDedupeKey);
    try {
        return await enqueueDiscordWebhookJob(trimmedWebhookUrl, async () => {
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
                let bodyText = '';
                let json = null;
                if (contentType.includes('application/json')) {
                    json = await response.json().catch(() => null);
                    bodyText = JSON.stringify(json || {});
                } else {
                    bodyText = await response.text().catch(() => '');
                }
                console.error(`Discord queue send response ${response.status} on attempt ${attempt}: ${bodyText}`);
                if (response.status === 429) {
                    let retryAfterMs = 5000;
                    if (json?.retry_after != null) {
                        retryAfterMs = Math.ceil(Number(json.retry_after) * 1000);
                    } else {
                        const retryAfterHeader = response.headers.get('retry-after');
                        if (retryAfterHeader) retryAfterMs = Math.ceil(Number(retryAfterHeader) * 1000) || retryAfterMs;
                    }
                    console.log(`Discord queue rate limited. Waiting ${retryAfterMs}ms before retry...`);
                    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
                    continue;
                }
                if (response.status === 403 || bodyText.includes('Error 1015') || bodyText.includes('rate limited')) {
                    const backoffMs = 15000 * attempt;
                    console.log(`Discord queue Cloudflare/backoff wait ${backoffMs}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, backoffMs));
                    continue;
                }
                throw new Error(`Discord webhook failed (${response.status}): ${bodyText || response.statusText}`);
            }
            throw new Error('Discord webhook failed after maximum retry attempts');
        });
    } finally {
        clearDiscordDeliveryInFlight(deliveryDedupeKey);
    }
}

function classifyCheckoutWebhookType(order) {
    const payload = order?.raw_payload || {};
    const { embed } = extractEmbedFields(payload);
    const title = decodeHtmlEntities(String(embed?.title || '')).toLowerCase();
    const description = decodeHtmlEntities(String(embed?.description || '')).toLowerCase();
    const authorName = decodeHtmlEntities(String(embed?.author?.name || '')).toLowerCase();
    const hay = `${title} ${description} ${authorName}`;
    if (/checkout oos|failed|declined|error|canceled|cancelled|payment failed|out of stock/.test(hay)) return 'error';
    if (/successful checkout|success|confirmed|order confirmed/.test(hay)) return 'success';
    return String(order?.status || '').includes('insufficient') ? 'error' : 'success';
}


async function sendCheckoutDiscordNotifications(order, user) {
    const results = [];
    const userEmail = String(user?.email || '');
    const userSettings = user?.id ? await getUserSettings(user.id) : {};
    const discordHandle = normalizeDiscordUserId(userSettings?.discord_user_id || '');

    const checkoutType = classifyCheckoutWebhookType(order);
    const globalSettings = await getAppSetting('webhook_settings', {});
    const globalRoute = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: checkoutType === 'error' ? 'checkout_error' : 'checkout_success', category: 'all' }).catch(() => null);
    const globalWebhookUrl = String((globalRoute?.webhook_url || (checkoutType === 'error' ? globalSettings?.checkout_error_webhook_url : globalSettings?.discord_webhook_url)) || '').trim();

    const destinations = [];
    const seen = new Set();

    function addDestination(scope, webhookUrl, extra = {}) {
        const url = String(webhookUrl || '').trim();
        if (!url) return;
        if (seen.has(url)) return;
        seen.add(url);
        destinations.push({ scope, webhookUrl: url, ...extra });
    }

    addDestination('super_admin', globalWebhookUrl, { brandLabel: '', username: 'The Shore Shack' });

    // admin checkout should also go to their own admin webhook
    if (user?.role === 'admin' && user?.id) {
        const adminSettings = await getAdminWebhookSettings(user.id);
        const adminRoute = await getWebhookRouteFromDb({ scope: 'admin', userId: user.id, webhookType: checkoutType === 'error' ? 'checkout_error' : 'checkout_success', category: 'all' }).catch(() => null);
        const adminWebhookUrl = String((adminRoute?.webhook_url || (checkoutType === 'error' ? adminSettings?.checkout_error_webhook_url : adminSettings?.discord_webhook_url)) || '').trim();
        const brandLabel = String(adminSettings?.brand_label || '').trim();
        addDestination('owner_admin', adminWebhookUrl, { admin_user_id: user.id, brandLabel, username: brandLabel || 'The Shore Shack' });
    }

    if (user?.owner_admin_id) {
        const adminSettings = await getAdminWebhookSettings(user.owner_admin_id);
        const adminRoute = await getWebhookRouteFromDb({ scope: 'admin', userId: user.owner_admin_id, webhookType: checkoutType === 'error' ? 'checkout_error' : 'checkout_success', category: 'all' }).catch(() => null);
        const adminWebhookUrl = String((adminRoute?.webhook_url || (checkoutType === 'error' ? adminSettings?.checkout_error_webhook_url : adminSettings?.discord_webhook_url)) || '').trim();
        const brandLabel = String(adminSettings?.brand_label || '').trim();
        addDestination('owner_admin', adminWebhookUrl, { admin_user_id: user.owner_admin_id, brandLabel, username: brandLabel || 'The Shore Shack' });
    }

    if (!destinations.length) {
        return [{ scope: 'none', skipped: 'discord_webhook_not_configured' }];
    }

    for (const dest of destinations) {
        results.push({
            scope: dest.scope,
            ...(dest.admin_user_id ? { admin_user_id: dest.admin_user_id } : {}),
            ...(await sendDiscordWebhookToTarget({
                webhookUrl: dest.webhookUrl,
                order,
                userEmail,
                discordHandle,
                brandLabel: dest.brandLabel || '',
                username: dest.username || 'The Shore Shack'
            }))
        });
    }

    return results;
}

async function recordSuccessfulCheckout(payload) {
    const normalized = normalizeIncomingOrderPayload(payload);
    const externalOrderId = normalized.external_order_id;

    if (!externalOrderId) {
        throw new Error("external_order_id could not be determined");
    }

    // Prevent duplicates
    const { data: existing } = await maybeSingle("orders", (qb) =>
        qb.select("*").eq("external_order_id", externalOrderId).maybeSingle()
    );

    if (existing?.id) {
        return { order: existing, duplicate: true };
    }

    // Find user
    const user = await findUserForWebhook({ ...payload, ...normalized });
    if (!user?.id) {
        throw new Error("Could not match webhook payload to a user");
    }

    // Ensure credit balance
    await ensureUserCreditBalance(user.id);

    // Calculate credits
    const resolvedCost = await resolveOrderCreditCost({ ...payload, ...normalized });
    const creditsToCharge = asWholeCredits(resolvedCost.credits, 0);

    const currentBalance = await getUserCreditBalance(user.id);
    const insufficientCredits = creditsToCharge > currentBalance;

    // Create order
    const order = await createOrderRecord({
        ...payload,
        ...normalized,
        user_id: user.id,
        external_order_id: externalOrderId,
        status: insufficientCredits ? "insufficient_credits" : "success",
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

    // Charge credits
    if (creditsToCharge > 0 && !insufficientCredits) {
        balanceAfter = await adjustUserCredits({
            userId: user.id,
            delta: -creditsToCharge,
            reason: "successful_checkout",
            note: `Credits charged for checkout ${externalOrderId}`,
            orderId: order.id
        });
    }

    return {
        order,
        duplicate: false,
        credits_charged: creditsToCharge,
        balance_after: balanceAfter
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

            if (String(session.metadata?.checkout_type || "") === "storefront_purchase") {
                if (shopRoutes?.recordStorefrontSaleFromStripeSession) {
                    const saleResult = await shopRoutes.recordStorefrontSaleFromStripeSession(session);
                    console.log("Storefront Stripe sale processed:", saleResult);
                }
                if (session.metadata?.discount_code) {
                    const d = await getDiscount(session.metadata.discount_code);

                    if (d) {
                        await supabase
                            .from("discounts")
                            .update({
                                usage_count: d.usage_count + 1,
                                used_by: [...(d.used_by || []), session.customer_details?.email || ""]
                            })
                            .eq("code", session.metadata.discount_code);
                    }
                }
            }

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


app.post(["/webhooks/monitor", "/webhooks/monitor/:token"], async (req, res) => {
    const payload = req.body || {};
    const requestMeta = { path: req.originalUrl, hasToken: !!req.params.token, body: payload };

    try {
        console.log('📩 MONITOR WEBHOOK HIT', requestMeta);
        const token = String(req.params.token || req.query.token || '').trim();
        const expected = await getMonitorWebhookToken();
        if (expected && token !== expected) return res.status(401).json({ error: 'Invalid monitor webhook url' });

        const rawItems = extractMonitorItems(payload).map((item) => ({
            ...item,
            category: classifyMonitorType({ title: item.title, productType: item.productType, url: item.url }),
            url: buildProductUrl(item.site, item.sku, item.url, item.title, item.image)
        }));
        const items = await enrichMonitorItems(rawItems);
        const first = items[0] || {};
        const site = String(first.site || payload.site || payload.source || '').trim().toLowerCase();
        const dedupeWindowSeconds = await getMonitorDedupeWindowSeconds();
        const fingerprint = buildMonitorDedupeFingerprint(site, items);
        const claim = claimInboundWebhook(`monitor:${fingerprint}`, dedupeWindowSeconds);

        if (claim.duplicate) {
            const duplicate = await findRecentDuplicateMonitorLog(fingerprint, dedupeWindowSeconds);
            await appendWebhookLogEntry({
                type: 'monitor',
                status: 'duplicate_skipped',
                site,
                product_type: String(first.category || ''),
                product: String(first.title || first.url || ''),
                sku: String(first.sku || ''),
                error: `Skipped duplicate monitor webhook within ${dedupeWindowSeconds} seconds`,
                payload,
                fingerprint,
                parsed_items: items.map((item) => ({
                    title: item.title || '', sku: item.sku || '', site: item.site || '', price: item.price ?? null,
                    stock: item.stock ?? null, cartLimit: item.cartLimit ?? null, url: item.url || '', image: item.image || '', category: item.category || ''
                })),
                discord_targets: duplicate?.discord_targets || []
            }).catch(() => null);
            return res.status(204).end();
        }

        res.status(204).end();
        setImmediate(async () => {
            let logId = null;
            try {
                logId = (await appendWebhookLogEntry({
                    type: 'monitor',
                    status: 'received',
                    site,
                    product_type: String(first.category || ''),
                    product: String(first.title || first.url || ''),
                    sku: String(first.sku || ''),
                    payload,
                    fingerprint,
                    parsed_items: items.map((item) => ({
                        title: item.title || '', sku: item.sku || '', site: item.site || '', price: item.price ?? null,
                        stock: item.stock ?? null, cartLimit: item.cartLimit ?? null, url: item.url || '', image: item.image || '', category: item.category || ''
                    }))
                })).id;

                const globalSettings = await getAppSetting('webhook_settings', {});
                const superRows = await listDiscordWebhookRoutes({ scope: 'super_admin', webhookType: 'monitor' }).catch(() => []);
                const globalGroups = {};
                for (const row of superRows) globalGroups[row.category] = { webhook_url: row.webhook_url, ping_mode: row.ping_mode, role_mention: row.role_mention };
                if (!Object.keys(globalGroups).length) Object.assign(globalGroups, globalSettings?.monitor_groups || {});
                const adminMonitorConfigs = await getAllAdminMonitorGroupConfigs();
                const results = [];
                const usedTargets = [];

                for (const item of items) {
                    const targets = [];
                    const seenTargetUrls = new Set();
                    const superRoute = normalizeMonitorGroupConfig(globalGroups[item.category]);
                    const superUrl = String(superRoute.webhook_url || '').trim();
                    if (superUrl) {
                        targets.push({ scope: 'super_admin', user_id: null, route: superRoute });
                        seenTargetUrls.add(superUrl);
                    }
                    for (const adminConfig of adminMonitorConfigs) {
                        const route = normalizeMonitorGroupConfig(adminConfig.monitor_groups?.[item.category]);
                        const routeUrl = String(route.webhook_url || '').trim();
                        if (!routeUrl) continue;
                        if (adminConfig.role === 'super_admin') {
                            if (seenTargetUrls.has(routeUrl)) continue;
                            continue;
                        }
                        if (seenTargetUrls.has(routeUrl)) continue;
                        seenTargetUrls.add(routeUrl);
                        targets.push({ scope: 'admin', user_id: adminConfig.user_id, route });
                    }
                    if (!targets.length) {
                        results.push({ sku: item.sku, skipped: 'monitor_webhook_not_configured', category: item.category });
                        continue;
                    }
                    for (const target of targets) {
                        const url = String(target.route.webhook_url || '').trim();
                        usedTargets.push({ category: item.category, scope: target.scope, user_id: target.user_id, webhook_url: url.slice(0, 80), ping_mode: target.route.ping_mode || 'none', role_mention: target.route.role_mention || '' });
                        try {
                            const sendResult = await sendMonitorDiscordWebhook(target.route, item);
                            results.push({ sku: item.sku, category: item.category, scope: target.scope, user_id: target.user_id, success: true, attempt: sendResult?.attempt || 1, ping_mode: sendResult?.ping_mode || 'none', role_mention: sendResult?.role_mention || '' });
                        } catch (sendErr) {
                            results.push({ sku: item.sku, category: item.category, scope: target.scope, user_id: target.user_id, success: false, error: sendErr.message });
                        }
                    }
                }

                const failed = results.filter((r) => !r.success && !r.skipped);
                const skipped = results.filter((r) => r.skipped);

                await updateWebhookLogEntry(logId, {
                    status: failed.length ? 'failed' : 'processed',
                    product_type: String(first.category || ''),
                    product: String(first.title || first.url || ''),
                    sku: String(first.sku || ''),
                    error: failed.length ? failed.map((x) => `${x.sku || '-'}: ${x.error}`).join(' | ') : (skipped.length ? 'Some items skipped due to missing group webhook url' : ''),
                    parsed_items: items.map((item) => ({
                        title: item.title || '', sku: item.sku || '', site: item.site || '', price: item.price ?? null,
                        stock: item.stock ?? null, cartLimit: item.cartLimit ?? null, url: item.url || '', image: item.image || '', category: item.category || ''
                    })),
                    discord_targets: usedTargets,
                    fingerprint
                });
            } catch (err) {
                console.error('Monitor webhook processing failed:', err);
                if (logId) await updateWebhookLogEntry(logId, { status: 'failed', error: err.message || String(err), fingerprint }).catch(() => null);
                else await appendWebhookLogEntry({ type: 'monitor', status: 'failed', site, product_type: String(first.category || ''), product: String(first.title || first.url || ''), sku: String(first.sku || ''), error: err.message || String(err), payload, fingerprint }).catch(() => null);
            } finally {
                releaseInboundWebhook(`monitor:${fingerprint}`, dedupeWindowSeconds);
            }
        });
    } catch (err) {
        console.error('Monitor webhook setup failed:', err);
        return res.status(500).json({ error: err.message || String(err) });
    }
});

app.post(["/webhooks/orders", "/webhooks/orders/:token"], async (req, res) => {
    const payload = req.body || {};

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
        const normalized = normalizeIncomingOrderPayload(payload);
        const checkoutType = classifyCheckoutWebhookType({ raw_payload: payload, status: '' });
        const fingerprint = buildCheckoutDedupeFingerprint(payload);
        const dedupeWindowSeconds = 45;
        const claim = claimInboundWebhook(`checkout:${fingerprint}`, dedupeWindowSeconds);

        if (claim.duplicate) {
            const duplicateRow = await findRecentDuplicateCheckoutLog(fingerprint, dedupeWindowSeconds);
            await appendWebhookLogEntry({
                type: 'checkout',
                status: 'duplicate_skipped',
                site: String(normalized.site || payload.site || '').trim(),
                product_type: '',
                product: String(normalized.product_name || payload.product_name || ''),
                sku: String(normalized.sku || payload.sku || ''),
                payload,
                fingerprint,
                error: `Skipped duplicate checkout webhook within ${dedupeWindowSeconds} seconds`,
                discord_targets: duplicateRow?.discord_targets || []
            }).catch(() => null);
            return res.status(204).end();
        }

        res.status(204).end();
        setImmediate(async () => {
            let logId = null;
            try {
                logId = (await appendWebhookLogEntry({
                    type: 'checkout',
                    status: 'received',
                    site: String(normalized.site || payload.site || '').trim(),
                    product_type: '',
                    product: String(normalized.product_name || payload.product_name || ''),
                    sku: String(normalized.sku || payload.sku || ''),
                    payload,
                    fingerprint
                })).id;

                const matchedUser = await findUserForWebhook(payload).catch(() => null);
                const discordResults = await sendCheckoutDiscordNotificationsForPayload(payload, matchedUser, {
                    status: checkoutType === 'error' ? 'checkout_error' : 'processed'
                }).catch((err) => {
                    console.error('Checkout discord relay failed:', err);
                    return [{ success: false, error: err.message || String(err) }];
                });

                if (checkoutType === 'error') {
                    await updateWebhookLogEntry(logId, {
                        status: matchedUser?.id ? 'processed' : 'unmatched_user',
                        error: matchedUser?.id ? '' : 'Could not match webhook payload to a user',
                        discord_targets: Array.isArray(discordResults) ? discordResults : []
                    }).catch(() => null);
                    return;
                }

                const result = await recordSuccessfulCheckout(payload);
                let finalDiscordResults = discordResults;
                if (!matchedUser && result?.order && !result?.duplicate) {
                    const resolvedUser = await findUserForWebhook(payload).catch(() => null);
                    if (resolvedUser?.id) {
                        finalDiscordResults = await sendCheckoutDiscordNotifications(result.order, resolvedUser).catch((err) => {
                            console.error('Checkout discord relay after order processing failed:', err);
                            return discordResults;
                        });
                    }
                }

                const finalStatus = result?.duplicate ? 'duplicate_skipped' : (matchedUser?.id ? 'processed' : 'unmatched_user');
                const finalError = result?.duplicate ? 'Skipped duplicate checkout webhook by order id' : (matchedUser?.id ? '' : 'Could not match webhook payload to a user');
                await updateWebhookLogEntry(logId, { status: finalStatus, error: finalError, discord_targets: Array.isArray(finalDiscordResults) ? finalDiscordResults : [] }).catch(() => null);
                console.log("Inbound webhook processed successfully");
            } catch (err) {
                console.error("Inbound webhook error:", err);
                try {
                    const discordResults = await sendCheckoutDiscordNotificationsForPayload(payload, null, { status: 'checkout_error' });
                    if (logId) await updateWebhookLogEntry(logId, { status: 'unmatched_user', error: `${err.message || 'Could not match webhook payload to a user'}`, discord_targets: Array.isArray(discordResults) ? discordResults : [] }).catch(() => null);
                    else await appendWebhookLogEntry({ type: 'checkout', status: 'unmatched_user', site: String(normalized.site || payload.site || '').trim(), product: String(normalized.product_name || payload.product_name || ''), sku: String(normalized.sku || payload.sku || ''), error: `${err.message || 'Could not match webhook payload to a user'}`, payload, fingerprint, discord_targets: Array.isArray(discordResults) ? discordResults : [] }).catch(() => null);
                } catch (discordErr) {
                    console.error('Unmatched checkout discord relay failed:', discordErr);
                    if (logId) await updateWebhookLogEntry(logId, { status: 'unmatched_user', error: `${err.message || 'Could not match webhook payload to a user'} | Discord relay failed: ${discordErr.message || discordErr}` }).catch(() => null);
                }
            } finally {
                releaseInboundWebhook(`checkout:${fingerprint}`, dedupeWindowSeconds);
            }
        });
    } catch (err) {
        console.error('Inbound webhook setup error:', err);
        if (!res.headersSent) return res.status(500).json({ error: err.message });
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
        const monitorSettings = await getAppSetting('monitor_webhook_settings', {});
        const adminSettings = await getAdminWebhookSettings(currentUser.id);
        await migrateWebhookSettingsToSupabase({ currentUser, globalSettings, adminSettings }).catch(() => null);

        const superSuccess = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: 'checkout_success', category: 'all' }).catch(() => null);
        const superError = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: 'checkout_error', category: 'all' }).catch(() => null);
        const adminSuccess = currentUser.role === 'super_admin' ? null : await getWebhookRouteFromDb({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_success', category: 'all' }).catch(() => null);
        const adminError = currentUser.role === 'super_admin' ? null : await getWebhookRouteFromDb({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_error', category: 'all' }).catch(() => null);
        const superMonitorRows = currentUser.role === 'super_admin' ? await listDiscordWebhookRoutes({ scope: 'super_admin', webhookType: 'monitor' }).catch(() => []) : [];
        const adminMonitorRows = currentUser.role === 'super_admin' ? [] : await listDiscordWebhookRoutes({ scope: 'admin', userId: currentUser.id, webhookType: 'monitor' }).catch(() => []);
        const superMonitorGroups = {};
        for (const row of superMonitorRows) superMonitorGroups[row.category] = { webhook_url: row.webhook_url, ping_mode: row.ping_mode, role_mention: row.role_mention };
        const adminMonitorGroups = {};
        for (const row of adminMonitorRows) adminMonitorGroups[row.category] = { webhook_url: row.webhook_url, ping_mode: row.ping_mode, role_mention: row.role_mention };

        res.json({
            inbound_webhook_url: active?.token ? `${getApiBaseUrl(req)}/webhooks/orders/${active.token}` : '',
            monitor_webhook_url: monitorSettings?.token ? `${getApiBaseUrl(req)}/webhooks/monitor/${monitorSettings.token}` : '',
            discord_webhook_url: String(superSuccess?.webhook_url || globalSettings?.discord_webhook_url || ''),
            checkout_error_webhook_url: String(superError?.webhook_url || globalSettings?.checkout_error_webhook_url || ''),
            admin_discord_webhook_url: String(adminSuccess?.webhook_url || adminSettings?.discord_webhook_url || ''),
            admin_error_discord_webhook_url: String(adminError?.webhook_url || adminSettings?.checkout_error_webhook_url || ''),
            admin_brand_label: String(adminSettings?.brand_label || ''),
            monitor_groups: Object.keys(superMonitorGroups).length ? superMonitorGroups : (globalSettings?.monitor_groups || {}),
            admin_monitor_groups: Object.keys(adminMonitorGroups).length ? adminMonitorGroups : (adminSettings?.monitor_groups || {}),
            monitor_dedupe_window_seconds: Number(globalSettings?.monitor_dedupe_window_seconds || 90),
            can_create_inbound: currentUser.role === 'super_admin',
            is_super_admin: currentUser.role === 'super_admin'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.get('/admin/webhooks/logs', auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (currentUser.role !== 'super_admin') return res.status(403).json({ error: 'Only super admin can view webhook logs.' });
        const rows = await getWebhookLogEntries(200);
        res.json({ items: rows });
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
        const adminErrorDiscordWebhookUrl = String(req.body?.admin_error_discord_webhook_url || '').trim();
        const adminBrandLabel = String(req.body?.admin_brand_label || '').trim();

        if (currentUser.role !== 'super_admin') {
            await setAdminWebhookSettings(currentUser.id, {
                discord_webhook_url: adminDiscordWebhookUrl,
                checkout_error_webhook_url: adminErrorDiscordWebhookUrl,
                brand_label: adminBrandLabel,
                monitor_groups: req.body?.admin_monitor_groups || {}
            });
            await upsertDiscordWebhookRoute({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_success', category: 'all', webhookUrl: adminDiscordWebhookUrl, isActive: !!adminDiscordWebhookUrl });
            await upsertDiscordWebhookRoute({ scope: 'admin', userId: currentUser.id, webhookType: 'checkout_error', category: 'all', webhookUrl: adminErrorDiscordWebhookUrl, isActive: !!adminErrorDiscordWebhookUrl });
            for (const category of ['pokemon','onepiece','sports','othertcg','lowkey']) {
                const cfg = normalizeMonitorGroupConfig(req.body?.admin_monitor_groups?.[category]);
                await upsertDiscordWebhookRoute({ scope: 'admin', userId: currentUser.id, webhookType: 'monitor', category, webhookUrl: cfg.webhook_url, pingMode: cfg.ping_mode, roleMention: cfg.role_mention, isActive: !!cfg.webhook_url });
            }
        }

        const response = {
            success: true,
            admin_discord_webhook_url: currentUser.role === 'super_admin' ? '' : adminDiscordWebhookUrl,
            admin_error_discord_webhook_url: currentUser.role === 'super_admin' ? '' : adminErrorDiscordWebhookUrl,
            admin_brand_label: currentUser.role === 'super_admin' ? '' : adminBrandLabel
        };

        if (currentUser.role === 'super_admin') {
            const discordWebhookUrl = String(req.body?.discord_webhook_url || '').trim();
            const checkoutErrorWebhookUrl = String(req.body?.checkout_error_webhook_url || '').trim();
            const currentGlobal = await getAppSetting('webhook_settings', {});
            const monitorDedupeWindowSeconds = Math.max(0, Math.min(600, Number(req.body?.monitor_dedupe_window_seconds ?? currentGlobal.monitor_dedupe_window_seconds ?? 90) || 90));
            await setAppSetting('webhook_settings', {
                ...currentGlobal,
                discord_webhook_url: discordWebhookUrl,
                checkout_error_webhook_url: checkoutErrorWebhookUrl,
                monitor_groups: req.body?.monitor_groups || currentGlobal.monitor_groups || {},
                monitor_dedupe_window_seconds: monitorDedupeWindowSeconds
            });
            await upsertDiscordWebhookRoute({ scope: 'super_admin', webhookType: 'checkout_success', category: 'all', webhookUrl: discordWebhookUrl, isActive: !!discordWebhookUrl });
            await upsertDiscordWebhookRoute({ scope: 'super_admin', webhookType: 'checkout_error', category: 'all', webhookUrl: checkoutErrorWebhookUrl, isActive: !!checkoutErrorWebhookUrl });
            for (const category of ['pokemon','onepiece','sports','othertcg','lowkey']) {
                const cfg = normalizeMonitorGroupConfig(req.body?.monitor_groups?.[category]);
                await upsertDiscordWebhookRoute({ scope: 'super_admin', webhookType: 'monitor', category, webhookUrl: cfg.webhook_url, pingMode: cfg.ping_mode, roleMention: cfg.role_mention, isActive: !!cfg.webhook_url });
            }
            response.discord_webhook_url = discordWebhookUrl;
            response.checkout_error_webhook_url = checkoutErrorWebhookUrl;
            response.monitor_groups = req.body?.monitor_groups || {};
            response.monitor_dedupe_window_seconds = monitorDedupeWindowSeconds;
        }

        res.json(response);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/webhooks/monitor/create', auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (currentUser.role !== 'super_admin') return res.status(403).json({ error: 'Only super admin can create the shared monitor webhook.' });
        const webhook = await createMonitorWebhook(req, currentUser.id);
        res.json({ success: true, monitor_webhook_url: webhook.url });
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
            discord_user_id: normalizeDiscordUserId((await getUserSettings(user.id))?.discord_user_id || '')
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
                discord_user_id: normalizeDiscordUserId((await getUserSettings(user.id))?.discord_user_id || '')
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
            discord_user_id: normalizeDiscordUserId(settings?.discord_user_id || '')
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/user/settings", auth, async (req, res) => {
    try {
        const discordUserId = normalizeDiscordUserId(req.body?.discord_user_id || '');
        const updated = await setUserSettings(req.user_id, { discord_user_id: discordUserId });
        res.json({
            success: true,
            discord_user_id: normalizeDiscordUserId(updated?.discord_user_id || discordUserId)
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


function normalizeImportedProfilePayload(entry = {}, accountType = "walmart") {
    const shipping = entry.shipping || {};
    const billing = entry.billing || {};
    const payment = entry.payment || {};
    const digitsOnly = (value) => String(value || "").replace(/\D/g, "");
    const phone = digitsOnly(shipping.phone || billing.phone || "");
    return {
        profile_name: String(entry.name || entry.profile_name || entry.email || "Imported Profile").trim(),
        account_type: String(accountType || entry.account_type || 'walmart').trim().toLowerCase(),
        first_name: String(shipping.firstName || shipping.first_name || billing.firstName || "").trim(),
        last_name: String(shipping.lastName || shipping.last_name || billing.lastName || "").trim(),
        email: String(entry.email || shipping.email || billing.email || "").trim().toLowerCase(),
        phone: phone.slice(-10),
        address1: String(shipping.address1 || shipping.address_1 || billing.address1 || "").trim(),
        city: String(shipping.city || billing.city || "").trim(),
        state: String(shipping.province || shipping.state || billing.province || billing.state || "").trim(),
        zip: String(shipping.postalCode || shipping.zip || billing.postalCode || billing.zip || "").trim(),
        card: digitsOnly(payment.num || payment.card_number || ""),
        exp_month: String(payment.month || payment.exp_month || "").padStart(2, '0').slice(-2),
        exp_year: String(payment.year || payment.exp_year || "").slice(-4),
        cvv: digitsOnly(payment.cvv || ""),
        account_login_email: "",
        account_login_password: "",
        gmail_app_password: "",
        amazon_2fa_secret: "",
        imported_profile_id: String(entry.id || "").trim()
    };
}

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

app.post("/profiles/import", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);
        const accountType = String(req.body?.account_type || 'walmart').trim().toLowerCase();
        const rawProfiles = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
        if (!rawProfiles.length) {
            return res.status(400).json({ error: "No profiles were provided" });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const imported = [];
        const skipped = [];
        const errors = [];
        const seen = new Set();

        for (const entry of rawProfiles) {
            const payload = normalizeImportedProfilePayload(entry, accountType);
            const dedupeKey = [payload.account_type, payload.profile_name, payload.email, payload.phone, (payload.card || '').slice(-4)].join('|').toLowerCase();
            if (seen.has(dedupeKey)) {
                skipped.push({ profile_name: payload.profile_name, reason: 'Duplicate in upload' });
                continue;
            }
            seen.add(dedupeKey);

            if (!payload.profile_name || !payload.email) {
                skipped.push({ profile_name: payload.profile_name || entry?.name || 'Unknown', reason: 'Missing profile name or email' });
                continue;
            }

            if (!phoneRegex.test(payload.phone || "")) {
                skipped.push({ profile_name: payload.profile_name, reason: 'Phone must be 10 digits' });
                continue;
            }

            const duplicateError = findDuplicateInSameGroup(
                existingProfiles,
                null,
                payload.account_type,
                payload.profile_name,
                payload.email,
                payload.phone,
                (payload.card || '').slice(-4)
            );

            if (duplicateError) {
                skipped.push({ profile_name: payload.profile_name, reason: duplicateError });
                continue;
            }

            const { data: createdProfile, error: profileError } = await supabase
                .from("profiles")
                .insert({
                    user_id: req.user_id,
                    profile_name: payload.profile_name,
                    account_type: payload.account_type
                })
                .select()
                .single();

            if (profileError || !createdProfile) {
                errors.push({ profile_name: payload.profile_name, reason: profileError?.message || 'Profile creation failed' });
                continue;
            }

            try {
                await upsertProfileRelations(createdProfile.id, payload);
                imported.push({ id: createdProfile.id, profile_name: payload.profile_name });
                existingProfiles.push({
                    id: createdProfile.id,
                    profile_name: payload.profile_name,
                    account_type: payload.account_type,
                    addresses: [{ email: payload.email, phone: payload.phone }],
                    payments: [{ card_last4: (payload.card || '').slice(-4) }]
                });
            } catch (err) {
                errors.push({ profile_name: payload.profile_name, reason: err.message || 'Could not save profile relations' });
            }
        }

        res.json({
            success: true,
            imported_count: imported.length,
            skipped_count: skipped.length,
            error_count: errors.length,
            imported,
            skipped,
            errors
        });
    } catch (err) {
        const status = err.message === "This account has been revoked" ? 403 : 500;
        res.status(status).json({ error: err.message || 'Profile import failed' });
    }
});

app.delete("/profiles/bulk", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => String(id || '').trim()).filter(Boolean) : [];
        if (!ids.length) {
            return res.status(400).json({ error: 'No profile ids were provided' });
        }

        const { data: ownedProfiles, error: ownedError } = await supabase
            .from('profiles')
            .select('id')
            .eq('user_id', req.user_id)
            .in('id', ids);
        if (ownedError) {
            return res.status(500).json({ error: ownedError.message });
        }
        const ownedIds = (ownedProfiles || []).map((row) => row.id);
        if (!ownedIds.length) {
            return res.status(404).json({ error: 'No matching profiles found' });
        }

        await supabase.from('accounts').delete().in('profile_id', ownedIds);
        await supabase.from('payments').delete().in('profile_id', ownedIds);
        await supabase.from('addresses').delete().in('profile_id', ownedIds);
        const { error } = await supabase.from('profiles').delete().eq('user_id', req.user_id).in('id', ownedIds);
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        res.json({ success: true, deleted_count: ownedIds.length });
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



app.get("/admin/export/gmail-imap-txt", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { user_id, group } = req.query;
        const filename = (req.query.filename || "gmail-imap").replace(/[^a-zA-Z0-9-_]/g, "");

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
                const email = String(account.login_email || "").trim();
                const appPassOr2fa = String(account.gmail_app_password || account.amazon_2fa_secret || "").trim();

                if (!email && !appPassOr2fa) return null;

                return `Gmail;${email};${appPassOr2fa}`;
            })
            .filter(Boolean);

        const output = ["Gmail;email;app/2fapass", ...rows].join("\n");

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

shopRoutes = registerShopRoutes({
    app,
    supabase,
    stripe,
    auth,
    admin,
    getCurrentUser,
    buildAppUrl,
    sendEmail,
    SUPER_ADMIN_EMAIL,
    validateDiscountCode
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

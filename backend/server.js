
function parseMultiSkuValue(rawValue) {
    if (!rawValue) return [];

    return rawValue
        .split(/[\n,]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

function countEffectiveSkus(product) {
    if (!product) return 0;

    if (Array.isArray(product.multiSkus) && product.multiSkus.length) {
        return product.multiSkus.length;
    }

    if (typeof product.sku === 'string') {
        return parseMultiSkuValue(product.sku).length || 1;
    }

    return 1;
}


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
    // Refract profile exports can be much larger than Express's default 100kb JSON limit.
    // Keep Stellar unchanged, but allow larger profile-import payloads to reach /profiles/import.
    express.json({ limit: "10mb" })(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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

    const assignments = await loadProfileStoreAssignments(userId);
    const credentials = await loadProfileStoreCredentials((data || []).map((profile) => profile.id));
    return (data || []).map((profile) => ({
        ...profile,
        store_assignments: assignments?.get(String(profile.id)) || [normalizeProfileAccountType(profile.account_type || "general")],
        store_credentials: credentials.get(String(profile.id)) || {}
    }));
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
        if (currentProfileId && String(profile.id) === String(currentProfileId)) {
            continue;
        }

        if (profile.account_type !== group) {
            continue;
        }

        const existingProfileName = profile.profile_name || "";
        const existingEmail = profile.addresses?.[0]?.email || "";
        const existingPhone = profile.addresses?.[0]?.phone || "";
        const existingCardLast4 = profile.payments?.[0]?.card_last4 || "";

        if (group === "raffle") {
            // Raffle duplicate protection is email-only.
            // Do not block raffle creation for generated placeholder phone/card/profile data,
            // because those values are intentionally generated by the builder.
            if (email && existingEmail && existingEmail.toLowerCase() === String(email).toLowerCase()) {
                return "Email is already used in raffle profiles";
            }
            continue;
        }

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
        provider: normalizeProfileAccountType(payload.account_type || (payload.assigned_stores || [])[0] || "general"),
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

    await replaceProfileStoreCredentials(profileId, payload);
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


async function sendCreditDepletedNotifications({ user, previousBalance, newBalance, creditsCharged, order }) {
    const buyCreditsUrl = process.env.CREDIT_PURCHASE_URL || 'https://theshoreshacktcg.com/buy-credits';
    const userEmail = String(user?.email || '').trim();
    const orderRef = String(order?.external_order_id || order?.id || '').trim();

    const userSubject = 'Your Shore Shack credits have run out';
    const userText = [
        'Your Shore Shack checkout credit balance has reached 0 or below.',
        '',
        `Previous balance: ${previousBalance} credits`,
        `Credits charged: ${creditsCharged}`,
        `Current balance: ${newBalance} credits`,
        orderRef ? `Order: ${orderRef}` : '',
        '',
        'To continue using The Shore Shack checkout service, please purchase more credits:',
        buyCreditsUrl
    ].filter(Boolean).join('\n');

    const userHtml = `
        <p>Your Shore Shack checkout credit balance has reached <strong>0 or below</strong>.</p>
        <p>
            Previous balance: <strong>${previousBalance}</strong> credits<br>
            Credits charged: <strong>${creditsCharged}</strong><br>
            Current balance: <strong>${newBalance}</strong> credits
            ${orderRef ? `<br>Order: <strong>${orderRef}</strong>` : ''}
        </p>
        <p>To continue using The Shore Shack checkout service, please purchase more credits.</p>
        <p><a href="${buyCreditsUrl}">Buy more credits</a></p>
    `;

    if (userEmail) {
        try {
            await sendEmail({ to: userEmail, subject: userSubject, text: userText, html: userHtml });
        } catch (err) {
            console.error('Credit depleted user email failed:', err.message || err);
        }
    }

    try {
        await sendEmail({
            to: SUPER_ADMIN_EMAIL,
            subject: `User credits depleted: ${userEmail || user?.id || 'unknown user'}`,
            text: [
                'A user has reached 0 or negative credits.',
                '',
                `User: ${userEmail || user?.id || 'unknown'}`,
                `Previous balance: ${previousBalance}`,
                `Credits charged: ${creditsCharged}`,
                `Current balance: ${newBalance}`,
                orderRef ? `Order: ${orderRef}` : '',
                '',
                "Remove this user\'s accounts from active checkout runs until they purchase more credits."
            ].filter(Boolean).join('\n')
        });
    } catch (err) {
        console.error('Credit depleted admin email failed:', err.message || err);
    }
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

async function getProductCreditCost({ productId = null, site = "", sku = "", productName = "" }) {
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

    const cleanName = decodeHtmlEntities(String(productName || "")).trim();
    if (site && cleanName) {
        const tokens = cleanName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(/\s+/)
            .filter((token) => token.length >= 4)
            .slice(0, 5);
        let query = supabase
            .from("catalog_products")
            .select("id, credit_cost, site, sku, product_name")
            .eq("site", String(site).toLowerCase())
            .order("created_at", { ascending: false })
            .limit(25);
        if (tokens.length) {
            for (const token of tokens) query = query.ilike("product_name", `%${token}%`);
        } else {
            query = query.ilike("product_name", `%${cleanName.slice(0, 24)}%`);
        }
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const match = Array.isArray(data) ? data[0] : null;
        if (match?.id) return { credits: asWholeCredits(match.credit_cost, 0), product: match };
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

    const productMatch = await getProductCreditCost({ productId, site, sku, productName: payload.product_name || payload.product?.name || '' });
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
    return decodeHtmlEntities(String(value || ""))
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


function getFirstFieldValueByPrefix(fields = {}, prefix = '') {
    const wanted = String(prefix || '').trim().toLowerCase();
    if (!wanted) return '';
    if (fields[wanted]) return fields[wanted];
    const keys = Object.keys(fields || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const key of keys) {
        if (key === wanted || key.startsWith(`${wanted} `)) return fields[key];
    }
    return '';
}

function countIndexedFields(fields = {}, prefix = '') {
    const wanted = String(prefix || '').trim().toLowerCase();
    if (!wanted) return 0;
    const indexes = new Set();
    for (const key of Object.keys(fields || {})) {
        const match = key.match(new RegExp(`^${wanted}\\s+(\\d+)$`, 'i'));
        if (match) indexes.add(Number(match[1]));
    }
    return indexes.size;
}

function isPokemonCenterPayload(payload = {}, embed = {}, fields = {}) {
    const hay = [payload.username, embed.title, embed.description, embed.footer?.text, fields.site, payload.site]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return hay.includes('pokemoncenter') || hay.includes('pokemon center');
}

function isPokemonCenterModuleEvent(payload = {}) {
    const { embed, fields } = buildFieldMapFromEmbeds(payload || {});
    const title = decodeHtmlEntities(String(embed?.title || '')).toLowerCase();
    const description = decodeHtmlEntities(String(embed?.description || '')).toLowerCase();
    const site = decodeHtmlEntities(String(fields.site || payload.site || '')).toLowerCase();
    if (!site.includes('pokemon')) return false;
    return /module\s+(unlocked|locked)/i.test(`${title} ${description}`);
}

function isPokemonCenterLimitEvent(payload = {}) {
    const { embed, fields } = buildFieldMapFromEmbeds(payload || {});
    const title = decodeHtmlEntities(String(embed?.title || '')).toLowerCase();
    const description = decodeHtmlEntities(String(embed?.description || '')).toLowerCase();
    const site = decodeHtmlEntities(String(fields.site || payload.site || '')).toLowerCase();
    if (!site.includes('pokemon')) return false;
    return /task\s+limit\s+changed|limit\s+changed|changed\s+from\s+.*\s+to/i.test(`${title} ${description}`);
}

function isPokemonCenterStatusEvent(payload = {}) {
    return isPokemonCenterModuleEvent(payload) || isPokemonCenterLimitEvent(payload);
}

function pokemonStatusEventToMonitorItem(payload = {}) {
    const { embed, fields } = buildFieldMapFromEmbeds(payload || {});
    const title = decodeHtmlEntities(String(embed?.title || 'Pokemon Center Notification')).replace(/\*\*/g, '').trim() || 'Pokemon Center Notification';
    const description = decodeHtmlEntities(String(embed?.description || title)).replace(/\*\*/g, '').trim() || title;
    const isLimit = isPokemonCenterLimitEvent(payload);
    return {
        sku: isLimit ? 'limit-change' : 'module-status',
        title: description,
        price: '',
        url: 'https://www.pokemoncenter.com/',
        image: String(embed?.thumbnail?.url || embed?.image?.url || '').trim(),
        site: 'pokemon',
        category: 'pokemon',
        stock: null,
        cartLimit: fields.limit || null,
        isStatusEvent: true,
        statusEventType: isLimit ? 'limit_change' : 'module_status'
    };
}

function normalizeIncomingOrderPayload(payload = {}) {
    const { embed, fields } = buildFieldMapFromEmbeds(payload);
    const source = inferSourceFromPayload(payload, embed, fields);
    const site = inferSiteFromPayload(payload, embed, fields);
    const indexedProductValue = getFirstFieldValueByPrefix(fields, 'product');
    const indexedPriceValue = getFirstFieldValueByPrefix(fields, 'price');
    const productFieldRaw = payload.product_name || payload.product?.name || fields['product'] || fields['product name'] || indexedProductValue || embed.description || '';
    const productLink = extractMarkdownLink(payload.product_url || payload.url || fields['product'] || indexedProductValue || fields['share link'] || fields['input'] || '');
    const orderLink = extractMarkdownLink(fields['order id'] || fields['order number'] || payload.order_number || '');
    const productName = cleanFieldValue(productLink?.text || productFieldRaw || '');
    const orderNumber = cleanFieldValue(orderLink?.text || payload.order_number || fields['order id'] || fields['order number'] || '').replace(/^#/, '');
    const accountEmail = extractEmail(payload.user_email || payload.email || fields['account'] || fields['email'] || '');
    const profileName = cleanFieldValue(payload.profile_name || fields['profile'] || '');
    const sku = cleanFieldValue(payload.sku || payload.product_sku || fields['sku'] || '') || cleanFieldValue(productLink?.url || '').match(/(?:A-|ip\/seort\/|ip\/)(\d{6,})/)?.[1] || '';
    const indexedProductCount = countIndexedFields(fields, 'product');
    const quantityRaw = payload.quantity ?? fields['quantity'];
    const pokemonCenterPayload = isPokemonCenterPayload(payload, embed, fields);
    const quantity = pokemonCenterPayload && indexedProductCount > 0
        ? indexedProductCount
        : (Number.isFinite(Number(quantityRaw)) ? Math.max(1, Math.round(Number(quantityRaw))) : 1);
    const priceRaw = payload.price ?? fields['price'] ?? indexedPriceValue ?? fields['product price'];
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
    return String(value || '').trim().replace(/^<@!?/, '').replace(/>$/, '');
}

function formatDiscordDisplayName(user = {}) {
    const display = String(user.discord_display_name || user.discord_username || '').trim();
    const email = String(user.email || '').trim();
    return display ? `${display} (${email || user.id || ''})` : (email || user.id || '');
}

function getFrontendBaseUrl(req) {
    return String(process.env.FRONTEND_BASE_URL || process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function getDiscordRedirectUri(req) {
    return String(process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`);
}

function signDiscordOAuthState(payload = {}) {
    return jwt.sign({ ...payload, purpose: 'discord_oauth' }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function verifyDiscordOAuthState(value = '') {
    const decoded = jwt.verify(String(value || ''), process.env.JWT_SECRET);
    if (decoded?.purpose !== 'discord_oauth') throw new Error('Invalid Discord login state');
    return decoded;
}

function normalizeDiscordName(value = '') {
    return String(value || '').trim();
}

function buildDiscordDisplayNameFromApiUser(userJson = {}) {
    const globalName = normalizeDiscordName(userJson.global_name || userJson.display_name);
    const username = normalizeDiscordName(userJson.username || userJson.name);
    const discriminator = normalizeDiscordName(userJson.discriminator);
    if (globalName) return globalName;
    if (username && discriminator && discriminator !== '0') return `${username}#${discriminator}`;
    return username;
}

async function fetchDiscordOAuthUser({ code, redirectUri }) {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Discord OAuth is not configured. Add DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET.');

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: String(code || ''),
            redirect_uri: redirectUri
        })
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson.access_token) {
        throw new Error(tokenJson.error_description || tokenJson.error || 'Discord token exchange failed');
    }

    let userJson = {};
    const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` }
    });
    userJson = await userRes.json().catch(() => ({}));

    // Fallback for cases where Discord returns only part of the user object from /users/@me.
    // /oauth2/@me includes the authorized user and can restore username/global_name.
    if (userRes.ok && userJson.id && !buildDiscordDisplayNameFromApiUser(userJson)) {
        const meRes = await fetch('https://discord.com/api/oauth2/@me', {
            headers: { Authorization: `Bearer ${tokenJson.access_token}` }
        }).catch(() => null);
        if (meRes?.ok) {
            const meJson = await meRes.json().catch(() => ({}));
            if (meJson?.user?.id) userJson = { ...userJson, ...meJson.user };
        }
    }

    if (!userRes.ok || !userJson.id) {
        throw new Error(userJson.message || 'Could not read Discord user');
    }

    const discordId = normalizeDiscordUserId(userJson.id);
    const username = normalizeDiscordName(userJson.username || userJson.name);
    const displayName = buildDiscordDisplayNameFromApiUser(userJson) || (discordId ? `Discord user ${discordId}` : '');

    return {
        discord_user_id: discordId,
        discord_username: username || displayName || null,
        discord_display_name: displayName || username || null,
        discord_avatar: userJson.avatar ? `https://cdn.discordapp.com/avatars/${userJson.id}/${userJson.avatar}.png` : '',
        discord_email: String(userJson.email || '').trim().toLowerCase()
    };
}

async function upsertDiscordIdentityForUser(userId, discordUser) {
    if (!userId || !discordUser?.discord_user_id) throw new Error('Discord user id is required');
    const payload = {
        discord_user_id: discordUser.discord_user_id,
        discord_username: discordUser.discord_username || null,
        discord_display_name: discordUser.discord_display_name || null,
        discord_avatar: discordUser.discord_avatar || null,
        discord_email: discordUser.discord_email || null,
        discord_connected_at: new Date().toISOString()
    };
    const { error } = await supabase.from('users').update(payload).eq('id', userId);
    if (error) throw new Error(error.message);
    const existingSettings = await getUserSettings(userId).catch(() => ({}));
    await setUserSettings(userId, { ...existingSettings, ...payload });
    return payload;
}

async function getUserDiscordIdentity(user = {}) {
    const settings = await getUserSettings(user.id).catch(() => ({}));
    return {
        discord_user_id: normalizeDiscordUserId(user.discord_user_id || settings.discord_user_id || ''),
        discord_username: user.discord_username || settings.discord_username || '',
        discord_display_name: user.discord_display_name || settings.discord_display_name || '',
        discord_avatar: user.discord_avatar || settings.discord_avatar || '',
        discord_email: user.discord_email || settings.discord_email || '',
        discord_connected_at: user.discord_connected_at || settings.discord_connected_at || null
    };
}

async function notifyDiscordConnected(userId, discordUser = {}) {
    try {
        if (!userId) return { skipped: 'missing_user_id' };
        const { data: user, error } = await supabase
            .from('users')
            .select('id,email,role,owner_admin_id,discord_user_id,discord_username,discord_display_name,discord_email')
            .eq('id', userId)
            .single();
        if (error || !user) return { skipped: error?.message || 'user_not_found' };

        let scope = 'super_admin';
        let routeUserId = null;
        let webhookUrl = '';

        if (user.owner_admin_id) {
            scope = 'admin';
            routeUserId = user.owner_admin_id;
            const route = await getWebhookRouteFromDb({ scope: 'admin', userId: routeUserId, webhookType: 'checkout_success', category: 'all' }).catch(() => null);
            const settings = await getAdminWebhookSettings(routeUserId).catch(() => ({}));
            webhookUrl = String(route?.webhook_url || settings?.discord_webhook_url || '').trim();
        }

        if (!webhookUrl) {
            scope = 'super_admin';
            routeUserId = null;
            const globalSettings = await getAppSetting('webhook_settings', {});
            const route = await getWebhookRouteFromDb({ scope: 'super_admin', webhookType: 'checkout_success', category: 'all' }).catch(() => null);
            webhookUrl = String(route?.webhook_url || globalSettings?.discord_webhook_url || '').trim();
        }

        if (!webhookUrl) return { skipped: 'checkout_webhook_not_configured' };

        const identity = await getUserDiscordIdentity(user);
        const discordId = normalizeDiscordUserId(discordUser.discord_user_id || identity.discord_user_id || '');
        const discordName = String(discordUser.discord_display_name || identity.discord_display_name || discordUser.discord_username || identity.discord_username || '').trim();
        const mention = discordId ? `<@${discordId}>` : '';
        const email = String(user.email || '').trim();
        const embed = {
            title: 'Discord Connected',
            description: `${mention ? `${mention} ` : ''}${discordName || 'A Discord user'} connected Discord to The Shore Shack.`,
            fields: [
                { name: 'User', value: formatDiscordDisplayName({ ...user, ...identity }) || email || user.id, inline: false },
                { name: 'Email', value: email || '-', inline: true },
                { name: 'Discord', value: discordName || '-', inline: true },
                { name: 'Discord ID', value: discordId || '-', inline: true }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: scope === 'admin' ? 'Admin checkout webhook' : 'Super admin checkout webhook' }
        };

        return enqueueDiscordWebhookJob(webhookUrl, async () => {
            const response = await globalThis.fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: 'The Shore Shack',
                    content: mention || '',
                    allowed_mentions: { parse: ['users'] },
                    embeds: [embed]
                })
            });
            const text = response.ok ? '' : await response.text().catch(() => '');
            return { scope, user_id: routeUserId, success: response.ok, status: response.status, error: text };
        });
    } catch (err) {
        console.error('Discord connected notification failed:', err);
        return { success: false, error: err.message || String(err) };
    }
}

function createAuthToken(user) {
    return jwt.sign({ user_id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function formatDiscordMention(value = '', fallbackEmail = '') {
    const raw = String(value || '').trim();
    if (!raw) return maskEmail(fallbackEmail);
    if (/^<@!?\d{17,20}>$/.test(raw)) return raw;
    if (/^\d{17,20}$/.test(raw)) return `<@${raw}>`;
    return raw;
}

function getCheckoutBannerText(mentionText = '', brandLabel = '') {
    const brand = String(brandLabel || '').trim().toUpperCase();
    const mention = String(mentionText || '').trim() || 'THERE';
    return brand
        ? `THANK YOU ${mention} FOR CHECKING OUT WITH THE SHORE SHACK & ${brand}!!!`
        : `THANK YOU ${mention} FOR CHECKING OUT WITH THE SHORE SHACK!!!`;
}

const discordWebhookQueues = new Map();
const discordDeliveryInFlight = new Set();
const inboundWebhookInFlight = new Map();
const inboundWebhookRecent = new Map();

const webhookJobQueue = [];
let webhookJobRunnerActive = false;

function runWebhookJobQueue() {
    if (webhookJobRunnerActive) return;
    webhookJobRunnerActive = true;
    const drain = async () => {
        try {
            while (webhookJobQueue.length) {
                const job = webhookJobQueue.shift();
                if (typeof job !== 'function') continue;
                try {
                    await job();
                } catch (err) {
                    console.error('Webhook job failed:', err);
                }
            }
        } finally {
            webhookJobRunnerActive = false;
            if (webhookJobQueue.length) {
                setTimeout(runWebhookJobQueue, 0);
            }
        }
    };
    Promise.resolve().then(drain).catch((err) => {
        webhookJobRunnerActive = false;
        console.error('Webhook queue runner crashed:', err);
        if (webhookJobQueue.length) setTimeout(runWebhookJobQueue, 0);
    });
}

function enqueueWebhookJob(job) {
    if (typeof job !== 'function') throw new Error('Webhook job must be a function');
    webhookJobQueue.push(job);
    runWebhookJobQueue();
}


// =========================
// SUPABASE FAILSAFE WEBHOOK QUEUE
// =========================
const FAILSAFE_QUEUE_DIR = path.join(__dirname, 'webhook_failover_queue');
const FAILSAFE_REPLAY_INTERVAL_MS = Number(process.env.WEBHOOK_FAILSAFE_REPLAY_INTERVAL_MS || 60000);
const FAILSAFE_REPLAY_BATCH_SIZE = Number(process.env.WEBHOOK_FAILSAFE_REPLAY_BATCH_SIZE || 25);
const FAILSAFE_ALERT_TARGETS_FILE = path.join(FAILSAFE_QUEUE_DIR, 'database_outage_checkout_webhooks.json');
let outageAlertTargetsCache = [];
let lastOutageAlertTargetRefreshAt = 0;
let lastDatabaseOutageAlertAt = 0;
let lastDatabaseRecoveryAlertAt = 0;
let databaseWasDown = false;
let failsafeReplayRunning = false;

function ensureFailsafeQueueDir() {
    try {
        fs.mkdirSync(FAILSAFE_QUEUE_DIR, { recursive: true });
    } catch (err) {
        console.error('Failed to create webhook failover queue directory:', err);
    }
}

function isLikelyDatabaseError(err = {}) {
    const message = String(err?.message || err || '').toLowerCase();
    return !!(
        message.includes('supabase') ||
        message.includes('database') ||
        message.includes('postgres') ||
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('econn') ||
        message.includes('etimedout') ||
        message.includes('enotfound') ||
        message.includes('terminated') ||
        message.includes('connection') ||
        message.includes('pgrst')
    );
}

function readDatabaseOutageAlertTargetsCache() {
    ensureFailsafeQueueDir();
    try {
        const raw = fs.readFileSync(FAILSAFE_ALERT_TARGETS_FILE, 'utf8');
        const parsed = JSON.parse(raw || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((row) => ({
                scope: String(row.scope || '').trim(),
                user_id: row.user_id || null,
                webhook_type: String(row.webhook_type || '').trim(),
                webhook_url: String(row.webhook_url || '').trim()
            }))
            .filter((row) => row.webhook_url);
    } catch {
        return [];
    }
}

function writeDatabaseOutageAlertTargetsCache(targets = []) {
    ensureFailsafeQueueDir();
    const cleaned = [];
    const seenUrls = new Set();
    for (const target of Array.isArray(targets) ? targets : []) {
        const webhookUrl = String(target?.webhook_url || '').trim();
        if (!webhookUrl || seenUrls.has(webhookUrl)) continue;
        seenUrls.add(webhookUrl);
        cleaned.push({
            scope: String(target.scope || '').trim(),
            user_id: target.user_id || null,
            webhook_type: String(target.webhook_type || '').trim(),
            webhook_url: webhookUrl
        });
    }
    fs.writeFileSync(FAILSAFE_ALERT_TARGETS_FILE, JSON.stringify(cleaned, null, 2));
    outageAlertTargetsCache = cleaned;
    lastOutageAlertTargetRefreshAt = Date.now();
    return cleaned;
}

async function refreshDatabaseOutageAlertTargets({ force = false } = {}) {
    const now = Date.now();
    if (!force && outageAlertTargetsCache.length && now - lastOutageAlertTargetRefreshAt < 5 * 60 * 1000) {
        return outageAlertTargetsCache;
    }

    const { data, error } = await supabase
        .from('discord_webhook_routes')
        .select('*')
        .eq('is_active', true)
        .in('scope', ['super_admin', 'admin'])
        .in('webhook_type', ['checkout_error', 'checkout_success']);

    if (error) throw new Error(error.message);

    const rows = Array.isArray(data) ? data.map(normalizeDiscordWebhookRouteRow) : [];
    const byAccount = new Map();

    for (const row of rows) {
        const webhookUrl = String(row.webhook_url || '').trim();
        if (!webhookUrl) continue;
        const key = `${row.scope}:${row.user_id || SUPER_ADMIN_ROUTE_USER_ID}`;
        const existing = byAccount.get(key);
        const currentIsError = row.webhook_type === 'checkout_error';
        const existingIsError = existing?.webhook_type === 'checkout_error';

        // Prefer each account's checkout_error webhook. If it does not exist,
        // use checkout_success so the outage still reaches that account's checkout channel.
        if (!existing || (currentIsError && !existingIsError)) {
            byAccount.set(key, {
                scope: row.scope,
                user_id: row.user_id || null,
                webhook_type: row.webhook_type,
                webhook_url: webhookUrl
            });
        }
    }

    return writeDatabaseOutageAlertTargetsCache([...byAccount.values()]);
}

function buildDatabaseStatusAlertPayload(message, { recovered = false } = {}) {
    return {
        username: 'The Shore Shack',
        embeds: [{
            title: recovered ? '✅ Database Recovered' : '🚨 Database Outage Detected',
            description: String(message || ''),
            color: recovered ? 65280 : 16711680,
            fields: [
                {
                    name: 'Status',
                    value: recovered
                        ? 'Supabase is responding again. Queued webhooks will replay automatically.'
                        : 'The website database is temporarily unavailable. Incoming webhooks are being saved to the failover queue.',
                    inline: false
                },
                {
                    name: 'Action',
                    value: recovered
                        ? 'No action needed. Please verify queued checkout/monitor events replayed.'
                        : 'Customers may have trouble logging in or viewing account data until Supabase recovers.',
                    inline: false
                }
            ],
            timestamp: new Date().toISOString()
        }]
    };
}

async function sendDatabaseOutageAlert(message, { recovered = false } = {}) {
    const now = Date.now();
    const minGapMs = recovered ? 5 * 60 * 1000 : 15 * 60 * 1000;
    if (recovered) {
        if (now - lastDatabaseRecoveryAlertAt < minGapMs) return;
        lastDatabaseRecoveryAlertAt = now;
    } else {
        if (now - lastDatabaseOutageAlertAt < minGapMs) return;
        lastDatabaseOutageAlertAt = now;
    }

    let targets = outageAlertTargetsCache.length ? outageAlertTargetsCache : readDatabaseOutageAlertTargetsCache();

    // If Supabase is healthy/recovered, refresh the checkout alert target cache before notifying.
    // If Supabase is down, this will fail and the saved local cache will be used instead.
    if (recovered || !targets.length) {
        try {
            targets = await refreshDatabaseOutageAlertTargets({ force: true });
        } catch (refreshErr) {
            targets = targets.length ? targets : readDatabaseOutageAlertTargetsCache();
            console.warn('Using cached checkout webhook outage targets:', refreshErr.message || refreshErr);
        }
    }

    if (!targets.length) {
        console.warn('Database outage alert skipped because no cached checkout webhook routes are available yet.');
        return;
    }

    const payload = buildDatabaseStatusAlertPayload(message, { recovered });
    const results = [];

    for (const target of targets) {
        const webhookUrl = String(target.webhook_url || '').trim();
        if (!webhookUrl) continue;
        try {
            const response = await globalThis.fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const text = response.ok ? '' : await response.text().catch(() => '');
            results.push({ scope: target.scope, user_id: target.user_id, webhook_type: target.webhook_type, success: response.ok, status: response.status, error: text });
        } catch (alertErr) {
            results.push({ scope: target.scope, user_id: target.user_id, webhook_type: target.webhook_type, success: false, error: alertErr.message || String(alertErr) });
        }
    }

    const failed = results.filter((row) => !row.success);
    if (failed.length) {
        console.error('Some database outage checkout alerts failed:', failed);
    }
}

async function isSupabaseHealthy() {
    try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Supabase health check timeout')), 5000));
        const check = supabase.from('users').select('id').limit(1);
        const { error } = await Promise.race([check, timeout]);
        if (error) throw new Error(error.message);
        await refreshDatabaseOutageAlertTargets().catch((refreshErr) => console.warn('Could not refresh database outage alert target cache:', refreshErr.message || refreshErr));
        if (databaseWasDown) {
            databaseWasDown = false;
            await sendDatabaseOutageAlert('Supabase is responding again. Webhook failover queue replay will run automatically.', { recovered: true });
        }
        return true;
    } catch (err) {
        databaseWasDown = true;
        await sendDatabaseOutageAlert(`Supabase is not responding. Incoming webhooks will be saved to the local failover queue. Error: ${err.message || err}`);
        return false;
    }
}

async function queueWebhookForReplay({ type = 'unknown', token = '', originalUrl = '', payload = {}, reason = '' } = {}) {
    ensureFailsafeQueueDir();
    const id = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const row = {
        id,
        type,
        token: String(token || ''),
        originalUrl: String(originalUrl || ''),
        payload: payload || {},
        reason: String(reason || ''),
        created_at: new Date().toISOString(),
        attempts: 0,
        last_error: ''
    };
    const file = path.join(FAILSAFE_QUEUE_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(row, null, 2));
    console.warn(`Webhook saved to failover queue: ${file}`);
    return row;
}

function listQueuedWebhookFiles() {
    ensureFailsafeQueueDir();
    return fs.readdirSync(FAILSAFE_QUEUE_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(FAILSAFE_QUEUE_DIR, name))
        .sort();
}

async function replayQueuedWebhookFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const job = JSON.parse(raw);
    const type = String(job.type || '').toLowerCase();
    const token = encodeURIComponent(String(job.token || ''));
    const endpoint = type === 'monitor'
        ? `/webhooks/monitor/${token}`
        : `/webhooks/orders/${token}`;
    const url = `http://127.0.0.1:${PORT}${endpoint}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Failover-Replay': '1'
            },
            body: JSON.stringify(job.payload || {})
        });
        if (!response.ok && response.status !== 204) {
            throw new Error(`Replay POST failed with status ${response.status}`);
        }
        fs.unlinkSync(file);
        console.log(`Replayed queued webhook and removed ${path.basename(file)}`);
    } catch (err) {
        job.attempts = Number(job.attempts || 0) + 1;
        job.last_error = String(err.message || err);
        job.last_attempt_at = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(job, null, 2));
        throw err;
    }
}

async function replayWebhookFailoverQueue() {
    if (failsafeReplayRunning) return;
    failsafeReplayRunning = true;
    try {
        const files = listQueuedWebhookFiles().slice(0, FAILSAFE_REPLAY_BATCH_SIZE);
        if (!files.length) return;
        const healthy = await isSupabaseHealthy();
        if (!healthy) return;
        for (const file of files) {
            try {
                await replayQueuedWebhookFile(file);
            } catch (err) {
                console.error('Queued webhook replay failed:', err.message || err);
                break;
            }
        }
    } finally {
        failsafeReplayRunning = false;
    }
}

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


async function sendPokemonCenterStatusToMonitorRoutes(payload = {}, { superAdminOnly = false } = {}) {
    const item = pokemonStatusEventToMonitorItem(payload || {});
    const results = [];
    const usedTargets = [];
    const globalSettings = await getAppSetting('webhook_settings', {});
    const superRows = await listDiscordWebhookRoutes({ scope: 'super_admin', webhookType: 'monitor' }).catch(() => []);
    const globalGroups = {};
    for (const row of superRows) globalGroups[row.category] = { webhook_url: row.webhook_url, ping_mode: row.ping_mode, role_mention: row.role_mention };
    if (!Object.keys(globalGroups).length) Object.assign(globalGroups, globalSettings?.monitor_groups || {});
    const superRoute = normalizeMonitorGroupConfig(globalGroups.pokemon);
    if (String(superRoute.webhook_url || '').trim()) {
        usedTargets.push({ category: 'pokemon', scope: 'super_admin', user_id: null, webhook_url: String(superRoute.webhook_url).slice(0, 80), ping_mode: superRoute.ping_mode || 'none', role_mention: superRoute.role_mention || '' });
        try {
            const sendResult = await sendMonitorDiscordWebhook(superRoute, item);
            results.push({ sku: item.sku, category: 'pokemon', scope: 'super_admin', user_id: null, success: true, attempt: sendResult?.attempt || 1, ping_mode: sendResult?.ping_mode || 'none', role_mention: sendResult?.role_mention || '' });
        } catch (err) {
            results.push({ sku: item.sku, category: 'pokemon', scope: 'super_admin', user_id: null, success: false, error: err.message || String(err) });
        }
    } else {
        results.push({ sku: item.sku, category: 'pokemon', scope: 'super_admin', skipped: 'monitor_webhook_not_configured' });
    }

    if (!superAdminOnly) {
        const adminMonitorConfigs = await getAllAdminMonitorGroupConfigs().catch(() => []);
        const seen = new Set([String(superRoute.webhook_url || '').trim()].filter(Boolean));
        for (const adminConfig of adminMonitorConfigs) {
            const route = normalizeMonitorGroupConfig(adminConfig.monitor_groups?.pokemon);
            const url = String(route.webhook_url || '').trim();
            if (!url || seen.has(url)) continue;
            seen.add(url);
            usedTargets.push({ category: 'pokemon', scope: 'admin', user_id: adminConfig.user_id, webhook_url: url.slice(0, 80), ping_mode: route.ping_mode || 'none', role_mention: route.role_mention || '' });
            try {
                const sendResult = await sendMonitorDiscordWebhook(route, item);
                results.push({ sku: item.sku, category: 'pokemon', scope: 'admin', user_id: adminConfig.user_id, success: true, attempt: sendResult?.attempt || 1, ping_mode: sendResult?.ping_mode || 'none', role_mention: sendResult?.role_mention || '' });
            } catch (err) {
                results.push({ sku: item.sku, category: 'pokemon', scope: 'admin', user_id: adminConfig.user_id, success: false, error: err.message || String(err) });
            }
        }
    }
    return { item, results, usedTargets };
}

async function sendCheckoutDiscordNotificationsForPayload(payload = {}, matchedUser = null, extra = {}) {
    if (extra?.order && typeof extra.order === 'object') {
        return sendCheckoutDiscordNotifications(extra.order, matchedUser || null);
    }

    const normalized = normalizeIncomingOrderPayload(payload || {});
    const explicitCredits = extra?.credits_charged !== undefined && extra?.credits_charged !== null
        ? asWholeCredits(extra.credits_charged, 0)
        : 0;
    const pseudoOrder = {
        raw_payload: payload,
        status: extra.status || 'processed',
        site: normalized.site,
        source: normalized.source,
        credits_charged: explicitCredits,
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
            description: item.isStatusEvent ? 'Pokemon Center status notification' : 'Item restocked',
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

function spoilerDiscordValue(value = '') {
    const raw = String(value || '').trim();
    if (!raw || raw === '-') return '-';
    if (/^\|\|[\s\S]*\|\|$/.test(raw)) return raw;
    return `||${raw}||`;
}


function stripDiscordSpoilerValue(value = '') {
    return decodeHtmlEntities(String(value || '')).replace(/^\|\|/, '').replace(/\|\|$/, '').trim();
}

function extractCheckoutLineItems(payload = {}) {
    const { fields: rawFields } = extractEmbedFields(payload || {});
    const itemsByIndex = new Map();
    for (const [rawName, rawValue] of Object.entries(rawFields || {})) {
        const name = String(rawName || '').trim().toLowerCase();
        const value = stripDiscordSpoilerValue(rawValue);
        const match = name.match(/^(product|price|quantity)\s*\((\d+)\)$/i);
        if (!match) continue;
        const key = match[1].toLowerCase();
        const index = Number(match[2]);
        if (!Number.isFinite(index) || index < 1) continue;
        const current = itemsByIndex.get(index) || { index };
        if (key === 'product') current.product = value;
        if (key === 'price') {
            current.price = value;
            const priceNumber = Number(String(value).replace(/[^0-9.-]/g, ''));
            if (Number.isFinite(priceNumber)) current.priceNumber = priceNumber;
        }
        if (key === 'quantity') {
            current.quantity = value;
            const qtyNumber = Number(String(value).replace(/[^0-9.-]/g, ''));
            if (Number.isFinite(qtyNumber)) current.quantityNumber = Math.max(1, Math.round(qtyNumber));
        }
        itemsByIndex.set(index, current);
    }
    return Array.from(itemsByIndex.values())
        .sort((a, b) => a.index - b.index)
        .filter((item) => item.product || item.price || item.quantity)
        .map((item) => ({
            index: item.index,
            product: item.product || '-',
            price: item.price || '-',
            priceNumber: item.priceNumber,
            quantity: item.quantityNumber || item.quantity || 1
        }));
}

function formatCheckoutItemsForDiscord(items = []) {
    const lines = (Array.isArray(items) ? items : []).map((item) => {
        const qty = item.quantity || 1;
        const price = item.price && item.price !== '-' ? `$${String(item.price).replace(/^\$/, '')}` : '-';
        return `${item.index || ''}. ${item.product || '-'} — Qty ${qty} — ${price}`;
    }).filter(Boolean);
    const text = lines.join('\n');
    return text.length > 1000 ? `${text.slice(0, 997)}...` : (text || '-');
}


async function sendDiscordWebhookToTarget({
    webhookUrl,
    order,
    userEmail = '',
    discordHandle = '',
    brandLabel = '',
    username = 'The Shore Shack',
    includeSensitive = false
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
    const { fields: rawFields } = extractEmbedFields(payload);
    const fraudStatus = decodeHtmlEntities(String(rawFields['fraud status'] || payload.fraud_status || '')).trim();
    const proxyValue = decodeHtmlEntities(String(rawFields['proxy'] || payload.proxy || payload.proxy_used || '')).trim();

    const siteLabel = String(order.site || normalized.site || order.source || 'Bot');
    let title = '';
    let footerText = '';
    let description = '';

    if (checkoutType === 'error') {
        const { embed } = extractEmbedFields(payload);
        const rawTitle = decodeHtmlEntities(String(embed?.title || '')).replace(/\*\*/g, '').trim();
        const rawDesc = decodeHtmlEntities(String(embed?.description || '')).trim();
        title = `${rawTitle || 'Checkout Error'} • ${siteLabel}${fraudStatus ? ` • ${fraudStatus}` : ''}`;
        description = rawDesc || normalized.product_name || order.product_name || 'Checkout error received';
        footerText = decodeHtmlEntities(String(embed?.footer?.text || '')).trim() || 'Checkout error captured by The Shore Shack';
    } else {
        title = isInsufficient
            ? `Checkout Logged • Credits Needed`
            : `Successful Checkout • ${siteLabel}`;
        description = normalized.product_name || order.product_name || 'Checkout received';
        footerText = isInsufficient
            ? 'Order saved without charging credits'
            : 'Youve Been Served by The Shore Shack';
    }

    const checkoutItems = extractCheckoutLineItems(payload);
    const totalQuantity = checkoutItems.length
        ? checkoutItems.reduce((sum, item) => sum + (Number.isFinite(Number(item.quantity)) ? Math.max(1, Math.round(Number(item.quantity))) : 1), 0)
        : (Number(normalized.quantity) || 1);
    const totalPriceNumber = checkoutItems.reduce((sum, item) => {
        const price = Number(item.priceNumber);
        const qty = Number.isFinite(Number(item.quantity)) ? Math.max(1, Math.round(Number(item.quantity))) : 1;
        return Number.isFinite(price) ? sum + (price * qty) : sum;
    }, 0);
    const priceNumber = Number(normalized.price);
    const priceValue = checkoutItems.length > 1
        ? `$${totalPriceNumber.toFixed(2)} total`
        : (Number.isFinite(priceNumber) ? `$${priceNumber.toFixed(2)}` : '-');

    if (checkoutItems.length > 1 && checkoutItems[0]?.product) {
        description = `${checkoutItems[0].product} + ${checkoutItems.length - 1} more`;
    }

    const embed = {
        title,
        description,
        fields: [
            { name: 'Site', value: String(order.site || normalized.site || '-'), inline: true },
            { name: 'Source', value: String(order.source || normalized.source || '-'), inline: true },
            { name: checkoutItems.length > 1 ? 'Total Quantity' : 'Quantity', value: String(totalQuantity), inline: true },
            { name: checkoutItems.length > 1 ? 'Total Price' : 'Price', value: priceValue, inline: true }
        ],
        footer: { text: footerText },
        timestamp: new Date().toISOString()
    };

    if (checkoutItems.length > 1) {
        embed.fields.push({ name: 'Items', value: formatCheckoutItemsForDiscord(checkoutItems), inline: false });
    }

    if (checkoutType === 'success') {
        embed.fields.push({ name: 'Credits', value: String(order.credits_charged || 0), inline: true });
    }

    if (normalized.sku) {
        embed.fields.push({ name: 'SKU', value: spoilerDiscordValue(normalized.sku), inline: true });
    }
    if (includeSensitive && (normalized.order_number || normalized.external_order_id || order.external_order_id)) {
        embed.fields.push({ name: 'Order ID', value: spoilerDiscordValue(normalized.order_number || normalized.external_order_id || order.external_order_id), inline: true });
    }
    if (fraudStatus) {
        embed.fields.push({ name: 'Fraud Status', value: fraudStatus, inline: true });
    }
    const orderStatus = decodeHtmlEntities(String(rawFields['order status'] || payload.order_status || '')).trim();
    const statusDescription = decodeHtmlEntities(String(rawFields['status description'] || payload.status_description || '')).trim();
    const betaFlow = decodeHtmlEntities(String(rawFields['beta flow'] || payload.beta_flow || '')).trim();
    const shapeMethod = decodeHtmlEntities(String(rawFields['shape method'] || payload.shape_method || '')).trim();
    const accountValue = decodeHtmlEntities(String(rawFields['account'] || payload.account || normalized.account_email || '')).trim();
    const grandTotal = decodeHtmlEntities(String(rawFields['grand total'] || payload.grand_total || '')).trim();
    const astralVersion = decodeHtmlEntities(String(embed?.footer?.text || '')).trim();

    if (orderStatus) {
        embed.fields.push({ name: 'Order Status', value: orderStatus, inline: true });
    }

    if (statusDescription) {
        embed.fields.push({ name: 'Status Description', value: statusDescription, inline: true });
    }

    if (shapeMethod) {
        embed.fields.push({ name: 'Shape Method', value: shapeMethod, inline: true });
    }

    if (betaFlow) {
        embed.fields.push({ name: 'Beta Flow', value: betaFlow, inline: true });
    }

    if (accountValue) {
        embed.fields.push({ name: 'Account', value: spoilerDiscordValue(accountValue), inline: true });
    }

    if (grandTotal) {
        embed.fields.push({ name: 'Grand Total', value: spoilerDiscordValue(grandTotal), inline: true });
    }

    if (astralVersion) {
        embed.fields.push({ name: 'Astral Version', value: astralVersion, inline: false });
    }

    if (includeSensitive && proxyValue) {
        embed.fields.push({ name: 'Proxy', value: spoilerDiscordValue(proxyValue), inline: true });
    }
    const profileValue = normalized.profile_name || normalized.account_email || userEmail;
    if (profileValue) {
        embed.fields.push({ name: 'Profile', value: spoilerDiscordValue(profileValue), inline: true });
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
    if (isPokemonCenterStatusEvent(payload)) return 'error';
    const { embed } = extractEmbedFields(payload);
    const title = decodeHtmlEntities(String(embed?.title || '')).toLowerCase();
    const description = decodeHtmlEntities(String(embed?.description || '')).toLowerCase();
    const authorName = decodeHtmlEntities(String(embed?.author?.name || '')).toLowerCase();
    const hay = `${title} ${description} ${authorName}`;
    if (/relogin|required|action required|warning|login required|account locked|account disabled|account verification|captcha|checkout oos|failed|declined|error|canceled|cancelled|payment failed|out of stock/.test(hay)) return 'error';
    if (/successful checkout|success|confirmed|order confirmed/.test(hay)) return 'success';
    return String(order?.status || '').includes('insufficient') ? 'error' : 'success';
}


async function sendCheckoutDiscordNotifications(order, user) {
    const results = [];
    const userEmail = String(user?.email || '');
    const userSettings = user?.id ? await getUserSettings(user.id) : {};
    const discordHandle = normalizeDiscordUserId(user?.discord_user_id || userSettings?.discord_user_id || '');

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
                username: dest.username || 'The Shore Shack',
                includeSensitive: dest.scope === 'super_admin'
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
    const willBeZeroOrNegative = creditsToCharge > 0 && (currentBalance - creditsToCharge) <= 0;

    // Create order. Successful checkouts are always charged, even if the balance goes negative.
    const order = await createOrderRecord({
        ...payload,
        ...normalized,
        user_id: user.id,
        external_order_id: externalOrderId,
        status: "success",
        credits_charged: creditsToCharge,
        metadata: {
            ...(payload.metadata || {}),
            matched_user_email: user.email,
            requested_credits: creditsToCharge,
            previous_balance: currentBalance,
            projected_balance_after_charge: currentBalance - creditsToCharge,
            balance_went_zero_or_negative: willBeZeroOrNegative
        },
        raw_payload: payload
    });

    let balanceAfter = currentBalance;

    // Charge credits. This intentionally allows negative balances.
    if (creditsToCharge > 0) {
        balanceAfter = await adjustUserCredits({
            userId: user.id,
            delta: -creditsToCharge,
            reason: "successful_checkout",
            note: `Credits charged for checkout ${externalOrderId}`,
            metadata: {
                previous_balance: currentBalance,
                balance_after: currentBalance - creditsToCharge,
                allowed_negative_balance: true
            },
            orderId: order.id
        });

        if (willBeZeroOrNegative) {
            await sendCreditDepletedNotifications({
                user,
                previousBalance: currentBalance,
                newBalance: balanceAfter,
                creditsCharged: creditsToCharge,
                order
            });
        }
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


app.get('/api/health/database', async (req, res) => {
    const healthy = await isSupabaseHealthy();
    const queued = listQueuedWebhookFiles().length;
    res.status(healthy ? 200 : 503).json({
        ok: healthy,
        database: healthy ? 'online' : 'offline',
        queued_webhooks: queued
    });
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

        const processMonitorWebhook = async () => {
            let logId = null;
            try {
                if (!(await isSupabaseHealthy())) {
                    await queueWebhookForReplay({ type: 'monitor', token: String(req.params.token || req.query.token || ''), originalUrl: req.originalUrl, payload, reason: 'Supabase unavailable before monitor processing' });
                    return;
                }
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

                if (!items.length) {
                    const fallbackCategory = 'lowkey';
                    const superRoute = normalizeMonitorGroupConfig(globalGroups[fallbackCategory] || {});
                    const superUrl = String(superRoute.webhook_url || '').trim();
                    if (superUrl) {
                        usedTargets.push({ category: fallbackCategory, scope: 'super_admin', user_id: null, webhook_url: superUrl.slice(0, 80), ping_mode: superRoute.ping_mode || 'none', role_mention: superRoute.role_mention || '' });
                        try {
                            const embed = Array.isArray(payload?.embeds) ? payload.embeds[0] || {} : {};
                            const testItem = {
                                title: String(embed?.author?.name || embed?.title || 'Monitor Test'),
                                sku: '',
                                site: String((Array.isArray(embed?.fields) ? (embed.fields.find((f) => String(f?.name || '').toLowerCase() === 'site')?.value || '') : '') || payload.site || 'unknown').trim().toLowerCase(),
                                price: '',
                                stock: null,
                                cartLimit: null,
                                url: '',
                                image: String(embed?.thumbnail?.url || payload?.avatar_url || ''),
                                category: fallbackCategory
                            };
                            const sendResult = await sendMonitorDiscordWebhook(superRoute, testItem);
                            results.push({ sku: '', category: fallbackCategory, scope: 'super_admin', user_id: null, success: true, attempt: sendResult?.attempt || 1, ping_mode: sendResult?.ping_mode || 'none', role_mention: sendResult?.role_mention || '' });
                        } catch (sendErr) {
                            results.push({ sku: '', category: fallbackCategory, scope: 'super_admin', user_id: null, success: false, error: sendErr.message });
                        }
                    } else {
                        results.push({ sku: '', skipped: 'monitor_webhook_not_configured', category: fallbackCategory });
                    }
                }

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
        };

        enqueueWebhookJob(async () => {
            await processMonitorWebhook();
        });
        return res.status(204).end();
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

        const processCheckoutWebhook = async () => {
            let logId = null;
            let checkoutDiscordSent = false;
            try {
                if (!(await isSupabaseHealthy())) {
                    await queueWebhookForReplay({ type: 'checkout', token: String(req.params.token || req.query.token || ''), originalUrl: req.originalUrl, payload, reason: 'Supabase unavailable before checkout processing' });
                    return;
                }
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

                if (isPokemonCenterStatusEvent(payload)) {
                    const superAdminOnly = isPokemonCenterLimitEvent(payload);
                    const statusResult = await sendPokemonCenterStatusToMonitorRoutes(payload, { superAdminOnly });
                    const failed = statusResult.results.filter((r) => !r.success && !r.skipped);
                    await updateWebhookLogEntry(logId, {
                        type: 'monitor',
                        status: failed.length ? 'failed' : 'processed',
                        site: 'pokemon',
                        product_type: 'pokemon',
                        product: String(statusResult.item.title || ''),
                        sku: String(statusResult.item.sku || ''),
                        error: failed.length ? failed.map((x) => x.error).join(' | ') : '',
                        parsed_items: [{ title: statusResult.item.title || '', sku: statusResult.item.sku || '', site: 'pokemon', price: '', stock: null, cartLimit: statusResult.item.cartLimit ?? null, url: statusResult.item.url || '', image: statusResult.item.image || '', category: 'pokemon' }],
                        discord_targets: statusResult.usedTargets
                    }).catch(() => null);
                    return;
                }
                const matchedUser = await findUserForWebhook(payload).catch(() => null);
                let resolvedUser = matchedUser?.id ? matchedUser : null;
                let finalDiscordResults = [];
                let finalStatus = resolvedUser?.id ? 'processed' : 'unmatched_user';
                let finalError = resolvedUser?.id ? '' : 'Could not match webhook payload to a user';

                if (checkoutType === 'error') {
                    finalDiscordResults = await sendCheckoutDiscordNotificationsForPayload(payload, resolvedUser, {
                        status: 'checkout_error'
                    }).catch((err) => {
                        console.error('Checkout discord relay failed:', err);
                        return [{ success: false, error: err.message || String(err) }];
                    });
                    checkoutDiscordSent = true;
                    await updateWebhookLogEntry(logId, {
                        status: finalStatus,
                        error: finalError,
                        discord_targets: Array.isArray(finalDiscordResults) ? finalDiscordResults : []
                    }).catch(() => null);
                    return;
                }

                let recordedOrder = null;
                let recordedCreditsCharged = null;
                if (resolvedUser?.id) {
                    try {
                        const result = await recordSuccessfulCheckout(payload);
                        recordedOrder = result?.order || null;
                        recordedCreditsCharged = result?.order?.credits_charged ?? result?.credits_charged ?? null;
                        if (result?.duplicate) {
                            finalStatus = 'duplicate_skipped';
                            finalError = 'Skipped duplicate checkout webhook by order id';
                        }
                    } catch (recordErr) {
                        const message = recordErr?.message || String(recordErr);
                        if (/could not match webhook payload to a user/i.test(message)) {
                            resolvedUser = null;
                            finalStatus = 'unmatched_user';
                            finalError = 'Could not match webhook payload to a user';
                        } else if (/external_order_id could not be determined/i.test(message)) {
                            finalStatus = resolvedUser?.id ? 'processed' : 'unmatched_user';
                            finalError = resolvedUser?.id ? '' : 'Could not match webhook payload to a user';
                        } else {
                            throw recordErr;
                        }
                    }
                }

                finalDiscordResults = await sendCheckoutDiscordNotificationsForPayload(payload, resolvedUser, {
                    status: 'processed',
                    ...(recordedOrder ? { order: recordedOrder } : {}),
                    ...(recordedCreditsCharged !== null ? { credits_charged: recordedCreditsCharged } : {})
                }).catch((err) => {
                    console.error('Checkout discord relay failed:', err);
                    return [{ success: false, error: err.message || String(err) }];
                });
                checkoutDiscordSent = true;

                await updateWebhookLogEntry(logId, {
                    status: finalStatus,
                    error: finalError,
                    discord_targets: Array.isArray(finalDiscordResults) ? finalDiscordResults : []
                }).catch(() => null);
                console.log("Inbound webhook processed successfully");
            } catch (err) {
                console.error("Inbound webhook error:", err);
                try {
                    const relayStatus = checkoutType === 'error' ? 'checkout_error' : 'processed';
                    let discordResults = [];
                    if (!checkoutDiscordSent) {
                        const fallbackMatchedUser = await findUserForWebhook(payload).catch(() => null);
                        discordResults = await sendCheckoutDiscordNotificationsForPayload(payload, fallbackMatchedUser?.id ? fallbackMatchedUser : null, { status: relayStatus });
                        checkoutDiscordSent = true;
                    }
                    if (logId) await updateWebhookLogEntry(logId, { status: 'unmatched_user', error: `${err.message || 'Could not match webhook payload to a user'}`, discord_targets: Array.isArray(discordResults) ? discordResults : [] }).catch(() => null);
                    else await appendWebhookLogEntry({ type: 'checkout', status: 'unmatched_user', site: String(normalized.site || payload.site || '').trim(), product: String(normalized.product_name || payload.product_name || ''), sku: String(normalized.sku || payload.sku || ''), error: `${err.message || 'Could not match webhook payload to a user'}`, payload, fingerprint, discord_targets: Array.isArray(discordResults) ? discordResults : [] }).catch(() => null);
                } catch (discordErr) {
                    console.error('Unmatched checkout discord relay failed:', discordErr);
                    if (logId) await updateWebhookLogEntry(logId, { status: 'unmatched_user', error: `${err.message || 'Could not match webhook payload to a user'} | Discord relay failed: ${discordErr.message || discordErr}` }).catch(() => null);
                }
            } finally {
                releaseInboundWebhook(`checkout:${fingerprint}`, dedupeWindowSeconds);
            }
        };

        enqueueWebhookJob(async () => {
            await processCheckoutWebhook();
        });
        return res.status(204).end();
    } catch (err) {
        console.error('Inbound webhook setup error:', err);
        if (isLikelyDatabaseError(err)) {
            await queueWebhookForReplay({ type: 'checkout', token: String(req.params.token || req.query.token || ''), originalUrl: req.originalUrl, payload, reason: err.message || String(err) }).catch((queueErr) => console.error('Failed to queue checkout webhook after setup error:', queueErr));
            if (!res.headersSent) return res.status(204).end();
        }
        if (!res.headersSent) return res.status(500).json({ error: err.message });
    }
});

app.get("/admin/credits/users", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const scopedUserIds = await getScopeUserIdsForAdmin(currentUser);

        let query = supabase.from("users").select("id, email, role, owner_admin_id, created_at, discord_username, discord_display_name").order("created_at", { ascending: false });
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
                user_display: formatDiscordDisplayName(user),
                credits_balance: creditsBalance,
                lifetime_credits_granted: asWholeCredits(balance.lifetime_credits_granted, 0),
                lifetime_credits_spent: asWholeCredits(balance.lifetime_credits_spent, 0),
                insufficient_orders: insufficientCounts.get(user.id) || 0,
                needs_removal: creditsBalance <= 0
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
            user: { id: targetUser.id, email: targetUser.email, role: targetUser.role, discord_username: targetUser.discord_username || '', discord_display_name: targetUser.discord_display_name || '', user_display: formatDiscordDisplayName(targetUser) },
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



function parseTargetCheckoutSkuLines(rawValue = "") {
    const lines = String(rawValue || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const items = [];
    const errors = [];

    lines.forEach((line, index) => {
        const parts = line.split(";").map((part) => String(part || "").trim());
        if (parts.length < 3) {
            errors.push(`Line ${index + 1}: expected sku;name;price`);
            return;
        }

        const [sku, name, priceRaw] = parts;
        const cleanPrice = String(priceRaw || "").replace(/[^0-9.]/g, "");
        const price = cleanPrice === "" ? null : Number(cleanPrice);

        if (!sku) {
            errors.push(`Line ${index + 1}: SKU is required`);
            return;
        }
        if (!name) {
            errors.push(`Line ${index + 1}: name is required`);
            return;
        }
        if (price !== null && (!Number.isFinite(price) || price < 0)) {
            errors.push(`Line ${index + 1}: price must be blank or a valid number`);
            return;
        }

        items.push({
            sku,
            name,
            price: price === null ? null : Number(price.toFixed(2)),
            price_source: price === null ? "blank" : "input"
        });
    });

    return { items, errors };
}

async function ensureTargetCatalogForCheckoutLists() {
    let { data: activeCatalog, error: catalogError } = await supabase
        .from("product_catalogs")
        .select("id, site, name, export_date")
        .eq("site", "target")
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (catalogError) throw new Error(catalogError.message);

    if (!activeCatalog?.id) {
        const { data: createdCatalog, error: createCatalogError } = await supabase
            .from("product_catalogs")
            .insert({
                site: "target",
                name: "Target checkout list products",
                is_active: true,
                export_date: new Date().toISOString()
            })
            .select("id, site, name, export_date")
            .single();

        if (createCatalogError) throw new Error(createCatalogError.message);
        activeCatalog = createdCatalog;
    }

    return activeCatalog;
}

async function applyCatalogNamesToTargetCheckoutItems(items = []) {
    const normalizedItems = Array.isArray(items) ? items : [];
    const skus = [...new Set(normalizedItems.map((item) => String(item.sku || "").trim()).filter(Boolean))];

    if (!skus.length) return { items: normalizedItems, missing_skus: [], created_products: [] };

    try {
        const { data, error } = await supabase
            .from("catalog_products")
            .select("id, sku, product_name, site, default_max_price, credit_cost, created_at")
            .eq("site", "target")
            .in("sku", skus)
            .order("created_at", { ascending: false });

        if (error) throw new Error(error.message);

        const catalogBySku = new Map();
        (data || []).forEach((row) => {
            const key = String(row.sku || "").trim();
            if (key && !catalogBySku.has(key)) catalogBySku.set(key, row);
        });

        const missingItems = normalizedItems.filter((item) => !catalogBySku.has(String(item.sku || "").trim()));
        const missing_skus = missingItems.map((item) => String(item.sku || "").trim()).filter(Boolean);
        const created_products = [];

        if (missingItems.length) {
            const activeCatalog = await ensureTargetCatalogForCheckoutLists();
            const insertPayload = missingItems.map((item) => ({
                catalog_id: activeCatalog.id,
                site: "target",
                sku: String(item.sku || "").trim(),
                product_name: String(item.name || item.sku || "").trim(),
                brand: "Target",
                default_max_price: item.price === null || item.price === undefined ? null : Number(item.price),
                credit_cost: 0,
                release_mode_default: "current",
                is_enabled: true,
                metadata: {
                    source: "target_checkout_list",
                    needs_details: true,
                    note: "Created automatically from Target checkout list input. Please review product name, price, credits, image, and URL."
                }
            })).filter((row) => row.sku && row.product_name);

            if (insertPayload.length) {
                const { data: inserted, error: insertError } = await supabase
                    .from("catalog_products")
                    .insert(insertPayload)
                    .select("id, sku, product_name, site, default_max_price, credit_cost, created_at");

                if (insertError) throw new Error(insertError.message);

                (inserted || []).forEach((row) => {
                    created_products.push(row);
                    const key = String(row.sku || "").trim();
                    if (key && !catalogBySku.has(key)) catalogBySku.set(key, row);
                });
            }
        }

        const itemsWithCatalogData = normalizedItems.map((item) => {
            const sku = String(item.sku || "").trim();
            const catalog = catalogBySku.get(sku);
            const catalogPrice =
                catalog?.default_max_price === null || catalog?.default_max_price === undefined || catalog?.default_max_price === ""
                    ? null
                    : Number(catalog.default_max_price);
            const hasInputPrice = item.price !== null && item.price !== undefined && Number.isFinite(Number(item.price));
            const hasCatalogPrice = Number.isFinite(catalogPrice);

            return {
                ...item,
                name: String(catalog?.product_name || "").trim() || item.name,
                price: hasInputPrice ? Number(Number(item.price).toFixed(2)) : (hasCatalogPrice ? Number(catalogPrice.toFixed(2)) : null),
                price_source: hasInputPrice ? "input" : (hasCatalogPrice ? "catalog" : "none"),
                catalog_product_id: catalog?.id || null,
                needs_catalog_details: !catalog || !!(catalog.metadata && catalog.metadata.needs_details)
            };
        });

        return { items: itemsWithCatalogData, missing_skus, created_products };
    } catch (err) {
        console.warn("Could not apply Target catalog data to checkout list:", err.message);
        return { items: normalizedItems, missing_skus: [], created_products: [], warning: err.message };
    }
}

function normalizeTargetCheckoutLists(value) {
    const rawLists = Array.isArray(value) ? value : [];
    return rawLists.map((list) => ({
        id: String(list.id || `target-list-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        title: String(list.title || "Untitled List").trim() || "Untitled List",
        items: Array.isArray(list.items) ? list.items.slice(0, 29).map((item) => {
            const numericPrice = item.price === null || item.price === undefined || item.price === "" ? null : Number(item.price);
            return {
                sku: String(item.sku || "").trim(),
                name: String(item.name || "").trim(),
                price: Number.isFinite(numericPrice) ? Number(numericPrice.toFixed(2)) : null,
                price_source: item.price_source || (Number.isFinite(numericPrice) ? "input" : "none"),
                catalog_product_id: item.catalog_product_id || null,
                needs_catalog_details: !!item.needs_catalog_details
            };
        }).filter((item) => item.sku && item.name) : [],
        created_at: list.created_at || new Date().toISOString(),
        updated_at: list.updated_at || list.created_at || new Date().toISOString()
    })).filter((list) => list.items.length);
}

app.get('/target-checkout-lists', auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);
        const lists = normalizeTargetCheckoutLists(await getAppSetting('target_checkout_lists', []));
        const userSettings = await getAppSetting(`target_checkout_list_selections:${req.user_id}`, { selected_list_ids: [] });
        res.json({
            lists,
            selected_list_ids: Array.isArray(userSettings?.selected_list_ids) ? userSettings.selected_list_ids : []
        });
    } catch (err) {
        const status = err.message === 'This account has been revoked' ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
});

app.post('/target-checkout-lists/selections', auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);
        const lists = normalizeTargetCheckoutLists(await getAppSetting('target_checkout_lists', []));
        const allowed = new Set(lists.map((list) => String(list.id)));
        const selected = Array.isArray(req.body?.selected_list_ids) ? req.body.selected_list_ids.map(String).filter((id) => allowed.has(id)) : [];
        const saved = await setAppSetting(`target_checkout_list_selections:${req.user_id}`, {
            selected_list_ids: [...new Set(selected)],
            updated_at: new Date().toISOString()
        });
        res.json({ success: true, ...saved });
    } catch (err) {
        const status = err.message === 'This account has been revoked' ? 403 : 500;
        res.status(status).json({ error: err.message });
    }
});

app.get('/admin/target-checkout-lists', auth, admin, async (req, res) => {
    try {
        const lists = normalizeTargetCheckoutLists(await getAppSetting('target_checkout_lists', []));
        res.json({ lists });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/target-checkout-lists', auth, admin, async (req, res) => {
    try {
        const title = String(req.body?.title || '').trim();
        const rawSkuList = String(req.body?.sku_list || '').trim();
        if (!title) return res.status(400).json({ error: 'List title is required.' });

        const parsed = parseTargetCheckoutSkuLines(rawSkuList);
        if (parsed.errors.length) return res.status(400).json({ error: parsed.errors[0], errors: parsed.errors });
        if (!parsed.items.length) return res.status(400).json({ error: 'Add at least one SKU line.' });
        if (parsed.items.length > 29) return res.status(400).json({ error: 'Target checkout lists can only contain up to 29 SKUs.' });

        const current = normalizeTargetCheckoutLists(await getAppSetting('target_checkout_lists', []));
        const catalogResult = await applyCatalogNamesToTargetCheckoutItems(parsed.items);
        const catalogNamedItems = catalogResult.items || parsed.items;
        const now = new Date().toISOString();
        const id = String(req.body?.id || `target-list-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const existing = current.find((list) => list.id === id);
        const nextList = {
            id,
            title,
            items: catalogNamedItems,
            created_at: existing?.created_at || now,
            updated_at: now
        };
        const next = [nextList, ...current.filter((list) => list.id !== id)];
        await setAppSetting('target_checkout_lists', next);
        res.json({
            success: true,
            list: nextList,
            lists: next,
            missing_skus: catalogResult.missing_skus || [],
            created_products: catalogResult.created_products || [],
            warning: catalogResult.warning || null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/admin/target-checkout-lists/:id', auth, admin, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const current = normalizeTargetCheckoutLists(await getAppSetting('target_checkout_lists', []));
        const next = current.filter((list) => list.id !== id);
        await setAppSetting('target_checkout_lists', next);
        res.json({ success: true, deleted: current.length - next.length, lists: next });
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



app.post('/admin/webhooks/logs/:id/resend', auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        if (currentUser.role !== 'super_admin') return res.status(403).json({ error: 'Only super admin can resend webhook logs.' });
        const rows = await getWebhookLogEntries(500);
        const row = rows.find((item) => String(item.id) === String(req.params.id));
        if (!row) return res.status(404).json({ error: 'Webhook log not found.' });
        if (!row.payload) return res.status(400).json({ error: 'This log does not have a raw payload to resend.' });
        if (String(row.type || '') !== 'checkout') return res.status(400).json({ error: 'Only checkout webhook logs can be resent to checkout Discord webhooks.' });

        const matchedUser = await findUserForWebhook(row.payload).catch(() => null);
        const checkoutType = classifyCheckoutWebhookType({ raw_payload: row.payload, status: '' });
        const results = await sendCheckoutDiscordNotificationsForPayload(row.payload, matchedUser?.id ? matchedUser : null, {
            status: checkoutType === 'error' ? 'checkout_error' : 'processed'
        });
        await updateWebhookLogEntry(row.id, {
            discord_targets: Array.isArray(results) ? results : [],
            error: Array.isArray(results) && results.some((r) => r && r.success === false)
                ? results.filter((r) => r && r.success === false).map((r) => r.error || 'Discord resend failed').join(' | ')
                : String(row.error || '')
        }).catch(() => null);
        res.json({ ok: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
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

app.get('/auth/discord/start', async (req, res) => {
    try {
        const clientId = process.env.DISCORD_CLIENT_ID;
        if (!clientId) return res.status(500).send('Discord OAuth is not configured. Missing DISCORD_CLIENT_ID.');
        const mode = ['login', 'signup', 'connect'].includes(String(req.query.mode || 'login')) ? String(req.query.mode || 'login') : 'login';
        const inviteCode = String(req.query.invite_code || '').trim();
        let userId = null;
        if (mode === 'connect') {
            const rawToken = String(req.query.token || '').trim();
            if (!rawToken) return res.status(401).send('Missing session token.');
            const decoded = jwt.verify(rawToken, process.env.JWT_SECRET);
            userId = decoded.user_id;
        }
        const state = signDiscordOAuthState({ mode, invite_code: inviteCode, user_id: userId });
        const authUrl = new URL('https://discord.com/oauth2/authorize');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', getDiscordRedirectUri(req));
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('scope', 'identify email');
        authUrl.searchParams.set('state', state);
        return res.redirect(authUrl.toString());
    } catch (err) {
        return res.status(500).send(err.message || 'Could not start Discord login.');
    }
});

app.get('/auth/discord/callback', async (req, res) => {
    const frontendBase = getFrontendBaseUrl(req);
    try {
        const code = String(req.query.code || '').trim();
        const state = verifyDiscordOAuthState(req.query.state || '');
        if (!code) throw new Error('Discord did not return an authorization code.');
        const discordUser = await fetchDiscordOAuthUser({ code, redirectUri: getDiscordRedirectUri(req) });

        if (state.mode === 'connect') {
            await upsertDiscordIdentityForUser(state.user_id, discordUser);
            await notifyDiscordConnected(state.user_id, discordUser).catch(() => null);
            return res.redirect(`${frontendBase}/dashboard.html?discord_connected=1`);
        }

        let user = null;
        const { data: discordMatches, error: discordMatchError } = await supabase
            .from('users')
            .select('*')
            .eq('discord_user_id', discordUser.discord_user_id)
            .limit(1);
        if (discordMatchError && !String(discordMatchError.message || '').includes('column')) throw new Error(discordMatchError.message);
        if (discordMatches?.length) user = discordMatches[0];

        if (!user && discordUser.discord_email) {
            const { data: emailUser } = await supabase
                .from('users')
                .select('*')
                .ilike('email', discordUser.discord_email)
                .maybeSingle();
            if (emailUser) user = emailUser;
        }

        if (!user && state.mode === 'signup') {
            const inviteCode = String(state.invite_code || '').trim();
            if (!inviteCode) throw new Error('Invite code is required for Discord signup.');
            const { data: invite, error: inviteError } = await supabase
                .from('invite_codes')
                .select('*')
                .eq('code', inviteCode)
                .eq('used', false)
                .eq('canceled', false)
                .single();
            if (inviteError || !invite) throw new Error('Invalid invite code');
            const inviteRole = invite.invite_role || 'user';
            const email = discordUser.discord_email || `${discordUser.discord_user_id}@discord.local`;
            const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
            const { data: createdUser, error: createError } = await supabase
                .from('users')
                .insert({
                    email,
                    password_hash: hash,
                    role: inviteRole,
                    revoked: false,
                    owner_admin_id: inviteRole === 'user' ? invite.created_by_admin_id || null : null,
                    discord_user_id: discordUser.discord_user_id,
                    discord_username: discordUser.discord_username || null,
                    discord_display_name: discordUser.discord_display_name || null,
                    discord_avatar: discordUser.discord_avatar || null,
                    discord_email: discordUser.discord_email || null,
                    discord_connected_at: new Date().toISOString()
                })
                .select()
                .single();
            if (createError) throw new Error(createError.message);
            await supabase.from('invite_codes').update({ used: true, used_by: createdUser.id }).eq('id', invite.id);
            await ensureUserCreditBalance(createdUser.id).catch(() => null);
            user = createdUser;
        }

        if (!user) {
            throw new Error('No account is linked to this Discord user yet. Sign up with an invite code or log in by email and connect Discord from Discord Settings.');
        }

        if (user.revoked) throw new Error('This account has been revoked');
        const wasAlreadyConnected = !!normalizeDiscordUserId(user.discord_user_id || '');
        await upsertDiscordIdentityForUser(user.id, discordUser);
        if (!wasAlreadyConnected) await notifyDiscordConnected(user.id, discordUser).catch(() => null);
        const token = createAuthToken(user);
        return res.redirect(`${frontendBase}/dashboard.html?token=${encodeURIComponent(token)}&discord_login=1`);
    } catch (err) {
        return res.redirect(`${frontendBase}/login.html?error=${encodeURIComponent(err.message || 'Discord login failed')}`);
    }
});

app.post('/auth/discord/disconnect', auth, async (req, res) => {
    try {
        await supabase.from('users').update({
            discord_user_id: null,
            discord_username: null,
            discord_display_name: null,
            discord_avatar: null,
            discord_email: null,
            discord_connected_at: null
        }).eq('id', req.user_id);
        const settings = await getUserSettings(req.user_id).catch(() => ({}));
        delete settings.discord_user_id;
        delete settings.discord_username;
        delete settings.discord_display_name;
        delete settings.discord_avatar;
        delete settings.discord_email;
        delete settings.discord_connected_at;
        await setUserSettings(req.user_id, settings);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        .ilike("email", String(email || "").trim())
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

    const token = createAuthToken(user);

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
            discord_user_id: normalizeDiscordUserId(user.discord_user_id || (await getUserSettings(user.id))?.discord_user_id || ''),
            discord_username: user.discord_username || '',
            discord_display_name: user.discord_display_name || '',
            discord_avatar: user.discord_avatar || ''
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
                discord_user_id: normalizeDiscordUserId(user.discord_user_id || (await getUserSettings(user.id))?.discord_user_id || ''),
            discord_username: user.discord_username || '',
            discord_display_name: user.discord_display_name || '',
            discord_avatar: user.discord_avatar || ''
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/user/settings", auth, async (req, res) => {
    try {
        const settings = await getUserSettings(req.user_id);
        const user = req.currentUser || await getCurrentUser(req);
        res.json({
            discord_user_id: normalizeDiscordUserId(user.discord_user_id || settings?.discord_user_id || ''),
            discord_username: user.discord_username || settings?.discord_username || '',
            discord_display_name: user.discord_display_name || settings?.discord_display_name || '',
            discord_avatar: user.discord_avatar || settings?.discord_avatar || '',
            discord_connected: !!(user.discord_user_id || settings?.discord_user_id)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/user/settings", auth, async (req, res) => {
    try {
        const discordUserId = normalizeDiscordUserId(req.body?.discord_user_id || '');
        const existingSettings = await getUserSettings(req.user_id).catch(() => ({}));
        const updated = await setUserSettings(req.user_id, { ...existingSettings, discord_user_id: discordUserId });
        await supabase.from('users').update({ discord_user_id: discordUserId || null }).eq('id', req.user_id);
        if (discordUserId) await notifyDiscordConnected(req.user_id, { discord_user_id: discordUserId }).catch(() => null);
        res.json({
            success: true,
            discord_user_id: normalizeDiscordUserId(updated?.discord_user_id || discordUserId)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/user/activity", auth, async (req, res) => {
    try {
        const currentUser = req.currentUser || await getCurrentUser(req);
        const [balanceRow, txRows, orderRows] = await Promise.all([
            ensureUserCreditBalance(currentUser.id),
            (async () => {
                const { data, error } = await maybeMany("credit_transactions", (qb) =>
                    qb.select("*").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(250)
                );
                if (error) throw new Error(error.message);
                return data || [];
            })(),
            (async () => {
                const { data, error } = await maybeMany("orders", (qb) =>
                    qb.select("*").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(250)
                );
                if (error) throw new Error(error.message);
                return data || [];
            })()
        ]);

        res.json({
            user: { id: currentUser.id, email: currentUser.email, role: currentUser.role },
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
    const valueFrom = (...values) => values.map((value) => String(value || "").trim()).find(Boolean) || "";
    const normalizeYear = (value) => {
        const raw = digitsOnly(value);
        if (!raw) return "";
        if (raw.length === 2) return `20${raw}`;
        return raw.slice(-4);
    };

    // Refract exports use: name, shipping.address1/province/postalCode, payment.num/month/year/cvv.
    // Stellar exports use: profileName, shipping.address/state/zipcode, payment.cardNumber/cardMonth/cardYear/cardCvv.
    const email = valueFrom(entry.email, shipping.email, billing.email).toLowerCase();
    const phone = digitsOnly(valueFrom(entry.phone, shipping.phone, billing.phone));
    const card = digitsOnly(valueFrom(payment.num, payment.card_number, payment.cardNumber));

    return {
        profile_name: valueFrom(entry.name, entry.profileName, entry.profile_name, email, "Imported Profile"),
        account_type: normalizeProfileAccountType(accountType || entry.account_type || entry.store || 'walmart'),
        first_name: valueFrom(shipping.firstName, shipping.first_name, billing.firstName, billing.first_name),
        last_name: valueFrom(shipping.lastName, shipping.last_name, billing.lastName, billing.last_name),
        email,
        phone: phone.slice(-10),
        address1: valueFrom(shipping.address1, shipping.address_1, shipping.address, billing.address1, billing.address_1, billing.address),
        city: valueFrom(shipping.city, billing.city),
        state: valueFrom(shipping.province, shipping.state, billing.province, billing.state),
        zip: valueFrom(shipping.postalCode, shipping.zip, shipping.zipcode, billing.postalCode, billing.zip, billing.zipcode),
        card,
        exp_month: valueFrom(payment.month, payment.exp_month, payment.cardMonth).padStart(2, '0').slice(-2),
        exp_year: normalizeYear(valueFrom(payment.year, payment.exp_year, payment.cardYear)),
        cvv: digitsOnly(valueFrom(payment.cvv, payment.cardCvv, payment.card_cvv)),
        account_login_email: email,
        account_login_password: valueFrom(entry.password, entry.account_password, entry.login_password),
        gmail_app_password: valueFrom(entry.gmail_app_password, entry.app_password, entry.imap_password),
        amazon_2fa_secret: valueFrom(entry.amazon_2fa_secret, entry.two_fa_secret, entry.totp_secret),
        imported_profile_id: String(entry.id || "").trim()
    };
}


const PROFILE_ACCOUNT_TYPES = new Set(["general", "walmart", "target", "samsclub", "amazon", "crunchyroll", "pokemoncenter", "raffle"]);

function normalizeProfileAccountType(value = "general") {
    const raw = String(value || "general").trim().toLowerCase();
    const type = raw.replace(/[\s_'’-]+/g, "");

    if (["samsclub", "samclub", "sams", "sam'sclub"].includes(type)) {
        return "samsclub";
    }
    if (["pokemoncenter", "pokemon", "pokecenter", "pc"].includes(type)) {
        return "pokemoncenter";
    }
    if (["crunchyroll", "crunchy", "cr"].includes(type)) {
        return "crunchyroll";
    }

    return PROFILE_ACCOUNT_TYPES.has(type) ? type : "general";
}


const STORE_RUN_STATUS_SITES = ["target", "walmart", "samsclub", "amazon", "general", "crunchyroll", "pokemoncenter"];
const STORE_RUN_STATUS_LABELS = {
    target: "Target",
    walmart: "Walmart",
    samsclub: "Sam's Club",
    amazon: "Amazon",
    general: "General",
    crunchyroll: "Crunchyroll",
    pokemoncenter: "Pokémon Center"
};

function normalizeStoreRunSite(value = "") {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw || raw === "all" || raw === "allstores" || raw === "all_stores") return "";
    const site = normalizeProfileAccountType(raw);
    return STORE_RUN_STATUS_SITES.includes(site) ? site : "";
}

async function loadStoreRunStatusForUsers(userIds = []) {
    const cleanIds = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const map = new Map();
    cleanIds.forEach((id) => {
        map.set(id, Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, false])));
    });
    if (!cleanIds.length) return map;
    const { data, error } = await supabase
        .from("user_store_run_status")
        .select("user_id, site, is_enabled, updated_at")
        .in("user_id", cleanIds);
    if (error) throw error;
    (data || []).forEach((row) => {
        const id = String(row.user_id || '');
        const site = normalizeStoreRunSite(row.site);
        if (!id || !site) return;
        const current = map.get(id) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((key) => [key, false]));
        current[site] = !!row.is_enabled;
        current[`${site}_updated_at`] = row.updated_at || null;
        map.set(id, current);
    });
    return map;
}

function normalizeAssignedStores(value, fallback = "general") {
    const raw = Array.isArray(value) ? value : String(value || "").split(/[;,\s]+/);
    const stores = raw
        .map((item) => normalizeProfileAccountType(item))
        .filter((store) => store && store !== "raffle");

    if (!stores.length) {
        const fallbackStore = normalizeProfileAccountType(fallback || "general");
        return fallbackStore === "raffle" ? ["general"] : [fallbackStore];
    }

    return [...new Set(stores)];
}

function profileAssignedStores(profile = {}) {
    if (Array.isArray(profile.store_assignments) && profile.store_assignments.length) {
        return profile.store_assignments.map(normalizeProfileAccountType);
    }
    if (Array.isArray(profile.profile_store_assignments) && profile.profile_store_assignments.length) {
        return profile.profile_store_assignments.map((row) => normalizeProfileAccountType(row.store));
    }
    return [normalizeProfileAccountType(profile.account_type || "general")];
}

async function loadProfileStoreAssignments(userId) {
    try {
        const { data, error } = await supabase
            .from("profile_store_assignments")
            .select("profile_id, store")
            .eq("user_id", userId);

        if (error) throw error;

        const map = new Map();
        (data || []).forEach((row) => {
            const id = String(row.profile_id || "");
            const store = normalizeProfileAccountType(row.store);
            if (!id || store === "raffle") return;
            if (!map.has(id)) map.set(id, []);
            map.get(id).push(store);
        });
        return map;
    } catch (err) {
        // Migration may not be installed yet. Existing account_type behavior still works.
        return null;
    }
}

async function replaceProfileStoreAssignments(userId, profileId, stores) {
    const cleanStores = normalizeAssignedStores(stores);
    try {
        await supabase.from("profile_store_assignments").delete().eq("profile_id", profileId);
        const rows = cleanStores.map((store) => ({ user_id: userId, profile_id: profileId, store }));
        const { error } = await supabase.from("profile_store_assignments").insert(rows);
        if (error) throw error;
    } catch (err) {
        // If the migration is not installed, keep the primary account_type fallback working.
    }
}

function normalizeStoreCredentialsPayload(payload = {}) {
    const raw = payload.store_credentials && typeof payload.store_credentials === 'object' ? payload.store_credentials : {};
    const stores = normalizeAssignedStores(payload.assigned_stores, payload.account_type);
    const out = {};
    const imapStores = new Set(['target', 'walmart', 'samsclub']);
    const sharedGmailAppPassword = String(payload.gmail_app_password || '').trim()
        || Object.values(raw).map((item) => String(item?.gmail_app_password || '').trim()).find(Boolean)
        || '';

    stores.forEach((store) => {
        const item = raw[store] || {};
        const isImapStore = imapStores.has(store);
        out[store] = {
            store,
            login_email: String(item.login_email || '').trim() || String(payload.account_login_email || payload.email || '').trim(),
            login_password: String(item.login_password || '').trim() || String(payload.account_login_password || '').trim(),
            gmail_app_password: String(item.gmail_app_password || '').trim() || (isImapStore ? sharedGmailAppPassword : String(payload.gmail_app_password || '').trim()),
            amazon_2fa_secret: String(item.amazon_2fa_secret || item.two_fa_secret || '').trim() || String(payload.amazon_2fa_secret || '').trim()
        };
    });

    return out;
}

async function loadProfileStoreCredentials(profileIds = []) {
    const ids = [...new Set((profileIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const map = new Map();
    if (!ids.length) return map;

    try {
        const { data, error } = await supabase
            .from('profile_store_credentials')
            .select('*')
            .in('profile_id', ids);
        if (error) throw error;

        (data || []).forEach((row) => {
            const profileId = String(row.profile_id || '');
            const store = normalizeProfileAccountType(row.store);
            if (!profileId || !store) return;
            if (!map.has(profileId)) map.set(profileId, {});
            map.get(profileId)[store] = row;
        });
    } catch (_) {
        // Migration may not be installed yet; accounts table fallback still works.
    }
    return map;
}

async function replaceProfileStoreCredentials(profileId, payload = {}) {
    const credentials = normalizeStoreCredentialsPayload(payload);
    try {
        await supabase.from('profile_store_credentials').delete().eq('profile_id', profileId);
        const rows = Object.entries(credentials)
            .filter(([, c]) => c.login_email || c.login_password || c.gmail_app_password || c.amazon_2fa_secret)
            .map(([store, c]) => ({
                profile_id: profileId,
                store,
                login_email: c.login_email || null,
                login_password: c.login_password || null,
                gmail_app_password: c.gmail_app_password || null,
                amazon_2fa_secret: c.amazon_2fa_secret || null
            }));
        if (rows.length) {
            const { error } = await supabase.from('profile_store_credentials').insert(rows);
            if (error) throw error;
        }
    } catch (_) {
        // If migration is not installed yet, the primary accounts row still saves below.
    }
}

function accountForExport(profile = {}, group = '') {
    const cleanGroup = normalizeProfileAccountType(group || profile.account_type || 'general');
    if (profile.store_credentials && profile.store_credentials[cleanGroup]) {
        return profile.store_credentials[cleanGroup];
    }
    const accounts = Array.isArray(profile.accounts) ? profile.accounts : [];
    return accounts.find((acct) => normalizeProfileAccountType(acct.provider || '') === cleanGroup) || accounts[0] || {};
}

async function enforceProfileAssignmentLimits({ userId, role, stores, excludeProfileId = null }) {
    const cleanStores = normalizeAssignedStores(stores);
    if (role === "super_admin") return;

    const existingProfiles = await getUserProfilesWithRelations(userId);

    for (const store of cleanStores) {
        if (store === "raffle") continue;
        const limit = getProfileLimitForRole(role, store);
        if (!Number.isFinite(limit)) continue;

        const currentCount = existingProfiles.filter((profile) => {
            if (excludeProfileId && String(profile.id) === String(excludeProfileId)) return false;
            return profileAssignedStores(profile).includes(store);
        }).length;

        if (currentCount + 1 > limit) {
            throw new Error(`Profile limit reached for ${store}. Your account can have up to ${limit} ${store} profile${limit === 1 ? "" : "s"}.`);
        }
    }
}

function findDuplicateAcrossAssignedStores(profiles, currentProfileId, stores, profileName, email, phone, cardLast4) {
    const cleanStores = normalizeAssignedStores(stores);
    for (const store of cleanStores) {
        const duplicateError = findDuplicateInSameGroup(
            profiles.map((profile) => ({ ...profile, account_type: profileAssignedStores(profile).includes(store) ? store : profile.account_type })),
            currentProfileId,
            store,
            profileName,
            email,
            phone,
            cardLast4
        );
        if (duplicateError) return `${duplicateError} (${store})`;
    }
    return null;
}

async function attachAndFilterProfilesByStore(profiles, group = "") {
    const items = Array.isArray(profiles) ? profiles : [];
    const users = [...new Set(items.map((profile) => profile.user_id).filter(Boolean))];
    const assignmentMaps = new Map();

    for (const userId of users) {
        assignmentMaps.set(String(userId), await loadProfileStoreAssignments(userId));
    }

    const credentialMap = await loadProfileStoreCredentials(items.map((profile) => profile.id));
    const attached = items.map((profile) => {
        const map = assignmentMaps.get(String(profile.user_id));
        const credentialStores = Object.keys(credentialMap.get(String(profile.id)) || {}).map(normalizeProfileAccountType);
        const accountStores = (Array.isArray(profile.accounts) ? profile.accounts : [])
            .map((account) => normalizeProfileAccountType(account.provider || account.account_type || ''))
            .filter((store) => store && store !== 'raffle');
        const baseStores = map?.get(String(profile.id)) || [normalizeProfileAccountType(profile.account_type || "general")];
        const storeAssignments = [...new Set([...baseStores, ...credentialStores, ...accountStores].filter((store) => store && store !== 'raffle'))];
        return {
            ...profile,
            store_assignments: storeAssignments.length ? storeAssignments : [normalizeProfileAccountType(profile.account_type || "general")],
            store_credentials: credentialMap.get(String(profile.id)) || {}
        };
    });

    if (!group) return attached;

    const cleanGroup = normalizeProfileAccountType(group);
    return attached.filter((profile) => profileAssignedStores(profile).includes(cleanGroup));
}

async function filterProfilesByActiveRunStatus(profiles, group = "", activeOnly = false) {
    const cleanGroup = normalizeStoreRunSite(group || "");
    const items = Array.isArray(profiles) ? profiles : [];
    if (!activeOnly) return items;
    if (!cleanGroup) return [];

    const userIds = [...new Set(items.map((profile) => profile.user_id).filter(Boolean))];
    const statusMap = await loadStoreRunStatusForUsers(userIds);
    return items.filter((profile) => {
        const status = statusMap.get(String(profile.user_id)) || {};
        return !!status[cleanGroup];
    });
}

function getProfileLimitForRole(role = "user", accountType = "general") {
    const type = normalizeProfileAccountType(accountType);
    if (role === "super_admin") return Infinity;
    if (type === "raffle") return Infinity;

    const adminLimits = { target: 8, samsclub: 6, amazon: 2, general: 5, walmart: 100, crunchyroll: 10, pokemoncenter: 10 };
    const userLimits = { target: 4, samsclub: 4, amazon: 2, general: 3, walmart: 100, crunchyroll: 4, pokemoncenter: 5 };

    const source = role === "admin" ? adminLimits : userLimits;
    return source[type] ?? 0;
}

async function enforceProfileLimit({ userId, role, accountType, excludeProfileId = null, addCount = 1 }) {
    const type = normalizeProfileAccountType(accountType);
    const limit = getProfileLimitForRole(role, type);
    if (!Number.isFinite(limit)) return;

    let query = supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("account_type", type);

    if (excludeProfileId) {
        query = query.neq("id", excludeProfileId);
    }

    const { count, error } = await query;
    if (error) throw new Error(error.message);

    const currentCount = Number(count || 0);
    const requested = Math.max(1, Number(addCount || 1));
    if (currentCount + requested > limit) {
        throw new Error(`Profile limit reached for ${type}. Your account can have up to ${limit} ${type} profile${limit === 1 ? "" : "s"}.`);
    }
}

function parseRaffleEmails(value = "") {
    return String(value || "")
        .split(/[;\n,\s]+/)
        .map((email) => String(email || "").trim().toLowerCase())
        .filter(Boolean)
        .filter((email, index, arr) => arr.indexOf(email) === index);
}

function isValidEmailForRaffle(value = "") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

const RAFFLE_FIRST_NAMES = [
    "Avery", "Blake", "Cameron", "Drew", "Elliot", "Finley", "Harper", "Jordan",
    "Kennedy", "Logan", "Morgan", "Parker", "Quinn", "Reese", "Riley", "Rowan",
    "Sawyer", "Taylor", "Tatum", "Wesley", "Casey", "Dakota", "Emerson", "Skyler"
];

const RAFFLE_LAST_NAMES = [
    "Adams", "Bennett", "Brooks", "Carter", "Coleman", "Davis", "Edwards", "Foster",
    "Grayson", "Hayes", "Howard", "Jenkins", "Kelly", "Lawson", "Miller", "Morgan",
    "Nelson", "Parker", "Reed", "Sanders", "Thompson", "Walker", "Wilson", "Young"
];

const ZIP_LOCATION_OVERRIDES = {
    "27909": { city: "Elizabeth City", state: "North Carolina" },
    "27916": { city: "Aydlett", state: "North Carolina" },
    "27917": { city: "Barco", state: "North Carolina" },
    "27921": { city: "Camden", state: "North Carolina" },
    "27929": { city: "Currituck", state: "North Carolina" },
    "27939": { city: "Grandy", state: "North Carolina" },
    "27947": { city: "Jarvisburg", state: "North Carolina" },
    "27950": { city: "Knotts Island", state: "North Carolina" },
    "27958": { city: "Moyock", state: "North Carolina" },
    "27966": { city: "Powells Point", state: "North Carolina" },
    "27973": { city: "Shawboro", state: "North Carolina" }
};

function inferStateFromZip(zip = "") {
    const first = String(zip || "").trim()[0] || "";
    const map = {
        "0": "Massachusetts",
        "1": "New York",
        "2": "North Carolina",
        "3": "Georgia",
        "4": "Ohio",
        "5": "Minnesota",
        "6": "Illinois",
        "7": "Texas",
        "8": "Colorado",
        "9": "California"
    };
    return map[first] || "North Carolina";
}

async function resolveZipLocation(zip = "") {
    const cleanZip = String(zip || "").trim().slice(0, 5);
    if (ZIP_LOCATION_OVERRIDES[cleanZip]) return ZIP_LOCATION_OVERRIDES[cleanZip];

    try {
        if (typeof fetch === "function" && /^\d{5}$/.test(cleanZip)) {
            const response = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(cleanZip)}`, {
                signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined
            });
            if (response.ok) {
                const data = await response.json();
                const place = Array.isArray(data.places) ? data.places[0] : null;
                if (place) {
                    return {
                        city: place["place name"] || "Raffle City",
                        state: place["state"] || inferStateFromZip(cleanZip)
                    };
                }
            }
        }
    } catch (_) { }

    return { city: "Raffle City", state: inferStateFromZip(cleanZip) };
}

function randomRaffleName(index = 0) {
    const i = Math.abs(Number(index || 0));
    return {
        firstName: RAFFLE_FIRST_NAMES[i % RAFFLE_FIRST_NAMES.length],
        lastName: RAFFLE_LAST_NAMES[(i * 7 + 3) % RAFFLE_LAST_NAMES.length]
    };
}

function generateRafflePhone(index = 0) {
    const suffix = String(1000000 + (Number(index || 0) % 8999999)).slice(-7);
    return `555${suffix}`;
}

function generateInvalidPlaceholderCard(index = 0) {
    // Looks like a 16-digit card number, but intentionally fails the Luhn checksum.
    // Do not use for real payments.
    const base = `411111111111${String(Number(index || 0) % 1000).padStart(3, '0')}`;
    const digits = base.slice(0, 15);
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
        let n = Number(digits[digits.length - 1 - i]);
        if (i % 2 === 0) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
    }
    const validCheckDigit = (10 - (sum % 10)) % 10;
    const invalidCheckDigit = (validCheckDigit + 1) % 10;
    return `${digits}${invalidCheckDigit}`;
}

function buildRafflePayload(email, zip, index = 0, zipLocation = {}) {
    const { firstName, lastName } = randomRaffleName(index);

    return {
        profile_name: `Raffle ${index + 1} - ${email}`,
        account_type: "raffle",
        first_name: firstName,
        last_name: lastName,
        email,
        phone: generateRafflePhone(index),
        address1: `${100 + index} ${lastName} Street`,
        city: zipLocation.city || "Raffle City",
        state: zipLocation.state || inferStateFromZip(zip),
        zip: String(zip || "").trim(),
        card: generateInvalidPlaceholderCard(index),
        exp_month: "01",
        exp_year: "2099",
        cvv: "000",
        account_login_email: "",
        account_login_password: "",
        gmail_app_password: "",
        amazon_2fa_secret: ""
    };
}


app.get("/store-run-status", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);
        const statusMap = await loadStoreRunStatusForUsers([req.user_id]);
        const status = statusMap.get(String(req.user_id)) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, false]));
        res.json({
            stores: STORE_RUN_STATUS_SITES.map((site) => ({
                site,
                label: STORE_RUN_STATUS_LABELS[site] || site,
                is_enabled: !!status[site],
                updated_at: status[`${site}_updated_at`] || null
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message || "Could not load store run status" });
    }
});

app.put("/store-run-status", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);
        const site = normalizeStoreRunSite(req.body?.site);
        if (!site) return res.status(400).json({ error: "Invalid store" });
        const isEnabled = !!req.body?.is_enabled;
        const now = new Date().toISOString();
        const { error } = await supabase
            .from("user_store_run_status")
            .upsert({ user_id: req.user_id, site, is_enabled: isEnabled, updated_at: now }, { onConflict: "user_id,site" });
        if (error) return res.status(500).json({ error: error.message });
        res.json({ success: true, site, label: STORE_RUN_STATUS_LABELS[site] || site, is_enabled: isEnabled, updated_at: now });
    } catch (err) {
        res.status(500).json({ error: err.message || "Could not update store run status" });
    }
});

app.get("/admin/store-run-status", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const siteFilter = normalizeStoreRunSite(req.query.site || "");
        const userFilter = String(req.query.user_id || "").trim();

        let usersQuery = supabase
            .from("users")
            .select("id, email, role, owner_admin_id, discord_username, discord_display_name, discord_user_id")
            .order("email", { ascending: true });

        if (currentUser.role !== "super_admin") {
            usersQuery = usersQuery.eq("owner_admin_id", currentUser.id);
        }
        if (userFilter) {
            usersQuery = usersQuery.eq("id", userFilter);
        }

        const { data: users, error: usersError } = await usersQuery;
        if (usersError) return res.status(500).json({ error: usersError.message });

        const userIds = (users || []).map((u) => u.id);
        const statusMap = await loadStoreRunStatusForUsers(userIds);

        let assignmentRows = [];
        if (userIds.length) {
            const { data: rawProfiles, error: profilesError } = await supabase
                .from("profiles")
                .select("id, user_id, account_type, created_at")
                .in("user_id", userIds);
            if (profilesError) return res.status(500).json({ error: profilesError.message });

            const profilesById = new Map((rawProfiles || []).map((profile) => [String(profile.id), profile]));
            const storeSetsByProfileId = new Map();
            const addStoreForProfile = (profileId, store) => {
                const id = String(profileId || "");
                const cleanStore = normalizeProfileAccountType(store);
                if (!id || !cleanStore || cleanStore === "raffle" || !STORE_RUN_STATUS_SITES.includes(cleanStore)) return;
                if (!storeSetsByProfileId.has(id)) storeSetsByProfileId.set(id, new Set());
                storeSetsByProfileId.get(id).add(cleanStore);
            };

            (rawProfiles || []).forEach((profile) => {
                addStoreForProfile(profile.id, profile.account_type || "general");
            });

            try {
                const { data: assignmentData, error: assignmentError } = await supabase
                    .from("profile_store_assignments")
                    .select("profile_id, user_id, store")
                    .in("user_id", userIds);
                if (!assignmentError) {
                    (assignmentData || []).forEach((row) => addStoreForProfile(row.profile_id, row.store));
                }
            } catch (_) {
                // Older deployments may not have profile_store_assignments yet.
            }

            try {
                const { data: credentialData, error: credentialError } = await supabase
                    .from("profile_store_credentials")
                    .select("profile_id, store")
                    .in("profile_id", Array.from(profilesById.keys()));
                if (!credentialError) {
                    (credentialData || []).forEach((row) => addStoreForProfile(row.profile_id, row.store));
                }
            } catch (_) {
                // Older deployments may not have profile_store_credentials yet.
            }

            try {
                const { data: accountData, error: accountError } = await supabase
                    .from("accounts")
                    .select("profile_id, provider, account_type")
                    .in("profile_id", Array.from(profilesById.keys()));
                if (!accountError) {
                    (accountData || []).forEach((row) => addStoreForProfile(row.profile_id, row.provider || row.account_type));
                }
            } catch (_) {
                // Some accounts schemas only have provider; account_type is optional.
                try {
                    const { data: accountData, error: accountError } = await supabase
                        .from("accounts")
                        .select("profile_id, provider")
                        .in("profile_id", Array.from(profilesById.keys()));
                    if (!accountError) {
                        (accountData || []).forEach((row) => addStoreForProfile(row.profile_id, row.provider));
                    }
                } catch (_) {}
            }

            assignmentRows = (rawProfiles || []).map((profile) => {
                const stores = Array.from(storeSetsByProfileId.get(String(profile.id)) || []);
                return {
                    user_id: profile.user_id,
                    stores: stores.length ? stores : [normalizeProfileAccountType(profile.account_type || "general")],
                    updated_at: profile.created_at || null,
                    created_at: profile.created_at || null
                };
            });
        }

        const profileCounts = new Map();
        const profileUpdated = new Map();
        assignmentRows.forEach((row) => {
            const userId = String(row.user_id || "");
            const current = profileCounts.get(userId) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, 0]));
            const updated = profileUpdated.get(userId) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, null]));
            [...new Set(row.stores || [])].forEach((store) => {
                if (!STORE_RUN_STATUS_SITES.includes(store)) return;
                current[store] = (current[store] || 0) + 1;
                const changedAt = row.updated_at || row.created_at || null;
                if (changedAt && (!updated[store] || new Date(changedAt) > new Date(updated[store]))) updated[store] = changedAt;
            });
            profileCounts.set(userId, current);
            profileUpdated.set(userId, updated);
        });

        const usersOut = (users || []).map((user) => {
            const status = statusMap.get(String(user.id)) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, false]));
            const counts = profileCounts.get(String(user.id)) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, 0]));
            const updated = profileUpdated.get(String(user.id)) || Object.fromEntries(STORE_RUN_STATUS_SITES.map((site) => [site, null]));
            return {
                id: user.id,
                email: user.email,
                role: user.role,
                user_display: formatDiscordDisplayName(user),
                owner_admin_id: user.owner_admin_id,
                stores: STORE_RUN_STATUS_SITES
                    .filter((site) => !siteFilter || site === siteFilter)
                    .map((site) => ({
                        site,
                        label: STORE_RUN_STATUS_LABELS[site] || site,
                        is_enabled: !!status[site],
                        updated_at: status[`${site}_updated_at`] || null,
                        profile_count: counts[site] || 0,
                        profile_updated_at: updated[site] || null
                    }))
            };
        });

        const summary = {};
        STORE_RUN_STATUS_SITES.forEach((site) => {
            summary[site] = usersOut.filter((user) => (user.stores || []).some((store) => store.site === site && store.is_enabled)).length;
        });

        res.json({
            stores: STORE_RUN_STATUS_SITES.map((site) => ({ site, label: STORE_RUN_STATUS_LABELS[site] || site })),
            users: usersOut,
            summary
        });
    } catch (err) {
        res.status(500).json({ error: err.message || "Could not load admin store run status" });
    }
});

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

        const assignments = await loadProfileStoreAssignments(req.user_id);
        const credentials = await loadProfileStoreCredentials((data || []).map((profile) => profile.id));

        (data || []).forEach((profile) => {
            profile.store_assignments = assignments?.get(String(profile.id)) || [normalizeProfileAccountType(profile.account_type || "general")];
            profile.store_credentials = credentials.get(String(profile.id)) || {};
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
        const accountType = normalizeProfileAccountType(req.body?.account_type || 'walmart');
        const assignedStores = normalizeAssignedStores(req.body?.assigned_stores || [accountType], accountType);
        const rawProfiles = Array.isArray(req.body?.profiles) ? req.body.profiles : [];
        if (!rawProfiles.length) {
            return res.status(400).json({ error: "No profiles were provided" });
        }

        const currentUser = await getCurrentUser(req);
        if (accountType !== "raffle") {
            await enforceProfileLimit({ userId: req.user_id, role: currentUser.role, accountType, addCount: rawProfiles.length });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const imported = [];
        const skipped = [];
        const errors = [];
        const seen = new Set();

        for (const entry of rawProfiles) {
            const payload = { ...normalizeImportedProfilePayload(entry, accountType), assigned_stores: assignedStores };
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
                await replaceProfileStoreAssignments(req.user_id, createdProfile.id, assignedStores);
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


app.post("/profiles/raffle-builder", auth, async (req, res) => {
    try {
        const currentUser = await ensureUserNotRevoked(req.user_id);
        const emails = parseRaffleEmails(req.body?.emails || "");
        const zip = String(req.body?.zip || "").trim();

        if (!emails.length) {
            return res.status(400).json({ error: "Add at least one raffle email." });
        }

        if (!/^\d{5}(-\d{4})?$/.test(zip)) {
            return res.status(400).json({ error: "ZIP code must be 5 digits or ZIP+4." });
        }

        const invalidEmails = emails.filter((email) => !isValidEmailForRaffle(email));
        if (invalidEmails.length) {
            return res.status(400).json({ error: `Invalid email(s): ${invalidEmails.slice(0, 5).join(", ")}${invalidEmails.length > 5 ? "..." : ""}` });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const existingRaffleCount = (existingProfiles || []).filter((p) => normalizeProfileAccountType(p.account_type) === "raffle").length;
        const zipLocation = await resolveZipLocation(zip);
        const created = [];
        const skipped = [];
        const errors = [];

        for (let i = 0; i < emails.length; i += 1) {
            const email = emails[i];
            const payload = buildRafflePayload(email, zip, existingRaffleCount + i, zipLocation);
            const duplicateError = findDuplicateInSameGroup(
                existingProfiles,
                null,
                payload.account_type,
                payload.profile_name,
                payload.email,
                payload.phone,
                (payload.card || "").slice(-4)
            );

            if (duplicateError) {
                skipped.push({ email, reason: duplicateError });
                continue;
            }

            const { data: createdProfile, error: profileError } = await supabase
                .from("profiles")
                .insert({
                    user_id: req.user_id,
                    profile_name: payload.profile_name,
                    account_type: "raffle"
                })
                .select()
                .single();

            if (profileError || !createdProfile) {
                errors.push({ email, reason: profileError?.message || "Profile creation failed" });
                continue;
            }

            try {
                await upsertProfileRelations(createdProfile.id, payload);
                created.push({ id: createdProfile.id, profile_name: payload.profile_name, email });
                existingProfiles.push({
                    id: createdProfile.id,
                    profile_name: payload.profile_name,
                    account_type: "raffle",
                    addresses: [{ email: payload.email, phone: payload.phone }],
                    payments: [{ card_last4: "" }]
                });
            } catch (err) {
                errors.push({ email, reason: err.message || "Could not save raffle profile" });
            }
        }

        res.json({
            success: true,
            created_count: created.length,
            skipped_count: skipped.length,
            error_count: errors.length,
            created,
            skipped,
            errors,
            note: "Raffle profiles use invalid placeholder card-style numbers that are not usable for real payments. Add real authorized payment details manually if a flow requires payment."
        });
    } catch (err) {
        const status = err.message === "This account has been revoked" ? 403 : 500;
        res.status(status).json({ error: err.message || "Raffle profile creation failed" });
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

        await supabase.from('profile_store_assignments').delete().in('profile_id', ownedIds);
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
        const assignedStores = normalizeAssignedStores(req.body?.assigned_stores, req.body?.account_type);
        const data = { ...req.body, account_type: assignedStores[0] || normalizeProfileAccountType(req.body?.account_type), assigned_stores: assignedStores };
        const cardLast4 = (data.card || "").slice(-4);

        const currentUser = await ensureUserNotRevoked(req.user_id);
        await enforceProfileAssignmentLimits({ userId: req.user_id, role: currentUser.role, stores: assignedStores });

        if (!phoneRegex.test(data.phone || "")) {
            return res.status(400).json({ error: "Phone must be xxxxxxxxxx" });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const duplicateError = findDuplicateAcrossAssignedStores(
            existingProfiles,
            null,
            assignedStores,
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
        await replaceProfileStoreAssignments(req.user_id, createdProfile.id, assignedStores);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Profile creation failed" });
    }
});

app.put("/profiles/:id", auth, async (req, res) => {
    try {
        const id = req.params.id;
        const assignedStores = normalizeAssignedStores(req.body?.assigned_stores, req.body?.account_type);
        const data = { ...req.body, account_type: assignedStores[0] || normalizeProfileAccountType(req.body?.account_type), assigned_stores: assignedStores };
        const cardLast4 = (data.card || "").slice(-4);

        const currentUser = await ensureUserNotRevoked(req.user_id);
        await enforceProfileAssignmentLimits({ userId: req.user_id, role: currentUser.role, stores: assignedStores, excludeProfileId: id });

        if (!phoneRegex.test(data.phone || "")) {
            return res.status(400).json({ error: "Phone must be xxxxxxxxxx" });
        }

        const existingProfiles = await getUserProfilesWithRelations(req.user_id);
        const currentProfile = existingProfiles.find((profile) => String(profile.id) === String(id));
        const previousStores = profileAssignedStores(currentProfile || {});
        const previousAddress = currentProfile?.addresses?.[0] || {};
        const previousPayment = currentProfile?.payments?.[0] || {};
        const duplicateFieldsChanged =
            String(currentProfile?.profile_name || "") !== String(data.profile_name || "") ||
            String(previousAddress.email || "").toLowerCase() !== String(data.email || "").toLowerCase() ||
            String(previousAddress.phone || "") !== String(data.phone || "") ||
            String(previousPayment.card_last4 || "") !== String(cardLast4 || "");

        // When editing an existing profile to add another store assignment, do not re-block the
        // store assignment that the profile already has. Older data can contain duplicate phone/card
        // values inside the existing store, and that should not prevent adding Target/Sam's Club/etc.
        // If the user actually changes shared identity/payment fields, validate every assigned store.
        const storesToDuplicateCheck = duplicateFieldsChanged
            ? assignedStores
            : assignedStores.filter((store) => !previousStores.includes(store));

        const duplicateError = storesToDuplicateCheck.length ? findDuplicateAcrossAssignedStores(
            existingProfiles,
            id,
            storesToDuplicateCheck,
            data.profile_name,
            data.email,
            data.phone,
            cardLast4
        ) : null;

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
        await replaceProfileStoreAssignments(req.user_id, id, assignedStores);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Profile update failed" });
    }
});

app.delete("/profiles/:id", auth, async (req, res) => {
    try {
        await ensureUserNotRevoked(req.user_id);

        const id = req.params.id;

        await supabase.from("profile_store_assignments").delete().eq("profile_id", id);
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
                .select("id, email, discord_username, discord_display_name")
                .in("id", ownerIds);

            ownerMap = Object.fromEntries((owners || []).map((o) => [o.id, formatDiscordDisplayName(o)]));
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

        const runStatusMap = await loadStoreRunStatusForUsers(userIds).catch(() => new Map());

        const settingsDiscordMap = {};
        for (const u of users || []) {
            if (!u.discord_user_id || !u.discord_username || !u.discord_display_name) {
                settingsDiscordMap[u.id] = await getUserDiscordIdentity(u).catch(() => ({}));
            }
        }

        const output = (users || []).map((u) => {
            const identity = settingsDiscordMap[u.id] || {};
            const merged = {
                ...u,
                discord_user_id: normalizeDiscordUserId(u.discord_user_id || identity.discord_user_id || ''),
                discord_username: u.discord_username || identity.discord_username || '',
                discord_display_name: u.discord_display_name || identity.discord_display_name || '',
                discord_avatar: u.discord_avatar || identity.discord_avatar || '',
                discord_email: u.discord_email || identity.discord_email || '',
                discord_connected_at: u.discord_connected_at || identity.discord_connected_at || null,
                profile_count: profileCountMap[u.id] || 0,
                owner_admin_email: u.owner_admin_id ? ownerMap[u.owner_admin_id] || "" : "",
                owner_admin_display: u.owner_admin_id ? ownerMap[u.owner_admin_id] || "" : "",
                store_run_status: runStatusMap.get(String(u.id)) || {},
            };
            merged.user_display = formatDiscordDisplayName(merged);
            return merged;
        });

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
            .select("id, email, discord_username, discord_display_name")
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
        const requestedOwnerAdminId = String(req.body?.owner_admin_id || "").trim();

        if (!["user", "admin"].includes(requestedRole)) {
            return res.status(400).json({ error: "Invalid invite role" });
        }

        if (quantity < 1 || quantity > 10) {
            return res.status(400).json({ error: "Quantity must be between 1 and 10" });
        }

        let createdByAdminId = currentUser.id;
        let ownerAdminEmail = "";

        if (requestedRole === "admin") {
            if (currentUser.role !== "super_admin") {
                return res.status(403).json({ error: "Only super admin can create admin invites" });
            }

            if (quantity !== 1) {
                return res.status(400).json({ error: "Admin invites can only be created one at a time" });
            }
        }

        if (requestedRole === "user" && requestedOwnerAdminId) {
            if (currentUser.role !== "super_admin") {
                return res.status(403).json({ error: "Only super admin can create user invites for another admin group" });
            }

            const { data: ownerAdmin, error: ownerError } = await supabase
                .from("users")
                .select("id,email,role,revoked")
                .eq("id", requestedOwnerAdminId)
                .single();

            if (ownerError || !ownerAdmin) {
                return res.status(400).json({ error: "Selected admin owner was not found" });
            }

            if (ownerAdmin.role !== "admin") {
                return res.status(400).json({ error: "Selected owner must be an admin account" });
            }

            if (ownerAdmin.revoked) {
                return res.status(400).json({ error: "Selected admin owner is revoked" });
            }

            createdByAdminId = ownerAdmin.id;
            ownerAdminEmail = ownerAdmin.email || "";
        }

        const inviteRows = Array.from({ length: quantity }, () => ({
            code: uuidv4().slice(0, 8),
            used: false,
            canceled: false,
            created_by_admin_id: createdByAdminId,
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
            owner_admin_id: createdByAdminId,
            owner_admin_email: ownerAdminEmail,
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
        const activeOnly = String(req.query.active_only || "") === "1";

        let query = supabase
            .from("profiles")
            .select("id, user_id, account_type");

        if (currentUser.role === "super_admin") {
            if (user_id) {
                query = query.eq("user_id", user_id);
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

        }

        const { data, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let filtered = await attachAndFilterProfilesByStore(data || [], group || "");
        filtered = await filterProfilesByActiveRunStatus(filtered, group || "", activeOnly);
        res.json({ count: filtered.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/admin/export/profiles-json", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { user_id, group } = req.query;
        const filename = (req.query.filename || "profiles").replace(/[^a-zA-Z0-9-_]/g, "");
        const activeOnly = String(req.query.active_only || "") === "1";

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
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) query = query.eq("user_id", user_id);
        }

        const { data: profiles, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let exportProfiles = await attachAndFilterProfilesByStore(profiles || [], group || "");
        exportProfiles = await filterProfilesByActiveRunStatus(exportProfiles, group || "", activeOnly);

        const rows = exportProfiles.map((profile) => {
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

function twoDigitYear(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.length === 4 ? text.slice(-2) : text.padStart(2, "0");
}

function twoDigitMonth(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.padStart(2, "0");
}

function countryForStellar(value) {
    const text = String(value || "").trim();
    if (!text) return "US";
    if (/^(united states|usa|us|u\.s\.|u\.s\.a\.)$/i.test(text)) return "US";
    return text;
}

function stateForStellar(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const normalized = text.toLowerCase().replace(/[^a-z]/g, "");
    const states = {
        alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
        colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
        hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
        kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
        massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
        missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", newhampshire: "NH",
        newjersey: "NJ", newmexico: "NM", newyork: "NY", northcarolina: "NC",
        northdakota: "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
        rhodeisland: "RI", southcarolina: "SC", southdakota: "SD", tennessee: "TN",
        texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
        westvirginia: "WV", wisconsin: "WI", wyoming: "WY", districtofcolumbia: "DC",
        dc: "DC", puertorico: "PR"
    };
    if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
    return states[normalized] || text;
}

function cardTypeForNumber(cardNumber) {
    const digits = String(cardNumber || "").replace(/\D/g, "");
    if (/^4/.test(digits)) return "Visa";
    if (/^(5[1-5]|2[2-7])/.test(digits)) return "MasterCard";
    if (/^3[47]/.test(digits)) return "Amex";
    if (/^6/.test(digits)) return "Discover";
    return "";
}


app.get("/admin/export/profiles-stellar-json", auth, admin, async (req, res) => {
    try {
        const currentUser = await getCurrentUser(req);
        const { user_id, group } = req.query;
        const filename = (req.query.filename || "stellar-profiles").replace(/[^a-zA-Z0-9-_]/g, "");
        const activeOnly = String(req.query.active_only || "") === "1";

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
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) query = query.eq("user_id", user_id);
        }

        const { data: profiles, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let exportProfiles = await attachAndFilterProfilesByStore(profiles || [], group || "");
        exportProfiles = await filterProfilesByActiveRunStatus(exportProfiles, group || "", activeOnly);

        const rows = exportProfiles.map((profile) => {
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

            const ship = {
                firstName: address.first_name || "",
                lastName: address.last_name || "",
                country: countryForStellar(address.country),
                address: address.address1 || "",
                address2: address.address2 || "",
                state: stateForStellar(address.state),
                city: address.city || "",
                zipcode: address.zip || ""
            };

            const bill = billingSameAsShipping ? { ...ship } : {
                firstName: address.billing_first_name || "",
                lastName: address.billing_last_name || "",
                country: countryForStellar(address.billing_country || address.country),
                address: address.billing_address1 || "",
                address2: address.billing_address2 || "",
                state: stateForStellar(address.billing_state),
                city: address.billing_city || "",
                zipcode: address.billing_zip || ""
            };

            return {
                profileName: profile.profile_name || "",
                email: address.email || "",
                phone: address.phone || "",
                shipping: ship,
                billingAsShipping: billingSameAsShipping,
                oneCheckoutPerProfile: false,
                billing: bill,
                payment: {
                    cardName: payment.card_name || `${address.first_name || ""} ${address.last_name || ""}`.trim(),
                    cardType: cardTypeForNumber(cardNumber),
                    cardNumber,
                    cardMonth: twoDigitMonth(payment.exp_month),
                    cardYear: twoDigitYear(payment.exp_year),
                    cardCvv
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
        const activeOnly = String(req.query.active_only || "") === "1";

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
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) query = query.eq("user_id", user_id);
        }

        const { data: profiles, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let exportProfiles = await attachAndFilterProfilesByStore(profiles || [], group || "");
        exportProfiles = await filterProfilesByActiveRunStatus(exportProfiles, group || "", activeOnly);

        const rows = exportProfiles
            .map((profile) => {
                const account = accountForExport(profile, group || profile.account_type);
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
        const activeOnly = String(req.query.active_only || "") === "1";

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
        } else {
            const ownedUserIds = await getScopeUserIdsForAdmin(currentUser);

            if (user_id && !ownedUserIds.includes(user_id)) {
                return res.status(403).json({ error: "Cannot export that account" });
            }

            query = query.in("user_id", safeIn(ownedUserIds));

            if (user_id) query = query.eq("user_id", user_id);
        }

        const { data: profiles, error } = await query;

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        let exportProfiles = await attachAndFilterProfilesByStore(profiles || [], group || "");
        exportProfiles = await filterProfilesByActiveRunStatus(exportProfiles, group || "", activeOnly);

        const rows = exportProfiles
            .map((profile) => {
                const account = accountForExport(profile, group || profile.account_type);
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


ensureFailsafeQueueDir();
setInterval(() => {
    replayWebhookFailoverQueue().catch((err) => console.error('Failover queue replay interval failed:', err));
}, FAILSAFE_REPLAY_INTERVAL_MS);
setTimeout(() => {
    replayWebhookFailoverQueue().catch((err) => console.error('Initial failover queue replay failed:', err));
}, 15000);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

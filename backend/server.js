const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const registerProductCatalogRoutes = require("./product-catalog-routes");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const supabase = require("./database");
const { encrypt, decrypt } = require("./encryption");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
    res.json({ ok: true });
});

const phoneRegex = /^[0-9]{10}$/;
const SUPER_ADMIN_EMAIL = "theshoreshacktcg@gmail.com";
const PORT = Number(process.env.PORT || 3000);

const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || "Profile Platform <no-reply@example.com>";

function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function getAppBaseUrl() {
    return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

let mailerPromise = null;

async function getMailer() {
    if (mailerPromise) return mailerPromise;

    const host = process.env.SMTP_HOST || "";
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER || "";
    const pass = process.env.SMTP_PASS || "";
    const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

    if (!host || !user || !pass) {
        mailerPromise = Promise.resolve(null);
        return mailerPromise;
    }

    const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass }
    });

    mailerPromise = Promise.resolve(transporter);
    return mailerPromise;
}

async function sendEmailMessage({ to, subject, text, html }) {
    const transporter = await getMailer();
    if (!transporter) {
        console.log("[mail] SMTP not configured, skipped email:", subject, "->", to);
        return { skipped: true };
    }

    return transporter.sendMail({
        from: MAIL_FROM,
        to,
        subject,
        text,
        html
    });
}

async function sendWelcomeEmail({ email }) {
    const appBaseUrl = getAppBaseUrl();
    const safeEmail = escapeHtml(email);

    return sendEmailMessage({
        to: email,
        subject: "Welcome to Profile Platform",
        text: [
            "Thanks for joining Profile Platform.",
            "",
            `Login email: ${email}`,
            `Login here: ${appBaseUrl}/login.html`,
            "",
            "For security, your password is not included in email. Use the password you created at signup."
        ].join("\n"),
        html: `
            <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111827">
                <h2 style="margin:0 0 12px">Welcome to Profile Platform</h2>
                <p>Thanks for joining.</p>
                <p><strong>Login email:</strong> ${safeEmail}</p>
                <p><a href="${appBaseUrl}/login.html">Log in to your account</a></p>
                <p>For security, your password is not included in email. Use the password you created at signup.</p>
            </div>
        `
    });
}

function createResetPasswordToken(user) {
    return jwt.sign(
        { purpose: "reset_password", user_id: user.id, email: normalizeEmail(user.email) },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
    );
}

async function sendResetPasswordEmail({ user }) {
    const appBaseUrl = getAppBaseUrl();
    const token = createResetPasswordToken(user);
    const resetUrl = `${appBaseUrl}/reset-password.html?token=${encodeURIComponent(token)}`;
    const safeEmail = escapeHtml(user.email);

    return sendEmailMessage({
        to: user.email,
        subject: "Reset your Profile Platform password",
        text: [
            "We received a request to reset your password.",
            "",
            `Reset password: ${resetUrl}`,
            "",
            "This link expires in 1 hour. If you did not request this, you can ignore this email."
        ].join("\n"),
        html: `
            <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#111827">
                <h2 style="margin:0 0 12px">Reset your password</h2>
                <p>We received a request to reset the password for <strong>${safeEmail}</strong>.</p>
                <p><a href="${resetUrl}">Click here to reset your password</a></p>
                <p>This link expires in 1 hour. If you did not request this, you can ignore this email.</p>
            </div>
        `
    });
}

async function findUserByEmailInsensitive(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const { data, error } = await supabase
        .from("users")
        .select("*")
        .ilike("email", normalized)
        .limit(1);

    if (error) {
        throw new Error(error.message);
    }

    return (data || [])[0] || null;
}



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


/* ================= AUTH ROUTES ================= */

app.post("/auth/signup", async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || "");
        const invite_code = String(req.body.invite_code || "").trim();

        if (!email || !password || !invite_code) {
            return res.status(400).json({ error: "Email, password, and invite code are required" });
        }

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

        const existingUser = await findUserByEmailInsensitive(email);
        if (existingUser) {
            return res.status(400).json({ error: "An account with that email already exists" });
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
            await sendWelcomeEmail({ email: user.email });
        } catch (mailErr) {
            console.error("welcome email failed:", mailErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Signup failed" });
    }
});

app.post("/auth/login", async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = String(req.body.password || "");

        const user = await findUserByEmailInsensitive(email);

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

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                owner_admin_id: user.owner_admin_id || null,
                revoked: !!user.revoked
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message || "Login failed" });
    }
});

app.post("/auth/forgot-password", async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        if (!email) {
            return res.json({ success: true });
        }

        const user = await findUserByEmailInsensitive(email);
        if (user && !user.revoked) {
            try {
                await sendResetPasswordEmail({ user });
            } catch (mailErr) {
                console.error("reset email failed:", mailErr.message);
            }
        }

        res.json({
            success: true,
            message: "If that email exists, a reset link has been sent."
        });
    } catch (err) {
        res.status(500).json({ error: err.message || "Could not process reset request" });
    }
});

app.post("/auth/reset-password", async (req, res) => {
    try {
        const tokenValue = String(req.body.token || "");
        const newPassword = String(req.body.newPassword || "");

        if (!tokenValue || !newPassword) {
            return res.status(400).json({ error: "Token and new password are required" });
        }

        const decoded = jwt.verify(tokenValue, process.env.JWT_SECRET);

        if (decoded.purpose !== "reset_password" || !decoded.user_id) {
            return res.status(400).json({ error: "Invalid reset token" });
        }

        const user = await getUserById(decoded.user_id);
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const hash = await bcrypt.hash(newPassword, 10);

        const { error } = await supabase
            .from("users")
            .update({ password_hash: hash })
            .eq("id", user.id);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        res.json({ success: true, message: "Password updated" });
    } catch (err) {
        const msg = /expired/i.test(String(err.message || "")) ? "Reset link expired" : "Invalid reset link";
        res.status(400).json({ error: msg });
    }
});

app.get("/auth/me", auth, async (req, res) => {
    try {
        const user = req.currentUser || await getCurrentUser(req);

        res.json({
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                owner_admin_id: user.owner_admin_id || null,
                revoked: !!user.revoked
            }
        });
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

        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 10);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        const ownerAdminId = req.query.owner_admin_id || "";
        const roleFilter = req.query.role || "";
        const createdAfter = req.query.created_after || "";
        const createdBefore = req.query.created_before || "";

        let usersQuery = supabase
            .from("users")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false })
            .range(from, to);

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
            page,
            limit,
            total: count || 0,
            total_pages: Math.ceil((count || 0) / limit)
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

        const page = Math.max(parseInt(req.query.page || "1", 10), 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit || "10", 10), 1), 10);
        const from = (page - 1) * limit;
        const to = from + limit - 1;

        let inviteQuery = supabase
            .from("invite_codes")
            .select("*", { count: "exact" })
            .order("created_at", { ascending: false })
            .range(from, to);

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
            page,
            limit,
            total: count || 0,
            total_pages: Math.ceil((count || 0) / limit)
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

        const lines = (profiles || [])
            .map((profile) => {
                const account = profile.accounts?.[0] || {};
                const email = account.login_email || "";
                const password = account.login_password || "";
                const secret = account.amazon_2fa_secret || account.gmail_app_password || "";

                if (!email && !password && !secret) return null;

                return `${email}:${password}:${secret}`;
            })
            .filter(Boolean);

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}.txt"`);
        res.send(lines.join("\\n"));
    } catch (err) {
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

ensureSuperAdmin()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("Failed to start server:", err.message);
        process.exit(1);
    });
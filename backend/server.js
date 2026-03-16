require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const supabase = require("./database");
const { encrypt, decrypt } = require("./encryption");

const app = express();

const allowedOrigins = [
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://spontaneous-monstera-1b6376.netlify.app",
];

app.use(
    cors({
        origin(origin, callback) {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            return callback(new Error("Not allowed by CORS"));
        },
    })
);

app.use(express.json());

const phoneRegex = /^[0-9]{10}$/;

app.get("/", (req, res) => {
    res.json({ ok: true, service: "profile-platform-api" });
});

app.get("/health", (req, res) => {
    res.json({ ok: true });
});

/* ================= AUTH ================= */

function auth(req, res, next) {
    const header = req.headers.authorization;

    if (!header) {
        return res.status(401).json({ error: "No token" });
    }

    const token = header.split(" ")[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user_id = decoded.user_id;
        req.role = decoded.role;
        next();
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }
}

function admin(req, res, next) {
    if (req.role !== "admin") {
        return res.status(403).json({ error: "Admin only" });
    }
    next();
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

/* ================= SIGNUP ================= */

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

    const { data: user, error } = await supabase
        .from("users")
        .insert({
            email,
            password_hash: hash,
            role: "user",
            revoked: false,
        })
        .select()
        .single();

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    await supabase
        .from("invite_codes")
        .update({ used: true, used_by: user.id })
        .eq("id", invite.id);

    res.json({ success: true });
});

/* ================= LOGIN ================= */

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
        {
            user_id: user.id,
            role: user.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
    );

    res.json({
        token,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            revoked: !!user.revoked,
        },
    });
});

/* ================= CHANGE PASSWORD ================= */

app.post("/change-password", auth, async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("id", req.user_id)
        .single();

    if (user.revoked) {
        return res.status(403).json({ error: "This account has been revoked" });
    }

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
});

/* ================= GET PROFILES ================= */

app.get("/profiles", auth, async (req, res) => {
    const { data: user } = await supabase
        .from("users")
        .select("revoked")
        .eq("id", req.user_id)
        .single();

    if (user?.revoked) {
        return res.status(403).json({ error: "This account has been revoked" });
    }

    const { data, error } = await supabase
        .from("profiles")
        .select(`*, addresses(*), payments(*)`)
        .eq("user_id", req.user_id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    data.forEach((profile) => {
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

    res.json(data);
});

/* ================= CREATE PROFILE ================= */

app.post("/profiles", auth, async (req, res) => {
    try {
        const data = req.body;
        const cardLast4 = (data.card || "").slice(-4);

        const { data: user } = await supabase
            .from("users")
            .select("revoked")
            .eq("id", req.user_id)
            .single();

        if (user?.revoked) {
            return res.status(403).json({ error: "This account has been revoked" });
        }

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

        const encryptedCard = encrypt(data.card);
        const encryptedCVV = encrypt(data.cvv);

        const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .insert({
                user_id: req.user_id,
                profile_name: data.profile_name,
                account_type: data.account_type,
            })
            .select()
            .single();

        if (profileError) {
            return res.status(500).json({ error: profileError.message });
        }

        const { error: addressError } = await supabase.from("addresses").insert({
            profile_id: profile.id,
            first_name: data.first_name,
            last_name: data.last_name,
            email: data.email,
            phone: data.phone,
            address1: data.address1,
            city: data.city,
            state: data.state,
            zip: data.zip,
        });

        if (addressError) {
            return res.status(500).json({ error: addressError.message });
        }

        const { error: paymentError } = await supabase.from("payments").insert({
            profile_id: profile.id,
            card_encrypted: encryptedCard,
            cvv_encrypted: encryptedCVV,
            exp_month: data.exp_month,
            exp_year: data.exp_year,
            card_last4: cardLast4,
        });

        if (paymentError) {
            return res.status(500).json({ error: paymentError.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Profile creation failed" });
    }
});

/* ================= UPDATE PROFILE ================= */

app.put("/profiles/:id", auth, async (req, res) => {
    try {
        const id = req.params.id;
        const data = req.body;
        const cardLast4 = (data.card || "").slice(-4);

        const { data: user } = await supabase
            .from("users")
            .select("revoked")
            .eq("id", req.user_id)
            .single();

        if (user?.revoked) {
            return res.status(403).json({ error: "This account has been revoked" });
        }

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

        const encryptedCard = encrypt(data.card);
        const encryptedCVV = encrypt(data.cvv);

        const { error: profileError } = await supabase
            .from("profiles")
            .update({
                profile_name: data.profile_name,
                account_type: data.account_type,
            })
            .eq("id", id)
            .eq("user_id", req.user_id);

        if (profileError) {
            return res.status(500).json({ error: profileError.message });
        }

        const { error: addressError } = await supabase
            .from("addresses")
            .update({
                first_name: data.first_name,
                last_name: data.last_name,
                email: data.email,
                phone: data.phone,
                address1: data.address1,
                city: data.city,
                state: data.state,
                zip: data.zip,
            })
            .eq("profile_id", id);

        if (addressError) {
            return res.status(500).json({ error: addressError.message });
        }

        const { error: paymentError } = await supabase
            .from("payments")
            .update({
                card_encrypted: encryptedCard,
                cvv_encrypted: encryptedCVV,
                exp_month: data.exp_month,
                exp_year: data.exp_year,
                card_last4: cardLast4,
            })
            .eq("profile_id", id);

        if (paymentError) {
            return res.status(500).json({ error: paymentError.message });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || "Profile update failed" });
    }
});

/* ================= DELETE PROFILE ================= */

app.delete("/profiles/:id", auth, async (req, res) => {
    await supabase
        .from("profiles")
        .delete()
        .eq("id", req.params.id)
        .eq("user_id", req.user_id);

    res.json({ success: true });
});

/* ================= ADMIN USERS ================= */

app.get("/admin/users", auth, admin, async (req, res) => {
    const { data: users, error: usersError } = await supabase
        .from("users")
        .select("*")
        .order("created_at", { ascending: false });

    if (usersError) {
        return res.status(500).json({ error: usersError.message });
    }

    const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, user_id");

    if (profilesError) {
        return res.status(500).json({ error: profilesError.message });
    }

    const profileCounts = {};

    (profiles || []).forEach((profile) => {
        profileCounts[profile.user_id] = (profileCounts[profile.user_id] || 0) + 1;
    });

    const usersWithCounts = (users || []).map((user) => ({
        ...user,
        profile_count: profileCounts[user.id] || 0,
    }));

    res.json(usersWithCounts);
});

app.patch("/admin/users/:id/revoke", auth, admin, async (req, res) => {
    const targetId = req.params.id;

    const { data: targetUser } = await supabase
        .from("users")
        .select("*")
        .eq("id", targetId)
        .single();

    if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
    }

    if (targetUser.role === "admin") {
        return res.status(400).json({ error: "Admin account cannot be revoked" });
    }

    const { error } = await supabase
        .from("users")
        .update({ revoked: true })
        .eq("id", targetId);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
});

app.patch("/admin/users/:id/restore", auth, admin, async (req, res) => {
    const targetId = req.params.id;

    const { data: targetUser } = await supabase
        .from("users")
        .select("*")
        .eq("id", targetId)
        .single();

    if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
    }

    const { error } = await supabase
        .from("users")
        .update({ revoked: false })
        .eq("id", targetId);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
});

app.delete("/admin/users/:id", auth, admin, async (req, res) => {
    const targetId = req.params.id;

    const { data: targetUser, error: targetUserError } = await supabase
        .from("users")
        .select("*")
        .eq("id", targetId)
        .single();

    if (targetUserError || !targetUser) {
        return res.status(404).json({ error: "User not found" });
    }

    if (targetUser.role === "admin") {
        return res.status(400).json({ error: "Admin account cannot be deleted" });
    }

    const { data: userProfiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", targetId);

    if (profilesError) {
        return res.status(500).json({ error: profilesError.message });
    }

    const profileIds = (userProfiles || []).map((p) => p.id);

    if (profileIds.length > 0) {
        const { error: addressesError } = await supabase
            .from("addresses")
            .delete()
            .in("profile_id", profileIds);

        if (addressesError) {
            return res.status(500).json({ error: addressesError.message });
        }

        const { error: paymentsError } = await supabase
            .from("payments")
            .delete()
            .in("profile_id", profileIds);

        if (paymentsError) {
            return res.status(500).json({ error: paymentsError.message });
        }

        const { error: deleteProfilesError } = await supabase
            .from("profiles")
            .delete()
            .in("id", profileIds);

        if (deleteProfilesError) {
            return res.status(500).json({ error: deleteProfilesError.message });
        }
    }

    const { error: deleteUserError } = await supabase
        .from("users")
        .delete()
        .eq("id", targetId);

    if (deleteUserError) {
        return res.status(500).json({ error: deleteUserError.message });
    }

    res.json({ success: true });
});

/* ================= ADMIN INVITES ================= */

app.post("/admin/create-invite", auth, admin, async (req, res) => {
    const code = uuidv4().slice(0, 8);

    const { error } = await supabase.from("invite_codes").insert({
        code,
        used: false,
        canceled: false,
    });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ code });
});

app.get("/admin/invites", auth, admin, async (req, res) => {
    const { data, error } = await supabase
        .from("invite_codes")
        .select("*")
        .order("created_at", { ascending: false });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json(data);
});

app.patch("/admin/invites/:id/cancel", auth, admin, async (req, res) => {
    const { error } = await supabase
        .from("invite_codes")
        .update({ canceled: true })
        .eq("id", req.params.id)
        .eq("used", false);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
});

app.delete("/admin/invites/:id", auth, admin, async (req, res) => {
    const { error } = await supabase
        .from("invite_codes")
        .delete()
        .eq("id", req.params.id);

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
});

/* ================= EXPORT COUNT ================= */

app.get("/admin/export/count", auth, admin, async (req, res) => {
    const { user_id, group } = req.query;

    let query = supabase
        .from("profiles")
        .select("id", { count: "exact", head: true });

    if (user_id) {
        query = query.eq("user_id", user_id);
    }

    if (group) {
        query = query.eq("account_type", group);
    }

    const { count, error } = await query;

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    res.json({ count: count || 0 });
});

/* ================= AYCD EXPORT ================= */

app.get("/admin/export/aycd", auth, admin, async (req, res) => {
    const { user_id, group } = req.query;

    let query = supabase.from("profiles").select(`*, addresses(*), payments(*)`);

    if (user_id) {
        query = query.eq("user_id", user_id);
    }

    if (group) {
        query = query.eq("account_type", group);
    }

    const { data, error } = await query;

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    const exportProfiles = (data || [])
        .map((p) => {
            const addr = p.addresses?.[0];
            const pay = p.payments?.[0];

            if (!addr || !pay) return null;

            return {
                id: "prf-" + uuidv4(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                name: p.profile_name,
                email: addr.email,
                oneTimeUse: false,
                shipping: {
                    firstName: addr.first_name,
                    lastName: addr.last_name,
                    address1: addr.address1,
                    address2: "",
                    city: addr.city,
                    province: addr.state,
                    postalCode: addr.zip,
                    country: "United States",
                    phone: addr.phone,
                },
                billing: {
                    sameAsShipping: true,
                    firstName: "",
                    lastName: "",
                    address1: "",
                    address2: "",
                    city: "",
                    province: null,
                    postalCode: "",
                    country: null,
                    phone: "",
                },
                payment: {
                    name: addr.first_name + " " + addr.last_name,
                    num: decrypt(pay.card_encrypted),
                    year: pay.exp_year,
                    month: pay.exp_month,
                    cvv: decrypt(pay.cvv_encrypted),
                },
            };
        })
        .filter(Boolean);

    res.json(exportProfiles);
});

/* ================= OPTIONAL ADMIN SEED ================= */

async function ensureAdmin() {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;

    if (!email || !password) {
        console.log("Skipping admin seed");
        return;
    }

    const { data: user } = await supabase
        .from("users")
        .select("*")
        .eq("email", email)
        .single();

    const hash = await bcrypt.hash(password, 10);

    if (!user) {
        await supabase.from("users").insert({
            email,
            password_hash: hash,
            role: "admin",
            revoked: false,
        });
        console.log("Admin account created");
    } else {
        await supabase
            .from("users")
            .update({
                password_hash: hash,
                role: "admin",
                revoked: false,
            })
            .eq("email", email);
        console.log("Admin password reset");
    }
}

const PORT = process.env.PORT || 3000;

ensureAdmin()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("Startup failed:", err);
        process.exit(1);
    });
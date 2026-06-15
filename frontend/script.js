
function parseMultiSkuValue(rawValue) {
    if (!rawValue) return [];
    return String(rawValue)
        .split(/[\n,]+/)
        .map((value) => value.trim())
        .filter(Boolean);
}

function getProductSkuUnitCount(product) {
    if (!product || !product.sku) return 1;
    return Math.max(1, parseMultiSkuValue(product.sku).length);
}

function countSelectedStoreSkuUnits(site) {
    const selected = storeSelectedProductIds[site] || new Set();
    const products = storeProductCache[site] || [];
    return products.reduce((total, product) => {
        return selected.has(String(product.id)) ? total + getProductSkuUnitCount(product) : total;
    }, 0);
}


function migrateLegacyMultiSkuSelections(site, products) {
    if (!Array.isArray(products)) return products;

    const selectedSingles = new Set(
        products
            .filter((p) => p.selected)
            .map((p) => String(p.sku || '').trim())
    );

    products.forEach((product) => {
        const parts = parseMultiSkuValue(product.sku);

        if (parts.length > 1) {
            const matched = parts.some((sku) => selectedSingles.has(String(sku).trim()));

            if (matched) {
                product.selected = true;

                products.forEach((single) => {
                    if (single.id === product.id) return;

                    const singleSku = String(single.sku || '').trim();

                    if (parts.includes(singleSku)) {
                        single.selected = false;
                    }
                });
            }
        }
    });

    return products;
}

function dedupeMultiSkuProducts(products) {
    if (!Array.isArray(products)) return [];
    const groupedSkus = new Set();
    products.forEach((product) => {
        const parts = parseMultiSkuValue(product.sku);
        if (parts.length > 1) parts.forEach((sku) => groupedSkus.add(sku));
    });
    return products.filter((product) => {
        const parts = parseMultiSkuValue(product.sku);
        if (parts.length > 1) return true;
        return !groupedSkus.has(String(product.sku || '').trim());
    });
}


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

const API =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:3000"
        : "https://profile-platform.onrender.com";

function consumeOAuthRedirectParams() {
    const params = new URLSearchParams(window.location.search || '');
    const tokenValue = params.get('token');
    const errorValue = params.get('error');
    if (tokenValue) {
        localStorage.token = tokenValue;
        const cleanUrl = window.location.pathname || 'dashboard.html';
        window.history.replaceState({}, document.title, cleanUrl);
    }
    if (errorValue) {
        const msg = document.getElementById('error') || document.getElementById('userSettingsMessage');
        if (msg) msg.textContent = errorValue;
    }
}

function startDiscordOAuth(mode = 'login') {
    const params = new URLSearchParams({ mode });
    if (mode === 'signup') {
        const inviteInput = document.getElementById('invite');
        const inviteCode = String(inviteInput?.value || '').trim();
        if (!inviteCode) {
            const msg = document.getElementById('error');
            if (msg) msg.textContent = 'Enter your invite code before signing up with Discord.';
            return;
        }
        params.set('invite_code', inviteCode);
    }
    if (mode === 'connect') {
        const saved = token();
        if (!saved) {
            window.location.href = 'login.html';
            return;
        }
        params.set('token', saved);
    }
    window.location.href = `${API}/auth/discord/start?${params.toString()}`;
}

function userDisplayName(user = {}) {
    const discord = String(user.discord_display_name || user.discord_username || user.discord_name || '').trim();
    const email = String(user.email || user.user_email || '').trim();
    if (discord && email) return `${discord} (${email})`;
    return email || discord || user.id || user.user_id || '-';
}

function userExportDisplayName(user = {}) {
    const discord = String(user.discord_display_name || user.discord_username || '').trim();
    const email = String(user.user_email || user.email || '').trim();
    if (discord && email) return `${discord} (${email})`;
    return email || discord || user.user_id || '-';
}

let invitePage = 1;
let usersPage = 1;
const PAGE_SIZE = 10;


let profileImportBound = false;
let raffleBuilderBound = false;
let allDashboardProfiles = [];
let profileGroupFilters = { all: '', general: '', walmart: '', target: '', samsclub: '', amazon: '', crunchyroll: '', pokemoncenter: '', raffle: '' };
let selectedProfileIds = new Set();

consumeOAuthRedirectParams();

const PUBLIC_PATHS = new Set(["/", "/index.html", "/guide", "/guide.html", "/login", "/login.html", "/signup", "/signup.html", "/forgot-password", "/forgot-password.html", "/reset-password", "/reset-password.html"]);

function currentPathname() {
    return window.location.pathname || "/";
}

function requireAuthForPrivatePages() {
    const path = currentPathname();
    const isPublic = PUBLIC_PATHS.has(path) || path.includes("guide") || path.endsWith("index.html") || path === "/";
    if (!isPublic && !token()) {
        window.location.replace("login.html");
        return false;
    }
    return true;
}

function escapeHTML(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? "$" + n.toFixed(2) : "—";
}

function formatCredits(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)} credits` : "0 credits";
}

function parseCountdownProductCredits(textValue) {
    return String(textValue || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [product_id, credit_cost] = line.split('|').map((part) => String(part || '').trim());
        return { product_id, credit_cost: Number(credit_cost || 0) };
    }).filter((row) => row.product_id);
}

function formatCountdownProductCredits(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => {
        const product = row.catalog_products || {};
        const label = product.product_name || product.sku || row.product_id;
        return `${row.product_id}|${Number(row.credit_cost || 0)}${label ? `  # ${label}` : ''}`;
    }).join("\n");
}

function formatDateTime(value) {
    if (!value) return '—';
    try {
        return new Date(value).toLocaleString();
    } catch {
        return String(value);
    }
}


function token() {
    return localStorage.getItem("token");
}

function currentUser() {
    try {
        return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
        return null;
    }
}

async function refreshCurrentUserFromServer() {
    const savedToken = token();
    if (!savedToken) return null;

    try {
        const res = await fetch(API + "/auth/me", {
            headers: {
                Authorization: "Bearer " + savedToken
            }
        });

        const data = await res.json();

        if (data.error || !data.user) {
            return null;
        }

        localStorage.user = JSON.stringify(data.user);
        return data.user;
    } catch {
        return null;
    }
}

function isAdminRole(role) {
    return role === "admin" || role === "super_admin";
}

function isSuperAdmin() {
    return currentUser()?.role === "super_admin";
}

function canManageCatalog() {
    return isSuperAdmin();
}

function syncSuperAdminStorefrontLink() {
    const link = document.getElementById("storefrontAdminLink");
    if (link) link.style.display = isSuperAdmin() ? "inline-flex" : "none";
}

function logout() {
    localStorage.clear();
    location = "login.html";
}

function openAdminPanel() {
    location = "admin.html";
}

function openStoreAdmin() {
    location = "admin-store.html";
}

function openUserDashboard() {
    location = "dashboard.html";
}

function goToChangePassword() {
    location = "change-password.html";
}

function togglePasswordVisibility(inputId, buttonEl) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";

    if (buttonEl) {
        buttonEl.textContent = isPassword ? "Hide" : "Show";
    }
}

function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
}

function maskCard(cardNumber, fallbackLast4 = "") {
    const digits = (cardNumber || "").replace(/\D/g, "");
    const last4 = digits.slice(-4) || fallbackLast4 || "----";
    return "**** **** **** " + last4;
}


function selectedAccountType() {
    const assignments = selectedStoreAssignments();
    if (assignments.length) return assignments[0];
    const el = document.getElementById("account_type");
    return el ? el.value : "general";
}

function selectedStoreAssignments() {
    return Array.from(document.querySelectorAll('input[name="assigned_stores"]:checked'))
        .map((input) => String(input.value || '').trim().toLowerCase())
        .filter(Boolean);
}

function setStoreAssignments(stores = []) {
    const clean = Array.isArray(stores) ? stores.map((store) => String(store || '').toLowerCase()) : [];
    document.querySelectorAll('input[name="assigned_stores"]').forEach((input) => {
        input.checked = clean.includes(String(input.value || '').toLowerCase());
    });
    const accountType = document.getElementById("account_type");
    if (accountType) {
        accountType.value = clean[0] || "general";
    }
}

function profileAssignedStores(profile = {}) {
    if (Array.isArray(profile.store_assignments) && profile.store_assignments.length) {
        return profile.store_assignments.map((store) => String(store || '').toLowerCase());
    }
    if (Array.isArray(profile.profile_store_assignments) && profile.profile_store_assignments.length) {
        return profile.profile_store_assignments.map((row) => String(row.store || '').toLowerCase());
    }
    return [String(profile.account_type || 'general').toLowerCase()];
}

function profileInGroup(profile, group) {
    const cleanGroup = String(group || '').toLowerCase();
    if (cleanGroup === 'all' || cleanGroup === 'profiles') return true;
    return profileAssignedStores(profile).includes(cleanGroup);
}

const STORE_CREDENTIAL_CONFIG = {
    target: { label: 'Target', method: 'imap', help: 'Target uses email, account password, and Gmail app password / IMAP.' },
    walmart: { label: 'Walmart', method: 'imap', help: 'Walmart uses email, account password, and Gmail app password / IMAP.' },
    samsclub: { label: "Sam's Club", method: 'imap', help: "Sam's Club uses email, account password, and Gmail app password / IMAP." },
    amazon: { label: 'Amazon', method: 'amazon2fa', help: 'Amazon uses email, password, and authenticator / 2FA secret.' },
    crunchyroll: { label: 'Crunchyroll', method: 'password', help: 'Crunchyroll uses email and password only.' }
};

function profileStoreCredentials(profile = {}, store = '') {
    const key = String(store || '').toLowerCase();
    const fromMap = profile.store_credentials && profile.store_credentials[key];
    if (fromMap) return fromMap;
    const accounts = Array.isArray(profile.accounts) ? profile.accounts : [];
    return accounts.find((acct) => String(acct.provider || '').toLowerCase() === key) || accounts[0] || {};
}

function firstSavedImapAppPassword(profile = {}, existingValues = {}) {
    const imapStores = Object.entries(STORE_CREDENTIAL_CONFIG)
        .filter(([, cfg]) => cfg.method === 'imap')
        .map(([store]) => store);

    for (const store of imapStores) {
        const current = existingValues[store] || {};
        const value = String(current.gmail_app_password || '').trim();
        if (value) return value;
    }

    for (const store of imapStores) {
        const saved = profileStoreCredentials(profile || {}, store) || {};
        const value = String(saved.gmail_app_password || '').trim();
        if (value) return value;
    }

    const account = Array.isArray(profile?.accounts) ? profile.accounts.find((acct) => String(acct.gmail_app_password || '').trim()) : null;
    return String(account?.gmail_app_password || profile?.gmail_app_password || '').trim();
}

function storeCredentialBlock(store, values = {}) {
    const cfg = STORE_CREDENTIAL_CONFIG[store];
    if (!cfg) return '';
    const prefix = `store_${store}`;
    const loginEmail = escapeHTML(values.login_email || '');
    const loginPassword = escapeHTML(values.login_password || '');
    const gmailAppPassword = escapeHTML(values.gmail_app_password || '');
    const amazonSecret = escapeHTML(values.amazon_2fa_secret || values.two_fa_secret || '');
    const sharedEmail = escapeHTML(document.getElementById('email')?.value || '');

    let extra = '';
    if (cfg.method === 'imap') {
        const imapHelpId = `${prefix}_gmail_app_password_help`;
        extra = `
            <div class="field field--full">
                <label for="${prefix}_gmail_app_password">
                    ${cfg.label} Gmail App Password / IMAP
                    <button class="help-link-button" type="button" data-toggle-help="${imapHelpId}">What is this?</button>
                </label>
                <input class="input" id="${prefix}_gmail_app_password" type="password" value="${gmailAppPassword}" placeholder="Gmail App Password" />
                <div class="inline-help-card" id="${imapHelpId}" hidden>
                    A Gmail app password is different from your normal Gmail password. Create the store account first, then turn on 2-Step Verification in your Gmail account. After 2-Step Verification is on, search Gmail/Google Account settings for <strong>App passwords</strong>, create a new app password, and paste the 16-character code here. It usually looks like <strong>xxxx xxxx xxxx xxxx</strong>.
                </div>
            </div>`;
    } else if (cfg.method === 'amazon2fa') {
        extra = `
            <div class="field field--full">
                <label for="${prefix}_amazon_2fa_secret">Amazon Authenticator / 2FA Secret</label>
                <input class="input" id="${prefix}_amazon_2fa_secret" value="${amazonSecret}" placeholder="Amazon Authenticator Secret" />
            </div>`;
    }

    return `
        <section class="credential-store-card" data-store-credential-card="${store}">
            <div class="panel-header">
                <div>
                    <h4>${cfg.label} Login</h4>
                    <p class="form-help">${cfg.help}</p>
                </div>
            </div>
            <div class="form-grid">
                <div class="field field--full">
                    <label for="${prefix}_login_email">${cfg.label} Login Email</label>
                    <input class="input" id="${prefix}_login_email" value="${loginEmail || sharedEmail}" placeholder="Login Email" />
                </div>
                <div class="field">
                    <label for="${prefix}_login_password">${cfg.label} Password</label>
                    <input class="input" id="${prefix}_login_password" type="password" value="${loginPassword}" placeholder="Account Password" />
                </div>
                <div class="field field-actions">
                    <label>&nbsp;</label>
                    <button class="btn" type="button" onclick="togglePasswordVisibility('${prefix}_login_password', this)">Show</button>
                </div>
                ${extra}
            </div>
        </section>`;
}

function toggleAccountCredentialFields(profile = null) {
    const section = document.getElementById("accountCredentialsSection");
    const container = document.getElementById("storeCredentialFields");
    if (!section || !container) return;

    const existingValues = collectStoreCredentials(Object.keys(STORE_CREDENTIAL_CONFIG));
    const type = selectedAccountType();
    const assignments = selectedStoreAssignments();
    const activeStores = assignments.length ? assignments : [type];
    const storesNeedingCredentials = activeStores.filter((store) => STORE_CREDENTIAL_CONFIG[store]);

    section.style.display = storesNeedingCredentials.length ? "block" : "none";
    const sharedGmailAppPassword = firstSavedImapAppPassword(profile || {}, existingValues);
    container.innerHTML = storesNeedingCredentials.map((store) => {
        const saved = profileStoreCredentials(profile || {}, store);
        const current = existingValues[store] || {};
        const values = Object.assign({}, saved, Object.fromEntries(Object.entries(current).filter(([, value]) => value)));
        if (STORE_CREDENTIAL_CONFIG[store]?.method === 'imap' && !String(values.gmail_app_password || '').trim() && sharedGmailAppPassword) {
            values.gmail_app_password = sharedGmailAppPassword;
        }
        return storeCredentialBlock(store, values);
    }).join('');
}

function collectStoreCredentials(assignedStores = []) {
    const out = {};
    assignedStores.forEach((store) => {
        store = String(store || '').toLowerCase();
        if (!STORE_CREDENTIAL_CONFIG[store]) return;
        const prefix = `store_${store}`;
        out[store] = {
            store,
            login_email: document.getElementById(`${prefix}_login_email`)?.value.trim() || '',
            login_password: document.getElementById(`${prefix}_login_password`)?.value.trim() || '',
            gmail_app_password: document.getElementById(`${prefix}_gmail_app_password`)?.value.trim() || '',
            amazon_2fa_secret: document.getElementById(`${prefix}_amazon_2fa_secret`)?.value.trim() || ''
        };
    });
    return out;
}

function credentialStatusForStore(profile = {}, store = '') {
    const cfg = STORE_CREDENTIAL_CONFIG[store];
    if (!cfg) return 'No login needed';
    const creds = profileStoreCredentials(profile, store);
    const hasEmail = !!String(creds.login_email || '').trim();
    const hasPassword = !!String(creds.login_password || '').trim();
    const hasImap = !!String(creds.gmail_app_password || '').trim();
    const has2fa = !!String(creds.amazon_2fa_secret || creds.two_fa_secret || '').trim();
    if (cfg.method === 'imap') return hasEmail && hasPassword && hasImap ? 'Login complete' : 'Missing login info';
    if (cfg.method === 'amazon2fa') return hasEmail && hasPassword && has2fa ? 'Login complete' : 'Missing login info';
    return hasEmail && hasPassword ? 'Login complete' : 'Missing login info';
}


/* ================= LOGIN ================= */

const loginForm = document.getElementById("loginForm");
if (loginForm) {
    loginForm.onsubmit = async (e) => {
        e.preventDefault();

        try {
            const res = await fetch(API + "/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: email.value,
                    password: password.value
                })
            });

            const data = await res.json();

            if (data.error) {
                error.innerText = data.error;
                return;
            }

            localStorage.token = data.token;
            localStorage.user = JSON.stringify(data.user);

            // Everyone lands on the user dashboard.
            // Admins and super admins will still see the Admin Panel button there.
            location = "dashboard.html";


        } catch {
            error.innerText = "Could not connect to the server.";
        }
    };
}

/* ================= SIGNUP ================= */

const signupForm = document.getElementById("signupForm");
if (signupForm) {
    signupForm.onsubmit = async (e) => {
        e.preventDefault();

        try {
            const res = await fetch(API + "/auth/signup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: email.value,
                    password: password.value,
                    invite_code: invite.value
                })
            });

            const data = await res.json();

            if (data.error) {
                error.innerText = data.error;
                return;
            }

            alert("Account created");
            location = "login.html";
        } catch {
            error.innerText = "Could not connect to the server.";
        }
    };
}

/* ================= DASHBOARD ================= */

async function loadProfiles() {
    const profilePanels = {
        all: document.getElementById("allProfilesPanel"),
        general: document.getElementById("generalProfilesPanel"),
        walmart: document.getElementById("walmartProfilesPanel"),
        target: document.getElementById("targetProfilesPanel"),
        samsclub: document.getElementById("samsclubProfilesPanel"),
        amazon: document.getElementById("amazonProfilesPanel"),
        crunchyroll: document.getElementById("crunchyrollProfilesPanel"),
        pokemoncenter: document.getElementById("pokemoncenterProfilesPanel"),
        raffle: document.getElementById("raffleProfilesPanel")
    };

    if (!Object.values(profilePanels).some(Boolean)) return;

    let user = currentUser();
    const adminButton = document.getElementById("adminPanelButton");
    const storeAdminButton = document.getElementById("storeAdminButton");

    try {
        const refreshedUser = await refreshCurrentUserFromServer();
        user = refreshedUser || user;
    } catch (_) { }

    if (adminButton) {
        adminButton.style.display = isAdminRole(user?.role) ? "inline-flex" : "none";
    }
    if (storeAdminButton) {
        storeAdminButton.style.display = user?.role === 'super_admin' ? 'inline-flex' : 'none';
    }

    try {
        const res = await fetch(API + "/profiles", {
            headers: { Authorization: "Bearer " + token() }
        });

        const profiles = await res.json();

        if (!Array.isArray(profiles)) {
            const msg = `${profiles.error || "Could not load profiles."}`;
            Object.values(profilePanels).forEach((panel) => {
                if (panel) panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(msg)}</p></div>`;
            });
            return;
        }

        allDashboardProfiles = profiles;
        const groups = { all: [], general: [], walmart: [], target: [], samsclub: [], amazon: [], crunchyroll: [], pokemoncenter: [], raffle: [] };
        profiles.forEach((p) => {
            groups.all.push(p);
            const assignedStores = profileAssignedStores(p);
            if (String(p.account_type || '').toLowerCase() === 'raffle') {
                groups.raffle.push(p);
                return;
            }
            assignedStores.forEach((key) => {
                if (groups[key] && !groups[key].some((existing) => String(existing.id) === String(p.id))) {
                    groups[key].push(p);
                }
            });
        });

        const setStat = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setStat("profileCountStat", profiles.length);
        setStat("amazonProfileCountStat", groups.amazon.length);
        setStat("retailProfileCountStat", groups.target.length + groups.walmart.length);
        setStat("samsclubProfileCountStat", groups.samsclub.length);
        setStat("raffleProfileCountStat", groups.raffle.length);
        setStat("generalProfileCountStat", groups.general.length);

        const labels = {
            general: "General Profiles",
            walmart: "Walmart Profiles",
            target: "Target Profiles",
            samsclub: "Sam's Club Profiles",
            amazon: "Amazon Profiles",
            crunchyroll: "Crunchyroll Profiles",
            pokemoncenter: "Pokémon Center Profiles",
            all: "All Profiles",
            pokemoncenter: "Pokémon Center Profiles",
            raffle: "Raffle Profiles"
        };

        const descriptions = {
            general: "Flexible profiles for general checkouts.",
            walmart: "Profiles configured for Walmart accounts.",
            target: "Profiles configured for Target accounts.",
            samsclub: "Profiles configured for Sam's Club accounts.",
            amazon: "Profiles configured for Amazon accounts.",
            raffle: "Bulk-built raffle entries. Payment fields use invalid placeholder card-style numbers unless edited manually."
        };

        const renderGroup = (groupKey) => {
            const rawItems = groups[groupKey] || [];
            const filterValue = String(profileGroupFilters[groupKey] || '').trim().toLowerCase();
            const items = filterValue
                ? rawItems.filter((p) => {
                    const address = p.addresses?.[0] || {};
                    const payment = p.payments?.[0] || {};
                    const haystack = [p.profile_name, address.email, address.phone, address.city, address.state, payment.card_last4].join(' ').toLowerCase();
                    return haystack.includes(filterValue);
                })
                : rawItems;
            const selectedCount = rawItems.filter((p) => selectedProfileIds.has(String(p.id))).length;

            let html = `
                <section class="profile-group-section">
                    <div class="profile-group-header">
                        <div>
                            <h3 class="profile-group-title">${labels[groupKey]}</h3>
                            <div class="profile-group-subtitle">${descriptions[groupKey]}</div>
                        </div>
                        <span class="badge">${rawItems.length} saved</span>
                    </div>
                    <div class="toolbar-row profile-group-toolbar">
                        <input class="input" type="search" placeholder="Search ${labels[groupKey].toLowerCase()}" value="${escapeHTML(profileGroupFilters[groupKey] || '')}" data-profile-search="${groupKey}" />
                        <button class="btn" type="button" data-profile-select-visible="${groupKey}">Select Visible</button>
                        <button class="btn btn-danger" type="button" data-profile-delete-group="${groupKey}" ${selectedCount ? '' : 'disabled'}>Delete Selected (${selectedCount})</button>
                    </div>
            `;

            if (!items.length) {
                html += `
                    <div class="empty-card">
                        <h4>${rawItems.length ? 'No matching profiles' : 'No profiles yet'}</h4>
                        <p>${rawItems.length ? 'Try a different search.' : 'Create your first ' + groupKey + ' profile.'}</p>
                        <div class="panel-actions">
                            <button class="btn btn-primary" onclick="createProfile()">Create Profile</button>
                        </div>
                    </div>
                `;
            } else {
                html += `<div class="profile-card-scroll"><div class="profile-card-grid profile-card-grid--compact">`;
                items.forEach((p) => {
                    const address = p.addresses?.[0] || {};
                    const payment = p.payments?.[0] || {};
                    const state = address.state || "";
                    const city = address.city || "";
                    const maskedCard = maskCard(payment.card_number, payment.card_last4);
                    const checked = selectedProfileIds.has(String(p.id)) ? 'checked' : '';
                    html += `
                        <article class="profile-card-modern">
                            <div class="profile-card-top">
                                <label class="checkbox-inline"><input type="checkbox" data-profile-select="${p.id}" ${checked} /><span>Select</span></label>
                                <span class="badge">${escapeHTML(profileAssignedStores(p).join(", ") || groupKey)}</span>
                            </div>
                            <div class="profile-card-top">
                                <div>
                                    <h4>${escapeHTML(p.profile_name || "Unnamed Profile")}</h4>
                                    <div class="subtle-text">${escapeHTML(city)}${city && state ? ", " : ""}${escapeHTML(state || "No location set")}</div>
                                </div>
                            </div>
                            <div class="profile-detail-list">
                                <div><span>Email</span><strong>${escapeHTML(address.email || "-")}</strong></div>
                                <div><span>Phone</span><strong>${escapeHTML(address.phone || "-")}</strong></div>
                                <div><span>Card</span><strong>${escapeHTML(maskedCard)}</strong></div>
                                <div><span>Login</span><strong>${escapeHTML(groupKey === "all" ? profileAssignedStores(p).map((store) => `${store}: ${credentialStatusForStore(p, store)}`).join(" | ") : credentialStatusForStore(p, groupKey))}</strong></div>
                            </div>
                            <div class="panel-actions">
                                <button class="btn" onclick="edit('${p.id}')">Edit</button>
                                <button class="btn btn-danger" onclick="del('${p.id}')">Delete</button>
                            </div>
                        </article>
                    `;
                });
                html += `</div></div>`;
            }
            html += `</section>`;
            return html;
        };

        Object.entries(profilePanels).forEach(([groupKey, panel]) => {
            if (panel) panel.innerHTML = renderGroup(groupKey);
        });

        bindProfileDashboardControls();
        if (typeof bindRaffleBuilderControls === "function") {
            bindRaffleBuilderControls();
        }
        if (typeof bindProfileImportControls === "function") {
            bindProfileImportControls();
        }
    } catch (err) {
        console.error("Profile dashboard load failed:", err);
        const msg = escapeHTML(err?.message || "Could not connect to the server.");
        Object.values(profilePanels).forEach((panel) => {
            if (panel) panel.innerHTML = `<div class="empty-card"><p>${msg}</p></div>`;
        });
    }
}


function bindProfileDashboardControls() {
    document.querySelectorAll('[data-profile-search]').forEach((input) => {
        input.addEventListener('input', () => {
            profileGroupFilters[input.dataset.profileSearch] = input.value || '';
            loadProfiles();
        });
    });
    document.querySelectorAll('[data-profile-select]').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            const id = String(checkbox.dataset.profileSelect || '');
            if (checkbox.checked) selectedProfileIds.add(id); else selectedProfileIds.delete(id);
            loadProfiles();
        });
    });
    document.querySelectorAll('[data-profile-select-visible]').forEach((button) => {
        button.addEventListener('click', () => {
            const group = button.dataset.profileSelectVisible;
            const filterValue = String(profileGroupFilters[group] || '').trim().toLowerCase();
            allDashboardProfiles.filter((p) => profileInGroup(p, group)).forEach((p) => {
                const address = p.addresses?.[0] || {};
                const payment = p.payments?.[0] || {};
                const haystack = [p.profile_name, address.email, address.phone, address.city, address.state, payment.card_last4].join(' ').toLowerCase();
                if (!filterValue || haystack.includes(filterValue)) selectedProfileIds.add(String(p.id));
            });
            loadProfiles();
        });
    });
    document.querySelectorAll('[data-profile-delete-group]').forEach((button) => {
        button.addEventListener('click', async () => {
            const group = button.dataset.profileDeleteGroup;
            const ids = allDashboardProfiles.filter((p) => profileInGroup(p, group) && selectedProfileIds.has(String(p.id))).map((p) => String(p.id));
            if (!ids.length) return;
            if (!confirm(`Delete ${ids.length} selected ${group} profile(s)?`)) return;
            const res = await fetch(API + '/profiles/bulk', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
                body: JSON.stringify({ ids })
            });
            const data = await res.json();
            if (data.error) {
                alert(data.error);
                return;
            }
            ids.forEach((id) => selectedProfileIds.delete(String(id)));
            await loadProfiles();
        });
    });
}


function bindRaffleBuilderControls() {
    if (raffleBuilderBound) return;

    const button = document.getElementById("raffleBuilderButton");
    const emailsInput = document.getElementById("raffleBuilderEmails");
    const zipInput = document.getElementById("raffleBuilderZip");
    const message = document.getElementById("raffleBuilderMessage");

    if (!button || !emailsInput || !zipInput || !message) return;

    raffleBuilderBound = true;

    button.addEventListener("click", async () => {
        message.textContent = "";
        message.className = "form-help";

        const emails = emailsInput.value.trim();
        const zip = zipInput.value.trim();

        if (!emails) {
            message.textContent = "Add at least one email.";
            return;
        }

        if (!/^\d{5}(-\d{4})?$/.test(zip)) {
            message.textContent = "Enter a valid 5-digit ZIP code.";
            return;
        }

        button.disabled = true;
        const originalText = button.textContent;
        button.textContent = "Building...";

        try {
            const res = await fetch(API + "/profiles/raffle-builder", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + token()
                },
                body: JSON.stringify({ emails, zip })
            });

            let data = {};
            try {
                data = await res.json();
            } catch (_) {
                data = {};
            }

            if (!res.ok || data.error) {
                throw new Error(data.error || "Could not build raffle profiles.");
            }

            const created = Number(data.created_count || data.created?.length || 0);
            const skipped = Number(data.skipped_count || data.skipped?.length || 0);
            const errors = Number(data.error_count || data.errors?.length || 0);

            const firstSkipped = Array.isArray(data.skipped) && data.skipped.length ? ` First skipped: ${data.skipped[0].email || "email"} - ${data.skipped[0].reason || "duplicate"}.` : "";
            const firstError = Array.isArray(data.errors) && data.errors.length ? ` First error: ${data.errors[0].email || "email"} - ${data.errors[0].reason || "error"}.` : "";
            message.textContent = `Built ${created} raffle profile${created === 1 ? "" : "s"}. Skipped ${skipped}. Errors ${errors}.${firstSkipped}${firstError}`;
            emailsInput.value = "";

            raffleBuilderBound = false;
            await loadProfiles();
        } catch (err) {
            message.textContent = err.message || "Could not build raffle profiles.";
        } finally {
            button.disabled = false;
            button.textContent = originalText || "Build Raffle Profiles";
        }
    });
}


function bindProfileImportControls() {
    if (profileImportBound) return;
    const showButton = document.getElementById('showProfileImportButton');
    const panel = document.getElementById('profileImportPanel');
    const importButton = document.getElementById('profileImportButton');
    const fileInput = document.getElementById('profileImportFile');
    const typeSelect = document.getElementById('profileImportType');
    const message = document.getElementById('profileImportMessage');
    let reportBox = document.getElementById('profileImportReport');
    if (!reportBox && message?.parentElement) {
        reportBox = document.createElement('textarea');
        reportBox.id = 'profileImportReport';
        reportBox.className = 'input';
        reportBox.readOnly = true;
        reportBox.style.display = 'none';
        reportBox.style.marginTop = '8px';
        reportBox.style.minHeight = '160px';
        reportBox.style.whiteSpace = 'pre';
        reportBox.placeholder = 'Skipped/error profile details will appear here.';
        message.parentElement.appendChild(reportBox);
    }

    const clearImportReport = () => {
        if (!reportBox) return;
        reportBox.value = '';
        reportBox.style.display = 'none';
    };

    const profileLabelForImportIssue = (item = {}) => {
        return item.profile_name || item.name || item.email || item.id || 'Unknown profile';
    };

    const renderImportReport = (data = {}) => {
        if (!reportBox) return;
        const lines = [];
        const skipped = Array.isArray(data.skipped) ? data.skipped : [];
        const errors = Array.isArray(data.errors) ? data.errors : [];
        if (skipped.length) {
            lines.push(`Skipped profiles (${skipped.length})`);
            skipped.forEach((item, index) => {
                lines.push(`${index + 1}. ${profileLabelForImportIssue(item)} - ${item.reason || 'Skipped'}`);
            });
        }
        if (errors.length) {
            if (lines.length) lines.push('');
            lines.push(`Error profiles (${errors.length})`);
            errors.forEach((item, index) => {
                lines.push(`${index + 1}. ${profileLabelForImportIssue(item)} - ${item.reason || item.error || 'Error'}`);
            });
        }
        reportBox.value = lines.join('\n');
        reportBox.style.display = lines.length ? 'block' : 'none';
    };

    if (!fileInput || !typeSelect || !message || !importButton) return;
    profileImportBound = true;

    if (showButton && panel) {
        showButton.addEventListener('click', () => {
            const hidden = panel.style.display === 'none' || !panel.style.display;
            panel.style.display = hidden ? 'block' : 'none';
        });
    }

    const normalizeImportText = (rawText) => {
        const raw = String(rawText || '').replace(/^\uFEFF/, '').trim();
        if (!raw) throw new Error('That import file is empty.');
        if (/^<!doctype\s+html/i.test(raw) || /^<html[\s>]/i.test(raw)) {
            throw new Error('That file is an HTML page, not a profile export. Re-export the profiles and choose the profile export file directly.');
        }
        try {
            return JSON.parse(raw);
        } catch (firstError) {
            const firstArray = raw.indexOf('[');
            const firstObject = raw.indexOf('{');
            const starts = [firstArray, firstObject].filter((idx) => idx >= 0);
            const start = starts.length ? Math.min(...starts) : -1;
            const endArray = raw.lastIndexOf(']');
            const endObject = raw.lastIndexOf('}');
            const end = Math.max(endArray, endObject);
            if (start >= 0 && end > start) {
                const sliced = raw.slice(start, end + 1);
                try { return JSON.parse(sliced); } catch {}
            }
            throw new Error('That file could not be read as a profile export. Make sure you are uploading the actual export file, not a saved webpage.');
        }
    };

    const detectImportFormat = (parsed) => {
        const text = JSON.stringify(parsed || {}).slice(0, 50000).toLowerCase();
        if (text.includes('prism') || text.includes('refract')) return 'refract';
        if (text.includes('stellar')) return 'stellar';
        return 'auto';
    };

    const extractProfilesFromImport = (parsed) => {
        let profiles = [];
        if (Array.isArray(parsed)) profiles = parsed;
        else if (Array.isArray(parsed?.profiles)) profiles = parsed.profiles;
        else if (Array.isArray(parsed?.data?.profiles)) profiles = parsed.data.profiles;
        else if (Array.isArray(parsed?.profileList)) profiles = parsed.profileList;
        else if (Array.isArray(parsed?.Profiles)) profiles = parsed.Profiles;

        if (!profiles.length) throw new Error('No profiles were found in that file.');
        const detected = detectImportFormat(parsed);
        return profiles.map((profile) => ({ ...profile, import_source: detected }));
    };

    const runProfileImport = async () => {
        message.textContent = '';
        clearImportReport();
        const file = fileInput.files?.[0];
        if (!file) {
            message.textContent = 'Choose a profile export file first.';
            return;
        }
        importButton.disabled = true;
        const originalText = importButton.textContent;
        importButton.textContent = 'Importing...';
        try {
            const text = await file.text();
            const parsed = normalizeImportText(text);
            const profiles = extractProfilesFromImport(parsed);
            const importSource = profiles[0]?.import_source || 'auto';
            const res = await fetch(API + '/profiles/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
                body: JSON.stringify({ account_type: typeSelect.value, assigned_stores: [typeSelect.value], import_source: importSource, profiles })
            });
            const responseText = await res.text();
            let data = {};
            try {
                data = responseText ? JSON.parse(responseText) : {};
            } catch {
                if (responseText.trim().startsWith('<')) {
                    throw new Error('The server rejected the import before it reached the profile importer. This is usually a request-size limit.');
                }
                throw new Error(responseText || 'Could not import profiles.');
            }
            if (!res.ok || data.error) throw new Error(data.error || 'Could not import profiles.');
            const skippedCount = Number(data.skipped_count || 0);
            const errorCount = Number(data.error_count || 0);
            const detailText = skippedCount || errorCount ? ' Review the skipped/error details below.' : '';
            message.textContent = `Import complete. Imported ${data.imported_count || 0}, skipped ${skippedCount}, errors ${errorCount}.${detailText}`;
            renderImportReport(data);
            fileInput.value = '';
            await loadProfiles();
        } catch (error) {
            message.textContent = error.message || 'Could not import profiles.';
        } finally {
            importButton.disabled = false;
            importButton.textContent = originalText || 'Import Profiles';
        }
    };

    importButton.addEventListener('click', runProfileImport);
}

function createProfile() {
    localStorage.removeItem("edit");
    location = "profile.html";
}

function edit(id) {
    localStorage.edit = id;
    location = "profile.html";
}

async function del(id) {
    await fetch(API + "/profiles/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token() }
    });

    location.reload();
}

/* ================= PROFILE FORM ================= */

async function loadProfileEditor() {
    const form = document.getElementById("profileForm");
    if (!form) return;

    const refreshedUser = await refreshCurrentUserFromServer();
    const user = refreshedUser || currentUser();

    const adminButton = document.getElementById("adminPanelButtonProfile");
    if (isAdminRole(user?.role) && adminButton) {
        adminButton.style.display = "inline-block";
    }

    const accountTypeSelect = document.getElementById("account_type");
    document.querySelectorAll('input[name="assigned_stores"]').forEach((input) => {
        input.addEventListener('change', toggleAccountCredentialFields);
    });

    const editId = localStorage.getItem("edit");
    if (!editId) {
        if (!selectedStoreAssignments().length) {
            setStoreAssignments(['general']);
        }
        toggleAccountCredentialFields();
        return;
    }

    const res = await fetch(API + "/profiles", {
        headers: { Authorization: "Bearer " + token() }
    });
    const profiles = await res.json();

    if (!Array.isArray(profiles)) return;

    const profile = profiles.find((p) => p.id === editId);
    if (!profile) {
        toggleAccountCredentialFields();
        return;
    }

    const addr = profile.addresses?.[0] || {};
    const pay = profile.payments?.[0] || {};
    const account = profile.accounts?.[0] || {};

    profile_name.value = profile.profile_name || "";
    account_type.value = profile.account_type || "general";
    setStoreAssignments(profileAssignedStores(profile));
    first_name.value = addr.first_name || "";
    last_name.value = addr.last_name || "";
    email.value = addr.email || "";
    phone.value = addr.phone || "";
    address1.value = addr.address1 || "";
    city.value = addr.city || "";
    state.value = addr.state || "";
    zip.value = addr.zip || "";
    card.value = pay.card_number || "";
    exp_month.value = pay.exp_month || "";
    exp_year.value = pay.exp_year || "";
    cvv.value = pay.cvv || "";

    toggleAccountCredentialFields(profile);
}

const profileForm = document.getElementById("profileForm");
if (profileForm) {
    profileForm.onsubmit = async (e) => {
        e.preventDefault();

        const message = document.getElementById("profileMessage");
        const editId = localStorage.getItem("edit");
        const assignedStores = selectedStoreAssignments().length ? selectedStoreAssignments() : ['general'];
        if (account_type) account_type.value = assignedStores[0] || 'general';

        const storeCredentials = collectStoreCredentials(assignedStores);
        const firstCredential = Object.values(storeCredentials)[0] || {};

        const payload = {
            profile_name: profile_name.value.trim(),
            account_type: assignedStores[0] || 'general',
            assigned_stores: assignedStores,
            first_name: first_name.value.trim(),
            last_name: last_name.value.trim(),
            email: email.value.trim(),
            phone: phone.value.trim(),
            address1: address1.value.trim(),
            city: city.value.trim(),
            state: state.value,
            zip: zip.value.trim(),
            card: card.value.trim(),
            exp_month: exp_month.value.trim(),
            exp_year: exp_year.value.trim(),
            cvv: cvv.value.trim(),
            store_credentials: storeCredentials,
            account_login_email: firstCredential.login_email || "",
            account_login_password: firstCredential.login_password || "",
            gmail_app_password: firstCredential.gmail_app_password || "",
            amazon_2fa_secret: firstCredential.amazon_2fa_secret || ""
        };

        const url = editId ? API + "/profiles/" + editId : API + "/profiles";
        const method = editId ? "PUT" : "POST";

        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token()
            },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (data.error) {
            if (message) {
                message.textContent = data.error;
                message.style.color = "#b91c1c";
            }
            return;
        }

        localStorage.removeItem("edit");
        location = "dashboard.html";
    };
}

/* ================= ADMIN INVITES ================= */

function inviteStatusBadge(invite) {
    if (invite.canceled) return "Canceled";
    if (invite.used) return "Used";
    return "Active";
}

function userStatusBadge(user) {
    if (user.revoked) return "Revoked";
    return "Active";
}

function handleInviteRoleChange() {
    const roleSelect = document.getElementById("inviteRoleSelect");
    const quantitySelect = document.getElementById("inviteQuantitySelect");
    const ownerField = document.getElementById("inviteOwnerField");
    const ownerSelect = document.getElementById("inviteOwnerAdminSelect");

    if (!roleSelect || !quantitySelect) return;

    const selectedRole = roleSelect.value;
    const superAdmin = isSuperAdmin();

    if (!superAdmin && selectedRole === "admin") {
        roleSelect.value = "user";
        quantitySelect.disabled = false;
        if (ownerField) ownerField.style.display = "none";
        return;
    }

    if (selectedRole === "admin") {
        quantitySelect.value = "1";
        quantitySelect.disabled = true;
        if (ownerField) ownerField.style.display = "none";
        if (ownerSelect) ownerSelect.value = "";
    } else {
        quantitySelect.disabled = false;
        if (ownerField) ownerField.style.display = superAdmin ? "block" : "none";
    }
}

async function loadInviteOwnerAdmins() {
    const ownerSelect = document.getElementById("inviteOwnerAdminSelect");
    const ownerField = document.getElementById("inviteOwnerField");

    if (!ownerSelect || !ownerField) return;

    if (!isSuperAdmin()) {
        ownerField.style.display = "none";
        return;
    }

    try {
        const res = await fetch(API + "/admin/users?all=1&role=admin", {
            headers: { Authorization: "Bearer " + token() }
        });
        const payload = await res.json();
        const admins = Array.isArray(payload) ? payload : (payload.items || []);

        ownerSelect.innerHTML = `<option value="">My users / Super admin group</option>`;
        admins
            .filter((adminUser) => adminUser && adminUser.id && !adminUser.revoked)
            .forEach((adminUser) => {
                const option = document.createElement("option");
                option.value = adminUser.id;
                option.textContent = userDisplayName(adminUser);
                ownerSelect.appendChild(option);
            });
    } catch (err) {
        console.error("Could not load invite owner admins", err);
        ownerSelect.innerHTML = `<option value="">My users / Super admin group</option>`;
    }
}

function setupInviteControls() {
    const roleSelect = document.getElementById("inviteRoleSelect");
    const quantitySelect = document.getElementById("inviteQuantitySelect");

    if (!roleSelect || !quantitySelect) return;

    if (!isSuperAdmin()) {
        roleSelect.innerHTML = `<option value="user">User Invite</option>`;
    } else {
        loadInviteOwnerAdmins();
    }

    handleInviteRoleChange();
}

async function createInvite(inviteRole = "user", quantity = 1, ownerAdminId = "") {
    const resultBox = document.getElementById("inviteResult");
    if (!resultBox) return;

    const body = {
        invite_role: inviteRole,
        quantity
    };

    if (inviteRole === "user" && ownerAdminId) {
        body.owner_admin_id = ownerAdminId;
    }

    const res = await fetch(API + "/admin/create-invite", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token()
        },
        body: JSON.stringify(body)
    });

    const data = await res.json();

    if (data.error) {
        resultBox.innerText = data.error;
        resultBox.classList.add("error");
        return;
    }

    resultBox.classList.remove("error");

    const codes = Array.isArray(data.codes) ? data.codes : [];
    const ownerLabel = data.owner_admin_email ? ` for ${data.owner_admin_email}` : "";

    if (codes.length === 1) {
        resultBox.innerText = `${inviteRole === "admin" ? "Admin" : "User"} invite${ownerLabel} created: ${codes[0]}`;
    } else {
        resultBox.innerText = `${inviteRole === "admin" ? "Admin" : "User"} invites${ownerLabel} created: ${codes.join(", ")}`;
    }

    invitePage = 1;
    loadInvites(1);
}

async function submitInviteCreation() {
    const roleSelect = document.getElementById("inviteRoleSelect");
    const quantitySelect = document.getElementById("inviteQuantitySelect");
    const ownerSelect = document.getElementById("inviteOwnerAdminSelect");

    const inviteRole = roleSelect ? roleSelect.value : "user";
    const quantity = quantitySelect ? Number(quantitySelect.value || 1) : 1;
    const ownerAdminId = ownerSelect && inviteRole === "user" ? ownerSelect.value : "";

    return createInvite(inviteRole, quantity, ownerAdminId);
}

async function loadInvites(page = invitePage) {
    const tableBody = document.getElementById("inviteTableBody");
    const pager = document.getElementById("invitePagination");
    if (!tableBody) return;

    invitePage = 1;

    const res = await fetch(API + `/admin/invites?all=1`, {
        headers: { Authorization: "Bearer " + token() }
    });
    const payload = await res.json();

    const invites = Array.isArray(payload) ? payload : (payload.items || []);

    if (!Array.isArray(invites)) {
        tableBody.innerHTML = `Could not load invite codes.`;
        if (pager) pager.innerHTML = "";
        return;
    }

    const activeCount = invites.filter((i) => !i.used && !i.canceled).length;
    const usedCount = invites.filter((i) => i.used).length;
    const canceledCount = invites.filter((i) => i.canceled).length;

    const activeCounter = document.getElementById("activeInviteCount");
    const usedCounter = document.getElementById("usedInviteCount");
    const canceledCounter = document.getElementById("canceledInviteCount");

    if (activeCounter) activeCounter.textContent = activeCount;
    if (usedCounter) usedCounter.textContent = usedCount;
    if (canceledCounter) canceledCounter.textContent = canceledCount;

    if (invites.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7">No invite codes yet.</td></tr>`;
    } else {
        let html = "";
        invites.forEach((invite) => {
            const usedBy = invite.used_by_email || "-";
            const createdBy = invite.created_by_admin_email || "-";
            const role = invite.invite_role || "user";
            const createdAt = invite.created_at ? new Date(invite.created_at).toLocaleString() : "-";

            let actionHtml = "";
            if (!invite.used && !invite.canceled) {
                actionHtml = `
                    <button onclick="cancelInvite('${invite.id}')">Cancel</button>
                    <button onclick="deleteInvite('${invite.id}')">Delete</button>
                `;
            } else {
                actionHtml = `<button onclick="deleteInvite('${invite.id}')">Delete</button>`;
            }

            html += `
                <tr>
                    <td>${invite.code}</td>
                    <td>${role}</td>
                    <td>${createdBy}</td>
                    <td>${inviteStatusBadge(invite)}</td>
                    <td>${createdAt}</td>
                    <td>${usedBy}</td>
                    <td>${actionHtml}</td>
                </tr>
            `;
        });
        tableBody.innerHTML = html;
    }

    if (pager) {
        pager.innerHTML = "";
        pager.style.display = "none";
    }
}

async function cancelInvite(id) {
    const res = await fetch(API + "/admin/invites/" + id + "/cancel", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadInvites(invitePage);
}

async function deleteInvite(id) {
    const res = await fetch(API + "/admin/invites/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadInvites(invitePage);
}

/* ================= ADMIN FILTERS ================= */

async function loadOwnerAdminFilter() {
    const ownerFilter = document.getElementById("usersOwnerFilter");
    if (!ownerFilter) return;

    const res = await fetch(API + "/admin/admin-owners", {
        headers: { Authorization: "Bearer " + token() }
    });
    const admins = await res.json();

    if (!Array.isArray(admins)) return;

    let options = `<option value="">All Admin Owners</option>`;
    admins.forEach((a) => {
        options += `<option value="${a.id}">${a.email}</option>`;
    });

    ownerFilter.innerHTML = options;
}

function applyUserFilters() {
    usersPage = 1;
    loadUsers(1);
}

/* ================= ADMIN USERS ================= */

async function loadUsers(page = usersPage) {
    const tableBody = document.getElementById("usersTableBody");
    const pager = document.getElementById("usersPagination");
    if (!tableBody) return;

    usersPage = 1;

    const refreshedUser = await refreshCurrentUserFromServer();
    const activeUser = refreshedUser || currentUser();

    const ownerFilter = document.getElementById("usersOwnerFilter")?.value || "";
    const roleFilter = document.getElementById("usersRoleFilter")?.value || "";
    const createdAfter = document.getElementById("usersCreatedAfter")?.value || "";
    const createdBefore = document.getElementById("usersCreatedBefore")?.value || "";

    const params = new URLSearchParams();
    params.append("all", "1");

    if (ownerFilter) params.append("owner_admin_id", ownerFilter);
    if (roleFilter) params.append("role", roleFilter);
    if (createdAfter) params.append("created_after", createdAfter);
    if (createdBefore) params.append("created_before", createdBefore);

    const res = await fetch(API + "/admin/users?" + params.toString(), {
        headers: { Authorization: "Bearer " + token() }
    });
    const payload = await res.json();

    const usersData = Array.isArray(payload) ? payload : (payload.items || []);
    const totalCount = Array.isArray(payload) ? usersData.length : (payload.total || usersData.length);

    if (!Array.isArray(usersData)) {
        tableBody.innerHTML = `Could not load users.`;
        if (pager) pager.innerHTML = "";
        return;
    }

    const userCounter = document.getElementById("userCount");
    if (userCounter) {
        userCounter.textContent = totalCount;
    }

    if (usersData.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="7">No users found.</td></tr>`;
    } else {
        let html = "";
        usersData.forEach((u) => {
            let actionHtml = `No action`;

            if (u.role === "admin") {
                if (activeUser?.role === "super_admin") {
                    actionHtml = `
                        <button onclick="demoteAdmin('${u.id}', '${u.email}')">Demote</button>
                        ${u.revoked
                            ? `<button onclick="restoreUser('${u.id}')">Restore</button>`
                            : `<button onclick="revokeUser('${u.id}')">Revoke</button>`}
                        <button onclick="deleteUser('${u.id}', '${u.email}')">Delete</button>
                    `;
                }
            } else if (u.role === "user") {
                if (activeUser?.role === "super_admin") {
                    actionHtml = `
                        <button onclick="promoteUserToAdmin('${u.id}', '${u.email}')">Promote</button>
                        ${u.revoked
                            ? `<button onclick="restoreUser('${u.id}')">Restore</button>`
                            : `<button onclick="revokeUser('${u.id}')">Revoke</button>`}
                        <button onclick="deleteUser('${u.id}', '${u.email}')">Delete</button>
                    `;
                } else {
                    actionHtml = u.revoked
                        ? `<button onclick="restoreUser('${u.id}')">Restore</button> <button onclick="deleteUser('${u.id}', '${u.email}')">Delete</button>`
                        : `<button onclick="revokeUser('${u.id}')">Revoke</button> <button onclick="deleteUser('${u.id}', '${u.email}')">Delete</button>`;
                }
            }

            html += `
                <tr>
                    <td>${escapeHTML(userDisplayName(u))}</td>
                    <td>${u.role}</td>
                    <td>${escapeHTML(u.owner_admin_display || u.owner_admin_email || (u.owner_admin_id ? u.owner_admin_id : "-"))}</td>
                    <td>${u.profile_count || 0}</td>
                    <td>${userStatusBadge(u)}</td>
                    <td>${u.created_at ? new Date(u.created_at).toLocaleString() : "-"}</td>
                    <td>${actionHtml}</td>
                </tr>
            `;
        });
        tableBody.innerHTML = html;
    }

    if (pager) {
        pager.innerHTML = "";
        pager.style.display = "none";
    }
}

async function revokeUser(id) {
    const res = await fetch(API + "/admin/users/" + id + "/revoke", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadUsers(usersPage);
}

async function restoreUser(id) {
    const res = await fetch(API + "/admin/users/" + id + "/restore", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadUsers(usersPage);
}

async function promoteUserToAdmin(id, email) {
    const confirmed = confirm(`Promote user ${email} to admin?`);
    if (!confirmed) return;

    const res = await fetch(API + "/admin/users/" + id + "/promote", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadUsers(usersPage);
    loadOwnerAdminFilter();
    loadExportAccounts();
}

async function demoteAdmin(id, email) {
    const confirmed = confirm(
        `Demote admin ${email} to user? All users under this admin will be moved to the super admin account.`
    );
    if (!confirmed) return;

    const res = await fetch(API + "/admin/users/" + id + "/demote", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    });

    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadUsers(usersPage);
    loadOwnerAdminFilter();
    loadExportAccounts();
}

async function deleteUser(id, email) {
    const confirmed = confirm(`Delete account ${email}? This will also delete all profiles created by this account.`);
    if (!confirmed) return;

    const res = await fetch(API + "/admin/users/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        alert(data.error);
        return;
    }

    loadUsers(usersPage);
    loadOwnerAdminFilter();
    loadExportAccounts();
    updateExportCount();
}

/* ================= EXPORT ================= */

async function loadExportAccounts() {
    const exportUserFilter = document.getElementById("exportUserFilter");
    if (!exportUserFilter) return;

    const current = currentUser();

    try {
        const res = await fetch(API + "/admin/export/accounts", {
            headers: { Authorization: "Bearer " + token() }
        });

        const accounts = await res.json();

        if (Array.isArray(accounts)) {
            let normalized = [...accounts];

            const hasCurrentSuperAdmin =
                current &&
                current.role === "super_admin" &&
                normalized.some((u) => u.id === current.id);

            if (current && current.role === "super_admin" && !hasCurrentSuperAdmin) {
                normalized.unshift({
                    id: current.id,
                    email: current.email,
                    role: current.role
                });
            }

            const deduped = [];
            const seen = new Set();

            normalized.forEach((u) => {
                if (!u || !u.id || seen.has(u.id)) return;
                seen.add(u.id);
                deduped.push(u);
            });

            let options = `<option value="">All Accounts</option>`;
            deduped.forEach((u) => {
                options += `<option value="${u.id}">${u.email} (${u.role})</option>`;
            });
            exportUserFilter.innerHTML = options;
            updateExportCount();
            return;
        }
    } catch { }

    try {
        const res = await fetch(API + "/admin/users?page=1&limit=100", {
            headers: { Authorization: "Bearer " + token() }
        });
        const payload = await res.json();
        const users = Array.isArray(payload) ? payload : (payload.items || []);

        let normalized = users
            .filter((u) => u.role === "user" || u.role === "admin" || u.role === "super_admin");

        const hasCurrentSuperAdmin =
            current &&
            current.role === "super_admin" &&
            normalized.some((u) => u.id === current.id);

        if (current && current.role === "super_admin" && !hasCurrentSuperAdmin) {
            normalized.unshift({
                id: current.id,
                email: current.email,
                role: current.role
            });
        }

        const deduped = [];
        const seen = new Set();

        normalized.forEach((u) => {
            if (!u || !u.id || seen.has(u.id)) return;
            seen.add(u.id);
            deduped.push(u);
        });

        let options = `<option value="">All Accounts</option>`;
        deduped.forEach((u) => {
            options += `<option value="${u.id}">${u.email} (${u.role})</option>`;
        });

        exportUserFilter.innerHTML = options;
        updateExportCount();
    } catch { }
}

async function updateExportCount() {
    const banner = document.getElementById("exportCountBanner");
    const userFilter = document.getElementById("exportUserFilter");
    const groupFilter = document.getElementById("exportGroupFilter");
    if (!banner) return;

    const params = new URLSearchParams();
    const selectedUserId = userFilter?.value || "";
    const selectedGroup = groupFilter?.value || "";

    if (selectedUserId) {
        params.append("user_id", selectedUserId);
    }
    if (selectedGroup) {
        params.append("group", selectedGroup);
    }

    const url = API + "/admin/export/count" + (params.toString() ? "?" + params.toString() : "");
    const res = await fetch(url, {
        headers: { Authorization: "Bearer " + token() }
    });
    const data = await res.json();

    if (data.error) {
        banner.textContent = data.error;
        return;
    }

    const count = data.count || 0;
    const selectedUserText =
        userFilter && userFilter.selectedIndex > 0
            ? userFilter.options[userFilter.selectedIndex].text
            : "all accounts";
    const selectedGroupText = selectedGroup || "all groups";

    if (count === 1) {
        banner.textContent = `1 profile will be exported for ${selectedUserText} in ${selectedGroupText}.`;
    } else {
        banner.textContent = `${count} profiles will be exported for ${selectedUserText} in ${selectedGroupText}.`;
    }
}

function clearExportFilters() {
    const userFilter = document.getElementById("exportUserFilter");
    const groupFilter = document.getElementById("exportGroupFilter");
    if (userFilter) userFilter.value = "";
    if (groupFilter) groupFilter.value = "";
    updateExportCount();
}

async function getExportCountAndParams() {
    const userFilter = document.getElementById("exportUserFilter");
    const groupFilter = document.getElementById("exportGroupFilter");
    const banner = document.getElementById("exportCountBanner");

    const params = new URLSearchParams();
    if (userFilter && userFilter.value) {
        params.append("user_id", userFilter.value);
    }
    if (groupFilter && groupFilter.value) {
        params.append("group", groupFilter.value);
    }

    const countUrl = API + "/admin/export/count" + (params.toString() ? "?" + params.toString() : "");
    const countRes = await fetch(countUrl, {
        headers: { Authorization: "Bearer " + token() }
    });
    const countData = await countRes.json();

    if (countData.error) {
        if (banner) banner.textContent = countData.error;
        throw new Error(countData.error);
    }

    if (!countData.count) {
        if (banner) banner.textContent = "0 profiles will be exported.";
        throw new Error("No profiles match the selected filters.");
    }

    return { params, count: countData.count };
}

function promptForExportFilename(defaultName) {
    const value = prompt("Enter export file name:", defaultName);
    if (value === null) return null;
    const cleaned = value.trim().replace(/[^a-zA-Z0-9-_]/g, "");
    return cleaned || defaultName;
}

async function downloadExportFile(url, fallbackName) {
    const res = await fetch(url, {
        headers: { Authorization: "Bearer " + token() }
    });

    if (!res.ok) {
        let message = "Export failed.";
        try {
            const data = await res.json();
            if (data.error) message = data.error;
        } catch { }
        throw new Error(message);
    }

    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
}

async function exportProfilesJson() {
    try {
        const { params } = await getExportCountAndParams();
        const filename = promptForExportFilename("profiles");
        if (!filename) return;

        params.append("filename", filename);

        const url = API + "/admin/export/profiles-json" + (params.toString() ? "?" + params.toString() : "");
        await downloadExportFile(url, filename + ".json");
    } catch (err) {
        if (err.message) alert(err.message);
    }
}

async function exportProfilesStellarJson() {
    try {
        const { params } = await getExportCountAndParams();
        const filename = promptForExportFilename("stellar-profiles");
        if (!filename) return;

        params.append("filename", filename);

        const url = API + "/admin/export/profiles-stellar-json" + (params.toString() ? "?" + params.toString() : "");
        await downloadExportFile(url, filename + ".json");
    } catch (err) {
        if (err.message) alert(err.message);
    }
}


async function exportProfilesShikariCsv() {
    try {
        const { params } = await getExportCountAndParams();
        const filename = promptForExportFilename("shikari-profiles");
        if (!filename) return;

        params.append("filename", filename);

        const url = API + "/admin/export/profiles-shikari-csv" + (params.toString() ? "?" + params.toString() : "");
        await downloadExportFile(url, filename + ".csv");
    } catch (err) {
        if (err.message) alert(err.message);
    }
}

async function exportAccountsTxt() {
    try {
        const { params } = await getExportCountAndParams();
        const filename = promptForExportFilename("accounts");
        if (!filename) return;

        params.append("filename", filename);

        const url = API + "/admin/export/accounts-txt" + (params.toString() ? "?" + params.toString() : "");
        await downloadExportFile(url, filename + ".txt");
    } catch (err) {
        if (err.message) alert(err.message);
    }
}

/* ================= CHANGE PASSWORD ================= */

const passwordForm = document.getElementById("changePasswordForm");
if (passwordForm) {
    passwordForm.onsubmit = async (e) => {
        e.preventDefault();

        const res = await fetch(API + "/change-password", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token()
            },
            body: JSON.stringify({
                oldPassword: oldPassword.value,
                newPassword: newPassword.value
            })
        });

        const data = await res.json();
        const msg = document.getElementById("error");
        msg.innerText = data.error || "Password updated";
        msg.className = data.error ? "error-text" : "success-text";
    };
}



/* ================= PUBLIC COUNTDOWNS ================= */

let countdownTimerHandle = null;
window.__countdownItems = [];
window.__selectedCountdownIds = new Set();

function formatEasternTime(value) {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "numeric",
            minute: "2-digit",
            hour12: true
        }).format(new Date(value));
    } catch (_) {
        return String(value || "");
    }
}

function toEasternInputValue(value) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(new Date(value));
        const get = (type) => parts.find((p) => p.type === type)?.value || '';
        return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    } catch (_) {
        return '';
    }
}

function fromEasternInputValue(value) {
    if (!value) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toISOString();
}

function countdownSiteLabel(site) {
    const value = String(site || "general").toLowerCase();
    if (value === "supreme") return "Supreme";
    if (value === "general") return "General";
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function countdownDiffParts(target) {
    const ms = new Date(target).getTime() - Date.now();
    if (!Number.isFinite(ms)) return { done: false, text: "TBD" };
    if (ms <= 0) return { done: true, text: "Live now" };
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (days > 0) return { done: false, text: `${days}d ${hours}h ${minutes}m` };
    return { done: false, text: `${hours}h ${minutes}m ${seconds}s` };
}

function renderCountdownFeed(items) {
    document.querySelectorAll('[data-countdown-feed]').forEach((wrap) => {
        const source = Array.isArray(items) ? items : [];
        if (!source.length) {
            wrap.innerHTML = `<div class="empty-state-soft">${escapeHTML(wrap.dataset.emptyText || 'No countdowns posted yet.')}</div>`;
            return;
        }
        wrap.innerHTML = source.map((item) => {
            const diff = countdownDiffParts(item.scheduled_for);
            const selected = window.__selectedCountdownIds.has(item.id);
            const action = token() ? `<button class="btn ${selected ? '' : 'btn-primary'} countdown-select-button" type="button" data-select-countdown="${escapeHTML(item.id)}">${selected ? 'Chosen for Release' : 'Choose This Release'}</button>` : '';
            return `
                <article class="countdown-card ${selected ? 'countdown-card--selected' : ''}" data-countdown-id="${escapeHTML(item.id)}" data-countdown-at="${escapeHTML(item.scheduled_for)}">
                    <span class="countdown-site">${escapeHTML(countdownSiteLabel(item.site))}</span>
                    <h3>${escapeHTML(item.label || countdownSiteLabel(item.site))}</h3>
                    <div class="countdown-time">${escapeHTML(diff.text)}</div>
                    <div class="countdown-sub">${escapeHTML(formatEasternTime(item.scheduled_for))} ET</div>
                    ${action ? `<div class="countdown-card-actions">${action}</div>` : ''}
                </article>`;
        }).join('');
    });
    attachCountdownSelectionEvents();
}

function tickCountdownCards() {
    document.querySelectorAll('[data-countdown-at]').forEach((card) => {
        const target = card.getAttribute('data-countdown-at');
        const slot = card.querySelector('.countdown-time');
        if (!slot) return;
        slot.textContent = countdownDiffParts(target).text;
    });
}

async function exportGmailImapTxt() {
    try {
        const { params } = await getExportCountAndParams();
        const filename = promptForExportFilename("gmail-imap");
        if (!filename) return;

        params.append("filename", filename);

        const url = API + "/admin/export/gmail-imap-txt" + (params.toString() ? "?" + params.toString() : "");
        await downloadExportFile(url, filename + ".txt");
    } catch (err) {
        if (err.message) alert(err.message);
    }
}

async function loadPublicCountdowns() {
    const feeds = document.querySelectorAll('[data-countdown-feed]');
    if (!feeds.length) return;
    try {
        await loadCountdownSelections();
        const res = await fetch(API + '/public/countdowns');
        const data = await res.json();
        window.__countdownItems = Array.isArray(data.items) ? data.items : [];
        renderCountdownFeed(window.__countdownItems);
        clearInterval(countdownTimerHandle);
        countdownTimerHandle = setInterval(tickCountdownCards, 1000);
    } catch (err) {
        renderCountdownFeed([]);
    }
}

function attachCountdownSelectionEvents() {
    document.querySelectorAll('[data-select-countdown]').forEach((button) => {
        button.addEventListener('click', async () => {
            try {
                const data = await authJSON(API + '/countdowns/' + button.dataset.selectCountdown + '/select', { method: 'POST' });
                if (data.selected) window.__selectedCountdownIds.add(button.dataset.selectCountdown);
                else window.__selectedCountdownIds.delete(button.dataset.selectCountdown);
                renderCountdownFeed(window.__countdownItems);
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

async function loadCountdownSelections() {
    if (!token()) {
        window.__selectedCountdownIds = new Set();
        return;
    }
    try {
        const data = await authJSON(API + '/countdown-selections');
        window.__selectedCountdownIds = new Set(Array.isArray(data.items) ? data.items : []);
    } catch (_) {
        window.__selectedCountdownIds = new Set();
    }
}

/* ================= SKU REQUESTS / COUNTDOWN ADMIN ================= */

async function authJSON(url, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}, token() ? { Authorization: 'Bearer ' + token() } : {});
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const err = new Error(data.error || 'Request failed');
        Object.assign(err, data || {});
        throw err;
    }
    return data;
}

async function initSkuRequestForm() {
    const form = document.getElementById('skuRequestForm');
    if (!form) return;
    const siteSelect = document.getElementById('skuRequestSite');
    const skuInput = document.getElementById('skuRequestValue');
    const message = document.getElementById('skuRequestMessage');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        message.textContent = 'Submitting request...';
        try {
            const data = await authJSON(API + '/product-requests', {
                method: 'POST',
                body: JSON.stringify({ site: siteSelect.value, sku: skuInput.value,
                multiSkus: parseMultiSkuValue(skuInput.value) })
            });
            message.textContent = data.message || 'Request submitted for admin review.';
            skuInput.value = '';
            if (window.location.pathname.endsWith('dashboard.html') && typeof loadProducts === 'function') {
                try { await loadProducts(); } catch (_) { }
            }
        } catch (err) {
            message.textContent = err.message;
        }
    });
}

async function loadCountdownAdminList() {
    const wrap = document.getElementById('countdownAdminList');
    if (!wrap) return;
    try {
        const data = await authJSON(API + '/admin/countdowns');
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            wrap.innerHTML = '<div class="empty-state-soft">No countdowns yet.</div>';
            return;
        }
        wrap.innerHTML = items.map((item) => `
            <div class="stack-item">
              <div class="stack-item-meta">
                <strong>${escapeHTML(item.label || countdownSiteLabel(item.site))}</strong>
                <span class="subtle-text">${escapeHTML(countdownSiteLabel(item.site))} • ${escapeHTML(formatEasternTime(item.scheduled_for))} ET • ${escapeHTML(formatCredits(item.base_credit_cost || 0))}</span>
              </div>
              <div class="countdown-admin-actions">
                <button class="btn" type="button" data-edit-countdown="${escapeHTML(item.id)}">Edit</button>
                <button class="btn btn-danger" type="button" data-delete-countdown="${escapeHTML(item.id)}">Delete</button>
              </div>
            </div>`).join('');
        wrap.querySelectorAll('[data-edit-countdown]').forEach((button) => {
            button.addEventListener('click', () => {
                const item = items.find((entry) => entry.id === button.dataset.editCountdown);
                if (!item) return;
                document.getElementById('countdownForm').dataset.editingId = item.id;
                document.getElementById('countdownSite').value = item.site;
                document.getElementById('countdownLabel').value = item.label || '';
                document.getElementById('countdownWhen').value = toEasternInputValue(item.scheduled_for);
                document.getElementById('countdownOrder').value = item.sort_order || 0;
                document.getElementById('countdownBaseCreditCost').value = Number(item.base_credit_cost || 0);
                document.getElementById('countdownProductCredits').value = formatCountdownProductCredits(item.countdown_products || []);
                document.getElementById('countdownActive').checked = !!item.is_active;
                document.getElementById('countdownManagerMessage').textContent = 'Editing countdown.';
            });
        });
        wrap.querySelectorAll('[data-delete-countdown]').forEach((button) => {
            button.addEventListener('click', async () => {
                if (!confirm('Delete this countdown?')) return;
                try {
                    await authJSON(API + '/admin/countdowns/' + button.dataset.deleteCountdown, { method: 'DELETE' });
                    document.getElementById('countdownManagerMessage').textContent = 'Countdown deleted.';
                    await loadCountdownAdminList();
                    await loadPublicCountdowns();
                } catch (err) {
                    document.getElementById('countdownManagerMessage').textContent = err.message;
                }
            });
        });
    } catch (err) {
        wrap.innerHTML = `<div class="empty-state-soft">${escapeHTML(err.message)}</div>`;
    }
}

async function initCountdownManager() {
    const form = document.getElementById('countdownForm');
    if (!form) return;
    const message = document.getElementById('countdownManagerMessage');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = {
            site: document.getElementById('countdownSite').value,
            label: document.getElementById('countdownLabel').value,
            scheduled_for: fromEasternInputValue(document.getElementById('countdownWhen').value),
            sort_order: Number(document.getElementById('countdownOrder').value || 0),
            base_credit_cost: Number(document.getElementById('countdownBaseCreditCost').value || 0),
            countdown_products: parseCountdownProductCredits(document.getElementById('countdownProductCredits').value),
            is_active: document.getElementById('countdownActive').checked
        };
        const editingId = form.dataset.editingId;
        try {
            if (editingId) {
                await authJSON(API + '/admin/countdowns/' + editingId, { method: 'PUT', body: JSON.stringify(payload) });
                message.textContent = 'Countdown updated.';
            } else {
                await authJSON(API + '/admin/countdowns', { method: 'POST', body: JSON.stringify(payload) });
                message.textContent = 'Countdown created.';
            }
            form.reset();
            form.dataset.editingId = '';
            document.getElementById('countdownActive').checked = true;
            document.getElementById('countdownBaseCreditCost').value = 0;
            document.getElementById('countdownProductCredits').value = '';
            await loadCountdownAdminList();
            await loadPublicCountdowns();
        } catch (err) {
            message.textContent = err.message;
        }
    });
    await loadCountdownAdminList();
}

async function loadProductRequests() {
    const body = document.getElementById('productRequestsBody');
    if (!body) return;
    const superAdmin = canManageCatalog();
    try {
        const data = await authJSON(API + '/admin/product-requests');
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            body.innerHTML = '<tr><td colspan="7">No requests yet.</td></tr>';
            return;
        }
        body.innerHTML = items.map((item) => {
            const actions = superAdmin
                ? `<button class="btn btn-primary" type="button" data-approve-request="${escapeHTML(item.id)}">Approve</button>
                   <button class="btn" type="button" data-reject-request="${escapeHTML(item.id)}">Reject</button>
                   <button class="btn btn-danger" type="button" data-delete-request="${escapeHTML(item.id)}">Delete</button>`
                : '<span class="subtle-text">Super admin approval only</span>';
            return `
            <tr>
              <td>${escapeHTML(item.user_email || '-')}</td>
              <td>${escapeHTML(item.site)}</td>
              <td>${escapeHTML(item.sku)}</td>
              <td>${escapeHTML(item.status || '-')}</td>
              <td>${escapeHTML(item.product_name || '-')} ${item.default_max_price !== null && item.default_max_price !== undefined ? `(${escapeHTML(formatMoney(item.default_max_price))})` : ''}</td>
              <td>${escapeHTML(formatEasternTime(item.updated_at || item.created_at))} ET</td>
              <td class="table-actions">${actions}</td>
            </tr>`;
        }).join('');
        if (!superAdmin) return;
        body.querySelectorAll('[data-approve-request]').forEach((button) => {
            button.addEventListener('click', async () => {
                try {
                    const data = await authJSON(API + '/admin/product-requests/' + button.dataset.approveRequest + '/approve', { method: 'POST' });
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = data.message || 'Request approved.';
                    await loadProductRequests();
                    await loadCatalogProducts();
                } catch (err) {
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = err.message;
                }
            });
        });
        body.querySelectorAll('[data-reject-request]').forEach((button) => {
            button.addEventListener('click', async () => {
                try {
                    const data = await authJSON(API + '/admin/product-requests/' + button.dataset.rejectRequest + '/reject', { method: 'POST' });
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = data.message || 'Request rejected.';
                    await loadProductRequests();
                } catch (err) {
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = err.message;
                }
            });
        });
        body.querySelectorAll('[data-delete-request]').forEach((button) => {
            button.addEventListener('click', async () => {
                if (!confirm('Delete this request?')) return;
                try {
                    const data = await authJSON(API + '/admin/product-requests/' + button.dataset.deleteRequest, { method: 'DELETE' });
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = data.message || 'Request deleted.';
                    await loadProductRequests();
                } catch (err) {
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = err.message;
                }
            });
        });
    } catch (err) {
        body.innerHTML = `<tr><td colspan="7">${escapeHTML(err.message)}</td></tr>`;
    }
}

async function loadCatalogProducts() {
    const body = document.getElementById('catalogProductsBody');
    if (!body) return;
    const site = document.getElementById('catalogFilterSite')?.value || '';
    const search = document.getElementById('catalogFilterSearch')?.value || '';
    const superAdmin = canManageCatalog();
    try {
        const qs = new URLSearchParams();
        if (site) qs.set('site', site);
        if (search) qs.set('search', search);
        const data = await authJSON(API + '/admin/catalog-products?' + qs.toString());
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            body.innerHTML = '<tr><td colspan="6">No catalog products found.</td></tr>';
            return;
        }
        body.innerHTML = items.map((item) => `
            <tr>
              <td>${escapeHTML(item.site)}</td>
              <td>${escapeHTML(item.sku || '-')}</td>
              <td>${escapeHTML(item.product_name || '-')}</td>
              <td>${escapeHTML(formatMoney(item.default_max_price))} / ${escapeHTML(formatCredits(item.credit_cost || 0))}</td>
              <td>${item.metadata && item.metadata.virtual ? 'Virtual' : 'Live'}</td>
              <td>${superAdmin ? `<div class="table-actions"><button class="btn" type="button" data-edit-catalog-product="${escapeHTML(item.id)}" data-edit-catalog-name="${escapeHTML(item.product_name || '')}" data-edit-catalog-price="${item.default_max_price ?? ''}" data-edit-catalog-credits="${item.credit_cost ?? 0}">Edit</button><button class="btn btn-danger" type="button" data-delete-catalog-product="${escapeHTML(item.id)}">Delete</button></div>` : '<span class="subtle-text">Super admin only</span>'}</td>
            </tr>`).join('');
        if (!superAdmin) return;
        body.querySelectorAll('[data-edit-catalog-product]').forEach((button) => {
            button.addEventListener('click', async () => {
                const currentCredits = button.dataset.editCatalogCredits ?? '0';
                const currentPrice = button.dataset.editCatalogPrice ?? '';
                const nextCredits = window.prompt('Set product credit cost', currentCredits);
                if (nextCredits === null) return;
                const nextPrice = window.prompt('Set max price (leave blank for no max price)', currentPrice);
                if (nextPrice === null) return;
                const nextName = window.prompt('Edit product name', button.dataset.editCatalogName || '');
                if (nextName === null) return;
                try {
                    const data = await authJSON(API + '/admin/catalog-products/' + button.dataset.editCatalogProduct, {
                        method: 'PATCH',
                        body: JSON.stringify({
                            credit_cost: nextCredits,
                            default_max_price: nextPrice,
                            product_name: nextName
                        })
                    });
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = data.message || 'Product updated.';
                    await loadCatalogProducts();
                } catch (err) {
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = err.message;
                }
            });
        });
        body.querySelectorAll('[data-delete-catalog-product]').forEach((button) => {
            button.addEventListener('click', async () => {
                if (!confirm('Delete this product?')) return;
                try {
                    const data = await authJSON(API + '/admin/catalog-products/' + button.dataset.deleteCatalogProduct, { method: 'DELETE' });
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = data.message || 'Product deleted.';
                    await loadCatalogProducts();
                } catch (err) {
                    const msg = document.getElementById('adminSkuMessage');
                    if (msg) msg.textContent = err.message;
                }
            });
        });
    } catch (err) {
        body.innerHTML = `<tr><td colspan="6">${escapeHTML(err.message)}</td></tr>`;
    }
}

async function initCatalogTools() {
    const form = document.getElementById('adminSkuUpsertForm');
    const manualForm = document.getElementById('adminManualProductForm');
    const message = document.getElementById('adminSkuMessage');
    const syncButton = document.getElementById('syncTargetPricingButton');
    const filterSite = document.getElementById('catalogFilterSite');
    const filterSearch = document.getElementById('catalogFilterSearch');
    const filterButton = document.getElementById('catalogFilterButton');
    const controls = document.getElementById('superAdminCatalogControls');
    const notice = document.getElementById('superAdminCatalogNotice');
    const bulkImportForm = document.getElementById('catalogBulkImportForm');
    const exportForm = document.getElementById('catalogExportForm');
    const exportResults = document.getElementById('catalogExportResults');
    const superAdmin = canManageCatalog();
    if (controls) controls.style.display = superAdmin ? 'block' : 'none';
    if (notice) notice.style.display = superAdmin ? 'none' : 'block';
    if (form && superAdmin) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            message.textContent = 'Adding product...';
            try {
                const data = await authJSON(API + '/admin/catalog-products/upsert-by-sku', {
                    method: 'POST',
                    body: JSON.stringify({
                        site: document.getElementById('adminSkuSite').value,
                        sku: document.getElementById('adminSkuValue').value
                    })
                });
                message.textContent = data.message || 'Product added.';
                document.getElementById('adminSkuValue').value = '';
                await loadCatalogProducts();
                await loadProductRequests();
            } catch (err) {
                message.textContent = err.message;
            }
        });
    }
    if (manualForm && superAdmin) {
        manualForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            message.textContent = 'Saving manual product...';
            try {
                const data = await authJSON(API + '/admin/catalog-products/manual', {
                    method: 'POST',
                    body: JSON.stringify({
                        site: document.getElementById('manualProductSite').value,
                        sku: document.getElementById('manualProductSku').value,
                        product_name: document.getElementById('manualProductName').value,
                        default_max_price: document.getElementById('manualProductPrice').value,
                        credit_cost: document.getElementById('manualProductCreditCost').value,
                        brand: document.getElementById('manualProductBrand').value,
                        image_url: document.getElementById('manualProductImage').value,
                        product_url: document.getElementById('manualProductUrl').value,
                        is_placeholder: document.getElementById('manualProductPlaceholder').checked
                    })
                });
                message.textContent = data.message || 'Manual product saved.';
                manualForm.reset();
                await loadCatalogProducts();
            } catch (err) {
                message.textContent = err.message;
            }
        });
    }

    if (bulkImportForm && superAdmin) {
        bulkImportForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            message.textContent = 'Importing product list...';
            try {
                const file = document.getElementById('catalogBulkImportFile').files[0];
                if (!file) throw new Error('Choose a JSON file to import.');
                const text = await file.text();
                const parsed = JSON.parse(text);
                const products = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.products) ? parsed.products : []);
                if (!products.length) throw new Error('No products were found in the imported file.');
                const data = await authJSON(API + '/admin/catalog-products/import-list', {
                    method: 'POST',
                    body: JSON.stringify({
                        site: document.getElementById('catalogBulkImportSite').value,
                        products
                    })
                });
                message.textContent = data.message || `Imported ${data.imported || 0} products.`;
                bulkImportForm.reset();
                await loadCatalogProducts();
            } catch (err) {
                message.textContent = err.message;
            }
        });
    }
    if (exportForm) {
        exportForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const format = event.submitter?.dataset?.catalogExportFormat || 'stellar';
            if (exportResults) exportResults.innerHTML = '<div class="subtle-text">Building export batches...</div>';
            try {
                const site = document.getElementById('catalogExportSite').value;
                const batchSize = document.getElementById('catalogExportBatchSize').value || '29';
                const qs = new URLSearchParams({ site, batchSize });
                const data = await authJSON(API + '/admin/catalog-products/export-lines?' + qs.toString());
                let batches = Array.isArray(data.batches) ? data.batches : [];
                if (format === 'shikari') {
                    batches = batches.map((batch) => {
                        const skus = String(batch.text || '')
                            .split(/\n+/)
                            .map((line) => line.split(';')[0].trim())
                            .filter(Boolean);
                        return { ...batch, text: skus.join(', '), count: skus.length };
                    });
                }
                if (!batches.length) {
                    if (exportResults) exportResults.innerHTML = '<div class="subtle-text">No products found to export.</div>';
                    return;
                }
                if (exportResults) {
                    exportResults.innerHTML = batches.map((batch, idx) => {
                        const title = format === 'shikari' ? `${site.toUpperCase()} Shikari Batch ${batch.index}` : `${site.toUpperCase()} Stellar Batch ${batch.index}`;
                        return `
                        <section class="panel panel--inner">
                          <div class="panel-header"><div><h3>${escapeHTML(title)}</h3><p class="subtle-text">${batch.count} SKU${batch.count === 1 ? '' : 's'}</p></div><div class="panel-actions"><button class="btn" type="button" data-copy-catalog-export="${idx}">Copy Batch</button></div></div>
                          <textarea class="input" rows="${format === 'shikari' ? 4 : Math.min(14, Math.max(6, batch.count + 1))}" readonly>${escapeHTML(batch.text)}</textarea>
                        </section>`;
                    }).join('');
                    exportResults.querySelectorAll('[data-copy-catalog-export]').forEach((button) => {
                        button.addEventListener('click', async () => {
                            const batch = batches[Number(button.dataset.copyCatalogExport)];
                            await copyTextToClipboard(batch?.text || '');
                            button.textContent = 'Copied';
                            setTimeout(() => { button.textContent = 'Copy Batch'; }, 1200);
                        });
                    });
                }
            } catch (err) {
                if (exportResults) exportResults.innerHTML = `<div class="subtle-text">${escapeHTML(err.message)}</div>`;
            }
        });
    }

    if (syncButton && superAdmin) {
        syncButton.addEventListener('click', async () => {
            message.textContent = 'Syncing target pricing...';
            try {
                const data = await authJSON(API + '/admin/catalog-products/sync-target-pricing', { method: 'POST' });
                message.textContent = data.message || `Updated ${data.updated || 0} target prices.`;
                await loadCatalogProducts();
            } catch (err) {
                message.textContent = err.message;
            }
        });
    }
    if (filterButton) filterButton.addEventListener('click', loadCatalogProducts);
    if (filterSite) filterSite.addEventListener('change', loadCatalogProducts);
    if (filterSearch) filterSearch.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadCatalogProducts(); } });
    await loadProductRequests();
    await loadCatalogProducts();
}


function initAdminSidebar() {
    const buttons = document.querySelectorAll('[data-admin-nav]');
    const panes = document.querySelectorAll('[data-admin-pane]');
    if (!buttons.length || !panes.length) return;

    function activate(name) {
        buttons.forEach((button) => button.classList.toggle('is-active', button.dataset.adminNav === name));
        panes.forEach((pane) => pane.classList.toggle('is-active', pane.dataset.adminPane === name));
    }

    buttons.forEach((button) => {
        button.addEventListener('click', () => activate(button.dataset.adminNav));
    });

    const active = document.querySelector('[data-admin-nav].is-active')?.dataset.adminNav || buttons[0].dataset.adminNav;
    activate(active);
}


async function loadAnnouncementSettings() {
    const input = document.getElementById('announcementWebhookUrl');
    const pingMode = document.getElementById('announcementPingMode');
    const roleMention = document.getElementById('announcementRoleMention');
    if (!input || !token()) return;
    const msg = document.getElementById('announcementSettingsMessage');
    try {
        const data = await authJSON(API + '/admin/announcements/settings');
        input.value = data.announcement_webhook_url || '';
        if (pingMode) pingMode.value = data.announcement_ping_mode || 'none';
        if (roleMention) roleMention.value = data.announcement_role_mention || '';
        const panel = document.getElementById('superAdminAnnouncementPanel');
        if (panel) panel.style.display = data.is_super_admin ? '' : 'none';
        if (msg) msg.textContent = data.announcement_webhook_url ? 'Announcement webhook loaded.' : 'No announcement webhook saved yet.';
    } catch (err) {
        if (msg) msg.textContent = err.message || 'Failed to load announcement settings.';
    }
}

async function saveAnnouncementWebhookSettings() {
    const input = document.getElementById('announcementWebhookUrl');
    const pingMode = document.getElementById('announcementPingMode');
    const roleMention = document.getElementById('announcementRoleMention');
    const msg = document.getElementById('announcementSettingsMessage');
    if (!input) return;
    try {
        if (msg) msg.textContent = 'Saving announcement webhook...';
        await authJSON(API + '/admin/announcements/settings', {
            method: 'POST',
            body: JSON.stringify({
                announcement_webhook_url: input.value || '',
                announcement_ping_mode: pingMode ? pingMode.value : 'none',
                announcement_role_mention: roleMention ? roleMention.value : ''
            })
        });
        if (msg) msg.textContent = 'Announcement webhook saved.';
    } catch (err) {
        if (msg) msg.textContent = err.message || 'Failed to save announcement webhook.';
    }
}

async function sendAnnouncementMessage() {
    const input = document.getElementById('announcementMessageText');
    const msg = document.getElementById('announcementSendMessage');
    const message = String(input?.value || '').trim();
    if (!message) {
        if (msg) msg.textContent = 'Type an announcement message first.';
        return;
    }
    try {
        if (msg) msg.textContent = 'Sending announcement...';
        const data = await authJSON(API + '/admin/announcements/send', {
            method: 'POST',
            body: JSON.stringify({ message })
        });
        if (msg) msg.textContent = `Announcement sent to ${data.sent || 0} webhook(s). ${data.failed || 0} failed.`;
        if (input) input.value = '';
    } catch (err) {
        if (msg) msg.textContent = err.message || 'Failed to send announcement.';
    }
}

async function sendAnnouncementCatalogUpdate() {
    const msg = document.getElementById('announcementSendMessage');
    try {
        if (msg) msg.textContent = 'Sending catalog update...';
        const data = await authJSON(API + '/admin/announcements/catalog-update/send', { method: 'POST' });
        if (msg) msg.textContent = `Catalog update sent to ${data.sent || 0} webhook(s). ${data.product_count || 0} new product(s). ${data.failed || 0} failed.`;
    } catch (err) {
        if (msg) msg.textContent = err.message || 'Failed to send catalog update.';
    }
}

/* ================= PAGE LOAD ================= */


async function loadCreditsBalance() {
    const stat = document.getElementById('creditsBalanceStat');
    if (!stat || !token()) return;
    try {
        const data = await authJSON(API + '/credits/me');
        stat.textContent = Number(data.balance || 0);
        const help = document.getElementById('creditsBalanceHelp');
        if (help) help.textContent = 'Available to spend';
        const current = currentUser() || {};
        current.credits_balance = Number(data.balance || 0);
        localStorage.user = JSON.stringify(current);
    } catch (err) {
        const msg = document.getElementById('creditsPurchaseMessage');
        if (msg) msg.textContent = err.message;
    }
}

async function promptBuyCredits() {
    const amountText = window.prompt('How many credits would you like to buy? $1 = 1 credit', '25');
    if (amountText === null) return;
    const credits = Math.round(Number(amountText || 0));
    const msg = document.getElementById('creditsPurchaseMessage');
    if (!Number.isFinite(credits) || credits <= 0) {
        if (msg) msg.textContent = 'Enter a valid credit amount.';
        return;
    }
    try {
        if (msg) msg.textContent = 'Opening Stripe checkout...';
        const data = await authJSON(API + '/billing/create-checkout-session', { method: 'POST', body: JSON.stringify({ credits }) });
        if (data.url) {
            window.location.href = data.url;
            return;
        }
        if (msg) msg.textContent = 'Stripe checkout URL was not returned.';
    } catch (err) {
        if (msg) msg.textContent = err.message;
        else alert(err.message);
    }
}


async function startCreditPurchase(credits) {
    const msg = document.getElementById('creditsPurchaseMessage');
    if (!Number.isFinite(Number(credits)) || Number(credits) <= 0) {
        if (msg) msg.textContent = 'Enter a valid credit amount.';
        return;
    }
    try {
        if (msg) msg.textContent = 'Opening Stripe checkout...';
        const data = await authJSON(API + '/billing/create-checkout-session', { method: 'POST', body: JSON.stringify({ credits: Math.round(Number(credits)) }) });
        if (data.url) {
            window.location.href = data.url;
            return;
        }
        if (msg) msg.textContent = 'Stripe checkout URL was not returned.';
    } catch (err) {
        if (msg) msg.textContent = err.message;
        else alert(err.message);
    }
}

function purchasePresetCredits(credits) {
    startCreditPurchase(credits);
}

function purchaseCustomCredits() {
    const input = document.getElementById('customCreditsAmount');
    startCreditPurchase(input ? input.value : 0);
}


function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function resendWebhookLog(id, button) {
    if (!id) return;
    const originalText = button ? button.textContent : '';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'Sending...';
        }
        const data = await authJSON(API + `/admin/webhooks/logs/${encodeURIComponent(id)}/resend`, { method: 'POST' });
        alert('Webhook resent to Discord. Check the Discord target details/logs for delivery status.');
        await loadWebhookLogs();
        return data;
    } catch (err) {
        alert(err.message || 'Failed to resend webhook.');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || 'Resend to Discord';
        }
    }
}

async function recheckWebhookCredits(id, button) {
    if (!id) return;
    const originalText = button ? button.textContent : '';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'Checking...';
        }
        const data = await authJSON(API + `/admin/webhooks/logs/${encodeURIComponent(id)}/recheck-credits`, { method: 'POST' });
        const charged = Number(data.chargedNow || 0);
        alert(charged > 0
            ? `Credit recheck charged ${charged} missing credits. Correct total: ${data.expectedCredits}.`
            : `Credit recheck OK. Already charged ${data.existingCredits} credits.`);
        await loadWebhookLogs();
        return data;
    } catch (err) {
        alert(err.message || 'Failed to recheck credits.');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || 'Recheck Credits';
        }
    }
}



function buildOrderRecheckDebugLinks(artifacts) {
    const debugToken = encodeURIComponent(localStorage.token || '');
    if (!Array.isArray(artifacts)) return [];
    return artifacts
        .filter((a) => a && a.url)
        .map((a) => {
            const rawUrl = String(a.url || '');
            const sep = rawUrl.includes('?') ? '&' : '?';
            return {
                label: a.label || a.type || 'Debug file',
                url: `${API}${rawUrl}${sep}token=${debugToken}`
            };
        });
}

function showOrderRecheckResult(title, message, artifacts) {
    const links = buildOrderRecheckDebugLinks(artifacts);
    const existing = document.getElementById('orderRecheckResultOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'orderRecheckResultOverlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = 'rgba(15, 23, 42, 0.55)';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '24px';

    const modal = document.createElement('div');
    modal.style.width = 'min(760px, 96vw)';
    modal.style.maxHeight = '86vh';
    modal.style.overflow = 'auto';
    modal.style.background = '#fff';
    modal.style.borderRadius = '16px';
    modal.style.boxShadow = '0 24px 80px rgba(15, 23, 42, 0.35)';
    modal.style.padding = '22px';
    modal.style.fontFamily = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '16px';

    const h = document.createElement('h3');
    h.textContent = title || 'Order recheck result';
    h.style.margin = '0';
    h.style.fontSize = '18px';

    const close = document.createElement('button');
    close.textContent = 'Close';
    close.type = 'button';
    close.style.border = '1px solid #cbd5e1';
    close.style.borderRadius = '10px';
    close.style.background = '#f8fafc';
    close.style.padding = '8px 12px';
    close.style.cursor = 'pointer';
    close.onclick = () => overlay.remove();

    header.appendChild(h);
    header.appendChild(close);
    modal.appendChild(header);

    const body = document.createElement('p');
    body.textContent = message || '';
    body.style.whiteSpace = 'pre-wrap';
    body.style.lineHeight = '1.45';
    body.style.margin = '16px 0';
    modal.appendChild(body);

    if (links.length) {
        const label = document.createElement('div');
        label.textContent = 'Debug files';
        label.style.fontWeight = '700';
        label.style.margin = '12px 0 8px';
        modal.appendChild(label);

        const list = document.createElement('div');
        list.style.display = 'grid';
        list.style.gap = '8px';

        links.forEach((item) => {
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.gap = '10px';
            row.style.border = '1px solid #e2e8f0';
            row.style.borderRadius = '10px';
            row.style.padding = '10px 12px';

            const a = document.createElement('a');
            a.href = item.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = item.label;
            a.style.color = '#2563eb';
            a.style.fontWeight = '600';
            a.style.textDecoration = 'none';

            const copy = document.createElement('button');
            copy.type = 'button';
            copy.textContent = 'Copy link';
            copy.style.border = '1px solid #cbd5e1';
            copy.style.borderRadius = '8px';
            copy.style.background = '#fff';
            copy.style.padding = '6px 10px';
            copy.style.cursor = 'pointer';
            copy.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(item.url);
                    copy.textContent = 'Copied';
                    setTimeout(() => { copy.textContent = 'Copy link'; }, 1400);
                } catch (_) {
                    window.prompt('Copy this debug link:', item.url);
                }
            };

            row.appendChild(a);
            row.appendChild(copy);
            list.appendChild(row);
        });

        modal.appendChild(list);
    }

    const hint = document.createElement('p');
    hint.textContent = 'Tip: open the live log first, then run another order check to watch each step update.';
    hint.style.fontSize = '13px';
    hint.style.color = '#64748b';
    hint.style.margin = '14px 0 0';
    modal.appendChild(hint);

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) overlay.remove();
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}


async function recheckOrderItem(id, button) {
    if (!id) return;
    const original = button ? button.textContent : '';
    if (button) {
        button.disabled = true;
        button.textContent = 'Checking item...';
    }
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 150000);
        const data = await authJSON(API + `/admin/orders/${encodeURIComponent(id)}/recheck-item`, { method: 'POST', signal: controller.signal });
        clearTimeout(timeout);
        showOrderRecheckResult('Order recheck completed', data.message || 'Order item recheck completed.', data.artifacts);
        await loadCreditsAdminPane();
    } catch (err) {
        showOrderRecheckResult('Order recheck failed', err.message || 'Order item recheck failed.', err.artifacts);
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = original || 'Check Order For Item';
        }
    }
}

async function recheckOrderCredits(id, button) {
    if (!id) return;
    const originalText = button ? button.textContent : '';
    try {
        if (button) {
            button.disabled = true;
            button.textContent = 'Checking...';
        }
        const data = await authJSON(API + `/admin/orders/${encodeURIComponent(id)}/recheck-credits`, { method: 'POST' });
        const charged = Number(data.chargedNow || 0);
        alert(charged > 0
            ? `Credit recheck charged ${charged} missing credits. Correct total: ${data.expectedCredits}.`
            : `Credit recheck OK. Already charged ${data.existingCredits} credits. No charge was made.`);
        await loadCreditsAdminPane();
        try { await loadWebhookLogs(); } catch (_) {}
        return data;
    } catch (err) {
        alert(err.message || 'Failed to recheck credits.');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText || 'Recheck Credits';
        }
    }
}

async function loadWebhookLogs() {
    const container = document.getElementById('webhookLogs');
    if (!container) return;
    try {
        container.textContent = 'Loading webhook logs...';
        const typeFilter = document.getElementById('webhookLogTypeFilter')?.value || '';
        const siteFilter = document.getElementById('webhookLogSiteFilter')?.value || '';
        const params = new URLSearchParams();
        if (typeFilter) params.set('type', typeFilter);
        if (siteFilter) params.set('site', siteFilter);
        params.set('limit', '500');
        const data = await authJSON(API + '/admin/webhooks/logs?' + params.toString());
        const items = Array.isArray(data.items) ? data.items : [];
        if (!items.length) {
            container.innerHTML = '<div class="subtle-text">No webhook events yet.</div>';
            return;
        }
        const rows = items.map((item) => {
            const parsed = Array.isArray(item.parsed_items) ? item.parsed_items : [];
            const targets = Array.isArray(item.discord_targets) ? item.discord_targets : [];
            const details = parsed.length
              ? `<details><summary>Parsed items (${parsed.length})</summary><pre style="white-space:pre-wrap;max-width:480px;">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre></details>`
              : '';
            const targetDetails = targets.length
              ? `<details><summary>Discord targets (${targets.length})</summary><pre style="white-space:pre-wrap;max-width:420px;">${escapeHtml(JSON.stringify(targets, null, 2))}</pre></details>`
              : '';
            const payloadDetails = item.payload
              ? `<details><summary>Raw payload</summary><pre style="white-space:pre-wrap;max-width:520px;">${escapeHtml(JSON.stringify(item.payload, null, 2))}</pre></details>`
              : '';
            const userLabel = item.user_display || item.user_email || '-';
            const creditsLabel = (item.type === 'checkout') ? String(item.credits_charged ?? 0) : '-';
            return `
            <tr>
              <td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td>
              <td>${escapeHtml(item.type || '-')}</td>
              <td>${escapeHtml(item.status || '-')}</td>
              <td>${escapeHtml(item.site || '-')}</td>
              <td>${escapeHtml(userLabel)}</td>
              <td>${escapeHtml(creditsLabel)}</td>
              <td>${escapeHtml(item.product_type || '-')}</td>
              <td style="max-width:280px;word-break:break-word;">${escapeHtml(item.product || '-')}</td>
              <td>${escapeHtml(item.sku || '-')}</td>
              <td style="max-width:360px;word-break:break-word;">${escapeHtml(item.error || '')}${details}${targetDetails}${payloadDetails}</td>
              <td><div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="secondary" type="button" onclick="resendWebhookLog('${escapeHtml(item.id || '')}', this)">Resend to Discord</button><button class="secondary" type="button" onclick="recheckWebhookCredits('${escapeHtml(item.id || '')}', this)">Recheck Credits</button></div></td>
            </tr>`;
        }).join('');
        container.innerHTML = `
            <div style="overflow:auto;">
              <table class="admin-table">
                <thead><tr><th>Time</th><th>Type</th><th>Status</th><th>Site</th><th>User</th><th>Credits</th><th>Product Type</th><th>Product</th><th>SKU</th><th>Error / Debug</th><th>Actions</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>`;
    } catch (err) {
        container.textContent = err.message || 'Failed to load webhook logs.';
    }
}

async function loadWebhookSettings() {
    const urlInput = document.getElementById('websiteWebhookUrl');
    const monitorUrlInput = document.getElementById('monitorWebhookUrl');
    const discordInput = document.getElementById('discordRelayWebhookUrl');
    const adminDiscordInput = document.getElementById('adminDiscordRelayWebhookUrl');
    const errorDiscordInput = document.getElementById('checkoutErrorWebhookUrl');
    const adminErrorDiscordInput = document.getElementById('adminErrorDiscordRelayWebhookUrl');
    const adminBrandInput = document.getElementById('adminBrandLabel');
    const message = document.getElementById('webhookSettingsMessage');
    const createButton = document.getElementById('createWebhookButton');
    const createMonitorButton = document.getElementById('createMonitorWebhookButton');
    const superAdminField = document.getElementById('superAdminDiscordField');
    const monitorDedupeWindowInput = document.getElementById('monitorDedupeWindowSeconds');
    const superAdminMonitorGroups = document.getElementById('superAdminMonitorGroups');
    const adminMonitorGroupsSection = document.getElementById('adminMonitorGroupsSection');

    const monitorInputs = {
        pokemon: {
            webhook_url: document.getElementById('monitorPokemon'),
            ping_mode: document.getElementById('monitorPokemonPingMode'),
            role_mention: document.getElementById('monitorPokemonRole')
        },
        onepiece: {
            webhook_url: document.getElementById('monitorOnePiece'),
            ping_mode: document.getElementById('monitorOnePiecePingMode'),
            role_mention: document.getElementById('monitorOnePieceRole')
        },
        sports: {
            webhook_url: document.getElementById('monitorSports'),
            ping_mode: document.getElementById('monitorSportsPingMode'),
            role_mention: document.getElementById('monitorSportsRole')
        },
        othertcg: {
            webhook_url: document.getElementById('monitorOtherTcg'),
            ping_mode: document.getElementById('monitorOtherTcgPingMode'),
            role_mention: document.getElementById('monitorOtherTcgRole')
        },
        lowkey: {
            webhook_url: document.getElementById('monitorLowkey'),
            ping_mode: document.getElementById('monitorLowkeyPingMode'),
            role_mention: document.getElementById('monitorLowkeyRole')
        }
    };


    const adminMonitorInputs = {
        pokemon: {
            webhook_url: document.getElementById('adminMonitorPokemon'),
            ping_mode: document.getElementById('adminMonitorPokemonPingMode'),
            role_mention: document.getElementById('adminMonitorPokemonRole')
        },
        onepiece: {
            webhook_url: document.getElementById('adminMonitorOnePiece'),
            ping_mode: document.getElementById('adminMonitorOnePiecePingMode'),
            role_mention: document.getElementById('adminMonitorOnePieceRole')
        },
        sports: {
            webhook_url: document.getElementById('adminMonitorSports'),
            ping_mode: document.getElementById('adminMonitorSportsPingMode'),
            role_mention: document.getElementById('adminMonitorSportsRole')
        },
        othertcg: {
            webhook_url: document.getElementById('adminMonitorOtherTcg'),
            ping_mode: document.getElementById('adminMonitorOtherTcgPingMode'),
            role_mention: document.getElementById('adminMonitorOtherTcgRole')
        },
        lowkey: {
            webhook_url: document.getElementById('adminMonitorLowkey'),
            ping_mode: document.getElementById('adminMonitorLowkeyPingMode'),
            role_mention: document.getElementById('adminMonitorLowkeyRole')
        }
    };
    if (!urlInput) return;

    try {
        const data = await authJSON(API + '/admin/webhooks/settings');
        urlInput.value = data.inbound_webhook_url || '';
        if (monitorUrlInput) monitorUrlInput.value = data.monitor_webhook_url || '';
        if (discordInput) discordInput.value = data.discord_webhook_url || '';
        if (errorDiscordInput) errorDiscordInput.value = data.checkout_error_webhook_url || '';
        if (adminDiscordInput) adminDiscordInput.value = data.admin_discord_webhook_url || '';
        if (adminErrorDiscordInput) adminErrorDiscordInput.value = data.admin_error_discord_webhook_url || '';
        if (monitorDedupeWindowInput) monitorDedupeWindowInput.value = String(data.monitor_dedupe_window_seconds ?? 90);
        if (adminBrandInput) adminBrandInput.value = data.admin_brand_label || '';

        const monitorSettings = data.monitor_groups || {};
        Object.entries(monitorInputs).forEach(([key, inputs]) => {
            const raw = monitorSettings[key] || '';
            const cfg = typeof raw === 'string' ? { webhook_url: raw, ping_mode: 'none', role_mention: '' } : (raw || {});
            if (inputs.webhook_url) inputs.webhook_url.value = cfg.webhook_url || '';
            if (inputs.ping_mode) inputs.ping_mode.value = cfg.ping_mode || 'none';
            if (inputs.role_mention) inputs.role_mention.value = cfg.role_mention || '';
        });
        const adminMonitorSettings = data.admin_monitor_groups || {};
        Object.entries(adminMonitorInputs).forEach(([key, inputs]) => {
            const raw = adminMonitorSettings[key] || '';
            const cfg = typeof raw === 'string' ? { webhook_url: raw, ping_mode: 'none', role_mention: '' } : (raw || {});
            if (inputs.webhook_url) inputs.webhook_url.value = cfg.webhook_url || '';
            if (inputs.ping_mode) inputs.ping_mode.value = cfg.ping_mode || 'none';
            if (inputs.role_mention) inputs.role_mention.value = cfg.role_mention || '';
        });

        if (createButton) createButton.style.display = data.can_create_inbound ? '' : 'none';
        if (createMonitorButton) createMonitorButton.style.display = data.can_create_inbound ? '' : 'none';
        if (superAdminField) superAdminField.style.display = data.is_super_admin ? '' : 'none';
        const superAdminErrorField = document.getElementById('superAdminErrorDiscordField');
        if (superAdminErrorField) superAdminErrorField.style.display = data.is_super_admin ? '' : 'none';
        const adminSuccessField = document.getElementById('adminSuccessDiscordField');
        if (adminSuccessField) adminSuccessField.style.display = data.is_super_admin ? 'none' : '';
        const adminErrorField = document.getElementById('adminErrorDiscordField');
        if (adminErrorField) adminErrorField.style.display = data.is_super_admin ? 'none' : '';
        const adminBrandLabelField = document.getElementById('adminBrandLabelField');
        if (adminBrandLabelField) adminBrandLabelField.style.display = data.is_super_admin ? 'none' : '';
        if (superAdminMonitorGroups) superAdminMonitorGroups.style.display = data.is_super_admin ? '' : 'none';
        if (adminMonitorGroupsSection) adminMonitorGroupsSection.style.display = data.is_super_admin ? 'none' : '';
        const webhookLogsSection = document.getElementById('webhookLogsSection');
        if (webhookLogsSection) webhookLogsSection.style.display = data.is_super_admin ? '' : 'none';

        if (message) {
            message.textContent = data.inbound_webhook_url
                ? 'Webhook settings loaded.'
                : 'No shared website webhook created yet.';
        }
        if (data.is_super_admin) {
            await loadWebhookLogs();
        }
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}

async function createWebsiteWebhook() {
    const urlInput = document.getElementById('websiteWebhookUrl');
    const message = document.getElementById('webhookSettingsMessage');
    try {
        if (message) message.textContent = 'Creating website webhook...';
        const data = await authJSON(API + '/admin/webhooks/incoming/create', { method: 'POST' });
        if (urlInput) urlInput.value = data.inbound_webhook_url || '';
        if (message) message.textContent = 'Webhook created. Paste this URL into your bot.';
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}

async function createMonitorWebhook() {
    const urlInput = document.getElementById('monitorWebhookUrl');
    const message = document.getElementById('webhookSettingsMessage');
    try {
        if (message) message.textContent = 'Creating monitor webhook...';
        const data = await authJSON(API + '/admin/webhooks/monitor/create', { method: 'POST' });
        if (urlInput) urlInput.value = data.monitor_webhook_url || '';
        if (message) message.textContent = 'Monitor webhook created. Paste this URL into your monitor bot.';
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}

async function saveWebhookSettings() {
    const discordInput = document.getElementById('discordRelayWebhookUrl');
    const adminDiscordInput = document.getElementById('adminDiscordRelayWebhookUrl');
    const errorDiscordInput = document.getElementById('checkoutErrorWebhookUrl');
    const adminErrorDiscordInput = document.getElementById('adminErrorDiscordRelayWebhookUrl');
    const adminBrandInput = document.getElementById('adminBrandLabel');
    const monitorDedupeWindowInput = document.getElementById('monitorDedupeWindowSeconds');
    const message = document.getElementById('webhookSettingsMessage');

    try {
        await authJSON(API + '/admin/webhooks/settings', {
            method: 'POST',
            body: JSON.stringify({
                discord_webhook_url: discordInput ? discordInput.value : '',
                checkout_error_webhook_url: errorDiscordInput ? errorDiscordInput.value : '',
                admin_discord_webhook_url: adminDiscordInput ? adminDiscordInput.value : '',
                admin_error_discord_webhook_url: adminErrorDiscordInput ? adminErrorDiscordInput.value : '',
                monitor_dedupe_window_seconds: monitorDedupeWindowInput ? Number(monitorDedupeWindowInput.value || 90) : 90,
                admin_brand_label: adminBrandInput ? adminBrandInput.value : '',
                monitor_groups: {
                    pokemon: {
                        webhook_url: document.getElementById('monitorPokemon')?.value || '',
                        ping_mode: document.getElementById('monitorPokemonPingMode')?.value || 'none',
                        role_mention: document.getElementById('monitorPokemonRole')?.value || ''
                    },
                    onepiece: {
                        webhook_url: document.getElementById('monitorOnePiece')?.value || '',
                        ping_mode: document.getElementById('monitorOnePiecePingMode')?.value || 'none',
                        role_mention: document.getElementById('monitorOnePieceRole')?.value || ''
                    },
                    sports: {
                        webhook_url: document.getElementById('monitorSports')?.value || '',
                        ping_mode: document.getElementById('monitorSportsPingMode')?.value || 'none',
                        role_mention: document.getElementById('monitorSportsRole')?.value || ''
                    },
                    othertcg: {
                        webhook_url: document.getElementById('monitorOtherTcg')?.value || '',
                        ping_mode: document.getElementById('monitorOtherTcgPingMode')?.value || 'none',
                        role_mention: document.getElementById('monitorOtherTcgRole')?.value || ''
                    },
                    lowkey: {
                        webhook_url: document.getElementById('monitorLowkey')?.value || '',
                        ping_mode: document.getElementById('monitorLowkeyPingMode')?.value || 'none',
                        role_mention: document.getElementById('monitorLowkeyRole')?.value || ''
                    }
                },
                admin_monitor_groups: {
                    pokemon: {
                        webhook_url: document.getElementById('adminMonitorPokemon')?.value || '',
                        ping_mode: document.getElementById('adminMonitorPokemonPingMode')?.value || 'none',
                        role_mention: document.getElementById('adminMonitorPokemonRole')?.value || ''
                    },
                    onepiece: {
                        webhook_url: document.getElementById('adminMonitorOnePiece')?.value || '',
                        ping_mode: document.getElementById('adminMonitorOnePiecePingMode')?.value || 'none',
                        role_mention: document.getElementById('adminMonitorOnePieceRole')?.value || ''
                    },
                    sports: {
                        webhook_url: document.getElementById('adminMonitorSports')?.value || '',
                        ping_mode: document.getElementById('adminMonitorSportsPingMode')?.value || 'none',
                        role_mention: document.getElementById('adminMonitorSportsRole')?.value || ''
                    },
                    othertcg: {
                        webhook_url: document.getElementById('adminMonitorOtherTcg')?.value || '',
                        ping_mode: document.getElementById('adminMonitorOtherTcgPingMode')?.value || 'none',
                        role_mention: document.getElementById('adminMonitorOtherTcgRole')?.value || ''
                    },
                    lowkey: {
                        webhook_url: document.getElementById('adminMonitorLowkey')?.value || '',
                        ping_mode: document.getElementById('adminMonitorLowkeyPingMode')?.value || 'none',
                        role_mention: document.getElementById('adminMonitorLowkeyRole')?.value || ''
                    }
                }
            })
        });

        if (message) message.textContent = 'Webhook settings saved.';
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}

async function loadUserSettings() {
    const input = document.getElementById('userDiscordHandle');
    const message = document.getElementById('userSettingsMessage');
    const connectedBox = document.getElementById('discordConnectedBox');
    const connectButton = document.getElementById('connectDiscordButton');
    const disconnectButton = document.getElementById('disconnectDiscordButton');
    if (!input && !connectedBox) return;

    try {
        const data = await authJSON(API + '/user/settings');
        if (input) input.value = data.discord_user_id || '';
        const display = data.discord_display_name || data.discord_username || data.discord_user_id || '';
        if (connectedBox) {
            connectedBox.innerHTML = data.discord_connected
                ? `<strong>Discord Connected</strong><br><span class="subtle-text">✓ ${escapeHTML(display)}</span>`
                : '<strong>Discord Not Connected</strong><br><span class="subtle-text">Connect Discord so checkout webhooks can ping you automatically.</span>';
        }
        if (connectButton) connectButton.style.display = data.discord_connected ? 'none' : 'inline-flex';
        if (disconnectButton) disconnectButton.style.display = data.discord_connected ? 'inline-flex' : 'none';
        if (message) message.textContent = data.discord_connected ? 'Discord is connected.' : '';
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}

async function saveUserSettings() {
    const input = document.getElementById('userDiscordHandle');
    const message = document.getElementById('userSettingsMessage');
    if (!input) return;

    try {
        const data = await authJSON(API + '/user/settings', {
            method: 'POST',
            body: JSON.stringify({
                discord_user_id: input.value || ''
            })
        });

        input.value = data.discord_user_id || '';
        if (message) message.textContent = 'Discord user ID saved.';
        await loadUserSettings();
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}

async function disconnectDiscord() {
    const message = document.getElementById('userSettingsMessage');
    try {
        await authJSON(API + '/auth/discord/disconnect', { method: 'POST' });
        if (message) message.textContent = 'Discord disconnected.';
        await refreshCurrentUserFromServer();
        await loadUserSettings();
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}



const storeProductCache = {};
const storeSelectedProductIds = {};
const storeProductAutosaveTimers = {};
const storeProductAutosaveControllers = {};

function getStoreSelectionLimit(site) {
    if (site === "amazon") return 1;
    // Target and Sam's Club are uncapped on the dashboard. Admin exports still batch selected SKUs into 29-SKU lists.
    return 9999;
}

function renderStoreProductCard(product, site) {
    const title = product.product_name || product.sku || 'Product';
    const sku = product.sku || '-';
    const price = product.default_max_price !== null && product.default_max_price !== undefined ? formatMoney(product.default_max_price) : 'No limit';
    const credits = formatCredits(product.credit_cost || 0);
    const link = product.product_url ? `<a href="${escapeHTML(product.product_url)}" target="_blank" rel="noopener">Open</a>` : '';
    const selectable = site === 'target' || site === 'samsclub' || site === 'amazon' || site === 'pokemon';
    const inputType = site === 'amazon' ? 'radio' : 'checkbox';
    const selected = !!product.selected;
    const control = selectable
        ? `<label class="checkbox-inline store-product-select"><input type="${inputType}" name="${site}ProductSelection" data-store-product-select="${escapeHTML(site)}" data-product-id="${escapeHTML(product.id)}" ${selected ? 'checked' : ''} /><span>${selected ? 'Selected' : 'Select'}</span></label>`
        : '';

    return `
        <article class="store-product-card ${selectable ? 'store-product-card--clickable' : ''} ${selected ? 'store-product-card--selected' : ''}" data-store-product-card="${escapeHTML(site)}" data-product-id="${escapeHTML(product.id)}">
            ${product.image_url ? `<img src="${escapeHTML(product.image_url)}" alt="" />` : ''}
            <div>
                <strong>${escapeHTML(title)}</strong>
                <span>SKU: ${escapeHTML(sku)}</span>
                <span>${escapeHTML(price)} • ${escapeHTML(credits)}</span>
                ${link}
                ${control}
            </div>
        </article>
    `;
}

function updateStoreSelectionSummary(site) {
    const summary = document.getElementById(site + "SelectionSummary");
    const selected = storeSelectedProductIds[site] || new Set();
    const skuUnits = countSelectedStoreSkuUnits(site);
    if (summary) {
        summary.textContent = site === "target"
            ? `${skuUnits} Target SKU${skuUnits === 1 ? "" : "s"} selected`
            : site === "samsclub"
                ? `${skuUnits} Sam's Club SKU${skuUnits === 1 ? "" : "s"} selected`
                : site === "pokemon"
                    ? `${skuUnits} Pokémon Center item${skuUnits === 1 ? "" : "s"} selected`
                    : site === "amazon"
                        ? `${selected.size} / 1 Amazon item selected`
                        : `${selected.size} selected`;
    }
}

function applyStoreProductSelection(site, input) {
    const panel = document.getElementById(site + "ProductsPanel");
    if (!panel || !input) return;

    const selected = storeSelectedProductIds[site] || new Set();
    const productId = String(input.dataset.productId || "");
    const limit = getStoreSelectionLimit(site);

    if (site === "amazon") {
        selected.clear();
        if (input.checked) selected.add(productId);
        panel.querySelectorAll("[data-store-product-select]").forEach((other) => {
            if (other !== input) other.checked = false;
            const card = other.closest("[data-store-product-card]");
            if (card) card.classList.toggle("store-product-card--selected", other.checked);
            const labelSpan = other.closest("label")?.querySelector("span");
            if (labelSpan) labelSpan.textContent = other.checked ? "Selected" : "Select";
        });
    } else {
        if (input.checked) {
            const product = (storeProductCache[site] || []).find((row) => String(row.id) === productId);
            const currentSkuUnits = countSelectedStoreSkuUnits(site);
            const addedSkuUnits = selected.has(productId) ? 0 : getProductSkuUnitCount(product);
            if (currentSkuUnits + addedSkuUnits > limit && !selected.has(productId)) {
                input.checked = false;
                alert(`You can select up to ${limit} ${site === "samsclub" ? "Sam\'s Club" : site === "pokemon" ? "Pokémon Center" : "Target"} SKUs.`);
                return;
            }
            selected.add(productId);
        } else {
            selected.delete(productId);
        }
    }

    storeSelectedProductIds[site] = selected;

    const card = input.closest("[data-store-product-card]");
    if (card) card.classList.toggle("store-product-card--selected", input.checked);
    const labelSpan = input.closest("label")?.querySelector("span");
    if (labelSpan) labelSpan.textContent = input.checked ? "Selected" : "Select";

    updateStoreSelectionSummary(site);
}

function getStoreSelectionUnitLabel(site) {
    if (site === "amazon") return "Amazon item";
    if (site === "samsclub") return "Sam's Club SKU";
    if (site === "pokemon") return "Pokémon Center item";
    return "Target SKU";
}

async function saveStoreProductSelections(site, options = {}) {
    const msg = document.getElementById(site + "ProductSelectionMessage");
    const selected = Array.from(storeSelectedProductIds[site] || new Set());

    if (storeProductAutosaveControllers[site]) {
        try { storeProductAutosaveControllers[site].abort(); } catch (_) {}
    }

    const controller = new AbortController();
    storeProductAutosaveControllers[site] = controller;
    if (msg) msg.innerHTML = `<span class="autosave-pill">Saving selections...</span>`;

    try {
        await authJSON(API + "/product-preferences", {
            method: "PUT",
            body: JSON.stringify({ site, selected_product_ids: selected }),
            signal: controller.signal
        });
        if (storeProductAutosaveControllers[site] === controller) {
            const savedCount = (site === "target" || site === "samsclub" || site === "pokemon") ? countSelectedStoreSkuUnits(site) : selected.length;
            const unitLabel = getStoreSelectionUnitLabel(site);
            if (msg) msg.innerHTML = `<span class="autosave-pill">Saved automatically: ${savedCount} ${unitLabel}${savedCount === 1 ? "" : "s"} selected.</span>`;
            storeProductAutosaveControllers[site] = null;
            loadUserProductExportStatus(site).catch(() => {});
        }
    } catch (err) {
        if (err?.name === "AbortError") return;
        if (msg) msg.textContent = err.message || "Could not save selections. Please try clicking the checkbox again.";
    }
}

function scheduleStoreProductAutosave(site) {
    clearTimeout(storeProductAutosaveTimers[site]);
    const msg = document.getElementById(site + "ProductSelectionMessage");
    if (msg) msg.innerHTML = `<span class="autosave-pill">Selection changed. Saving automatically...</span>`;
    storeProductAutosaveTimers[site] = setTimeout(() => {
        saveStoreProductSelections(site).catch(() => {});
    }, 350);
}

function bindStoreProductSelectionControls(site) {
    const panel = document.getElementById(site + "ProductsPanel");
    if (!panel) return;

    panel.querySelectorAll("[data-store-product-select]").forEach((input) => {
        input.addEventListener("change", () => {
            applyStoreProductSelection(site, input);
            scheduleStoreProductAutosave(site);
        });
    });

    panel.querySelectorAll("[data-store-product-card]").forEach((card) => {
        if (card.dataset.cardClickBound) return;
        card.dataset.cardClickBound = "1";
        card.addEventListener("click", (event) => {
            if (event.target.closest("a, button, input, label, select, textarea")) return;
            const input = card.querySelector("[data-store-product-select]");
            if (!input) return;
            input.checked = !input.checked;
            applyStoreProductSelection(site, input);
            scheduleStoreProductAutosave(site);
        });
    });
}


const PRODUCT_CATEGORY_ORDER = [
    "pokemon",
    "onepiece",
    "electronics",
    "needoh",
    "sports",
    "othertcg",
    "lowkey",
    "other"
];

const PRODUCT_CATEGORY_LABELS = {
    pokemon: "Pokémon",
    onepiece: "One Piece",
    electronics: "Electronics",
    needoh: "Needoh",
    sports: "Sports Cards",
    othertcg: "Other TCG",
    lowkey: "Other Lowkey Flips",
    other: "Other"
};

function normalizeProductCategory(value = "") {
    const raw = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["pokemon", "pokémon", "poke", "pkmn"].includes(raw)) return "pokemon";
    if (["onepiece", "onepiecetcg", "op"].includes(raw)) return "onepiece";
    if (["electronics", "electronic", "tech"].includes(raw)) return "electronics";
    if (["needoh", "neeDoh".toLowerCase()].includes(raw)) return "needoh";
    if (["sports", "sportscards", "sportsCard".toLowerCase(), "card"].includes(raw)) return "sports";
    if (["othertcg", "othercards", "tcg", "tradingcards"].includes(raw)) return "othertcg";
    if (["lowkey", "otherlowkey", "flips", "otherlowkeyflips"].includes(raw)) return "lowkey";
    return raw || "other";
}

function inferProductCategory(product = {}) {
    const metadata = product.metadata || {};
    const direct = metadata.category || metadata.product_type || metadata.type || product.category || product.product_type;
    const normalizedDirect = normalizeProductCategory(direct);
    if (normalizedDirect && normalizedDirect !== "other") return normalizedDirect;

    const text = `${product.product_name || ""} ${product.brand || ""} ${product.sku || ""}`.toLowerCase();

    if (text.includes("pokémon") || text.includes("pokemon") || text.includes("scarlet") || text.includes("violet") || text.includes("prismatic") || text.includes("mega evolution") || text.includes("etb") || text.includes("elite trainer")) return "pokemon";
    if (text.includes("one piece")) return "onepiece";
    if (text.includes("needoh") || text.includes("nee doh") || text.includes("nice cube") || text.includes("teenie")) return "needoh";
    if (text.includes("panini") || text.includes("topps") || text.includes("chrome") || text.includes("nba") || text.includes("nfl") || text.includes("football") || text.includes("basketball") || text.includes("baseball")) return "sports";
    if (text.includes("camera") || text.includes("canon") || text.includes("sony") || text.includes("nintendo") || text.includes("xbox") || text.includes("playstation") || text.includes("apple") || text.includes("ipad") || text.includes("console")) return "electronics";
    if (text.includes("trading card") || text.includes("booster") || text.includes("deck") || text.includes("tcg")) return "othertcg";
    return "lowkey";
}

function getProductCategoryRank(product = {}) {
    const category = inferProductCategory(product);
    const index = PRODUCT_CATEGORY_ORDER.indexOf(category);
    return index === -1 ? PRODUCT_CATEGORY_ORDER.length : index;
}

function sortStoreProducts(products = []) {
    return [...products].sort((a, b) => {
        const ca = getProductCategoryRank(a);
        const cb = getProductCategoryRank(b);
        if (ca !== cb) return ca - cb;
        const selectedDiff = Number(!!b.selected) - Number(!!a.selected);
        if (selectedDiff) return selectedDiff;
        return String(a.product_name || a.sku || "").localeCompare(String(b.product_name || b.sku || ""));
    });
}

function filterStoreProducts(site, products = []) {
    const search = String(document.getElementById(site + "ProductSearch")?.value || "").trim().toLowerCase();
    if (!search) return products;
    return products.filter((product) => {
        const haystack = [
            product.product_name,
            product.sku,
            product.brand,
            inferProductCategory(product),
            PRODUCT_CATEGORY_LABELS[inferProductCategory(product)]
        ].join(" ").toLowerCase();
        return haystack.includes(search);
    });
}

function renderStoreProductGroups(site, products = []) {
    const sorted = sortStoreProducts(filterStoreProducts(site, products));
    if (!sorted.length) {
        return '<div class="empty-card"><p>No products match your search.</p></div>';
    }

    const groups = new Map();
    sorted.forEach((product) => {
        const category = inferProductCategory(product);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(product);
    });

    return PRODUCT_CATEGORY_ORDER.concat([...groups.keys()].filter((key) => !PRODUCT_CATEGORY_ORDER.includes(key))).map((category) => {
        const items = groups.get(category) || [];
        if (!items.length) return "";
        return `
            <section class="store-product-category">
                <div class="store-product-category-header">
                    <h3>${escapeHTML(PRODUCT_CATEGORY_LABELS[category] || category)}</h3>
                    <span class="badge">${items.length}</span>
                </div>
                <div class="store-product-grid">
                    ${items.map((product) => renderStoreProductCard(product, site)).join('')}
                </div>
            </section>
        `;
    }).join("");
}

function bindStoreProductSearch(site) {
    const input = document.getElementById(site + "ProductSearch");
    const grid = document.getElementById(site + "ProductGridWrap");
    if (!input || !grid || input.dataset.bound) return;
    input.dataset.bound = "1";
    input.addEventListener("input", () => {
        grid.innerHTML = renderStoreProductGroups(site, storeProductCache[site] || []);
        bindStoreProductSelectionControls(site);
        updateStoreSelectionSummary(site);
    });
}




function renderUserProductExportStatus(site, status = null, errorMessage = '') {
    const banner = document.getElementById(site + "UserProductExportStatus");
    if (!banner) return;
    const label = site === "samsclub" ? "Sam's Club" : site === "pokemon" ? "Pokémon Center" : site === "amazon" ? "Amazon" : site === "target" ? "Target" : "store";
    banner.className = "export-sync-banner export-sync-banner--neutral";

    if (errorMessage) {
        banner.textContent = errorMessage;
        return;
    }
    if (!status || Number(status.selection_count || 0) === 0) {
        banner.textContent = `No ${label} product selections are waiting to be copied yet.`;
        return;
    }
    if (status.changed_since_export) {
        banner.className = "export-sync-banner export-sync-banner--pending";
        banner.textContent = `🔴 Your ${label} product list has new changes. Your admin has not marked the updated list as copied yet.`;
    } else {
        banner.className = "export-sync-banner export-sync-banner--synced";
        banner.textContent = `🟢 Your ${label} product list is updated. Your admin has marked your latest selections as copied.`;
    }
}

async function loadUserProductExportStatus(site) {
    const banner = document.getElementById(site + "UserProductExportStatus");
    if (!banner) return;
    renderUserProductExportStatus(site, null);
    try {
        const data = await authJSON(API + "/product-selections/export-status?site=" + encodeURIComponent(site));
        renderUserProductExportStatus(site, data);
    } catch (err) {
        renderUserProductExportStatus(site, null, err.message || "Could not load product list update status.");
    }
}

async function loadTargetRecommendedLists() {
    const panel = document.getElementById("targetRecommendedListsPanel");
    if (!panel) return;

    panel.innerHTML = '<div class="subtle-text">Loading running lists...</div>';

    try {
        const data = await authJSON(API + "/target-recommended-lists");
        const lists = Array.isArray(data.lists) ? data.lists : [];

        if (!lists.length) {
            panel.innerHTML = '<div class="empty-card"><p>No super admin/admin Target running lists are posted yet.</p></div>';
            return;
        }

        panel.innerHTML = lists.map((list) => `
            <article class="recommended-list-card">
                <div class="recommended-list-card__header">
                    <div>
                        <h3>${escapeHTML(list.title || "Running List")}</h3>
                        <p class="subtle-text">${escapeHTML(list.subtitle || "")} • ${(list.product_ids || []).length} SKU${(list.product_ids || []).length === 1 ? "" : "s"}</p>
                    </div>
                    <button class="btn btn-primary" type="button" data-apply-recommended-target-list="${escapeHTML((list.product_ids || []).join(","))}">Apply List</button>
                </div>
                <div class="target-checkout-sku-scroll">
                    <table class="mini-table">
                        <thead><tr><th>SKU</th><th>Product</th><th>Price</th></tr></thead>
                        <tbody>
                            ${(list.products || []).map((row) => {
                                const product = row.product || {};
                                const price = row.max_price ?? product.default_max_price;
                                return `<tr><td>${escapeHTML(product.sku || "-")}</td><td>${escapeHTML(product.product_name || product.sku || "-")}</td><td>${price === null || price === undefined ? '<span class="subtle-text">No limit</span>' : escapeHTML(formatMoney(price))}</td></tr>`;
                            }).join("")}
                        </tbody>
                    </table>
                </div>
            </article>
        `).join("");

        panel.querySelectorAll("[data-apply-recommended-target-list]").forEach((button) => {
            button.addEventListener("click", () => {
                const ids = String(button.dataset.applyRecommendedTargetList || "").split(",").filter(Boolean);
                applyRecommendedTargetProductIds(ids);
            });
        });
    } catch (err) {
        panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || "Could not load running lists.")}</p></div>`;
    }
}

function applyRecommendedTargetProductIds(productIds = []) {
    const site = "target";
    const available = new Set((storeProductCache[site] || []).map((product) => String(product.id)));
    const selected = storeSelectedProductIds[site] || new Set();

    let added = 0;
    for (const id of productIds.map(String)) {
        if (!available.has(id) || selected.has(id)) continue;
        const product = (storeProductCache[site] || []).find((row) => String(row.id) === String(id));
        selected.add(id);
        added += 1;
    }

    storeSelectedProductIds[site] = selected;

    document.querySelectorAll(`#${site}ProductsPanel [data-store-product-select]`).forEach((input) => {
        const isSelected = selected.has(String(input.dataset.productId || ""));
        input.checked = isSelected;
        const card = input.closest("[data-store-product-card]");
        if (card) card.classList.toggle("store-product-card--selected", isSelected);
        const labelSpan = input.closest("label")?.querySelector("span");
        if (labelSpan) labelSpan.textContent = isSelected ? "Selected" : "Select";
    });

    updateStoreSelectionSummary(site);
    const msg = document.getElementById("targetProductSelectionMessage");
    if (msg) {
        msg.textContent = added
            ? `Applied ${added} product${added === 1 ? "" : "s"} from that list. Saving automatically...`
            : "No products were added. They may already be selected.";
    }
    if (added) scheduleStoreProductAutosave(site);
}


async function loadStoreProductsForSite(site) {
    const panel = document.getElementById(site + "ProductsPanel");
    if (!panel) return;

    panel.innerHTML = '<div class="subtle-text">Loading products...</div>';

    try {
        const qs = new URLSearchParams({ site });
        const data = await authJSON(API + '/product-catalog?' + qs.toString());
        const products = dedupeMultiSkuProducts(migrateLegacyMultiSkuSelections(site, Array.isArray(data.products) ? data.products : []));
        storeProductCache[site] = products;
        storeSelectedProductIds[site] = new Set(products.filter((product) => !!product.selected).map((product) => String(product.id)));

        if (!products.length) {
            panel.innerHTML = '<div class="empty-card"><p>No products are currently listed for this store.</p></div>';
            return;
        }

        const selectable = site === 'target' || site === 'samsclub' || site === 'amazon' || site === 'pokemon';
        const limitText = site === 'target'
            ? 'Select all Target SKUs you want us to run.'
            : site === 'samsclub'
                ? "Select the Sam's Club SKUs you want us to run."
                : site === 'pokemon'
                    ? 'Select the Pokémon Center items you want us to run.'
                    : site === 'amazon'
                        ? 'Select 1 Amazon item.'
                        : '';

        panel.innerHTML = `
            <div class="store-product-summary-row">
                <div>
                    <div class="store-product-summary">${products.length} product${products.length === 1 ? '' : 's'} available</div>
                    ${selectable ? `<div class="subtle-text" id="${site}SelectionSummary"></div>` : ''}
                </div>
            </div>
            <div class="toolbar-row store-product-search-row">
                <input id="${site}ProductSearch" class="input" type="search" placeholder="Search ${site} products by name, SKU, brand, or category" />
            </div>
            ${site === 'target' ? `<div id="targetUserProductExportStatus" class="export-sync-banner export-sync-banner--neutral">Loading product list update status...</div><section class="recommended-lists-section"><div class="panel-header panel-header--compact"><div><h3>Current Running Lists</h3><p class="subtle-text">Apply The Shore Shack list or your admin’s list.</p></div></div><div id="targetRecommendedListsPanel" class="recommended-list-grid"></div></section>` : ''}
            ${selectable ? `<div class="banner banner-soft"><strong>${escapeHTML(limitText)}</strong><p class="subtle-text">You can pick your own products even if they are not currently recommended. Exports will still be split into 29-SKU batches for the bot.</p><div id="${site}ProductSelectionMessage" class="subtle-text"></div></div>` : ''}
            <div class="store-product-scroll">
                <div id="${site}ProductGridWrap">
                    ${renderStoreProductGroups(site, products)}
                </div>
            </div>
        `;
        updateStoreSelectionSummary(site);
        bindStoreProductSearch(site);
        bindStoreProductSelectionControls(site);
        if (site === 'target') {
            try { await loadUserProductExportStatus(site); } catch (_) { }
            try { await loadTargetRecommendedLists(); } catch (_) { }
        }
    } catch (err) {
        panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || 'Could not load products.')}</p></div>`;
    }
}

async function loadStoreProductPanels() {
    await Promise.all(['target', 'samsclub', 'walmart', 'amazon', 'general', 'crunchyroll', 'pokemon'].map(loadStoreProductsForSite));
}


function formatTargetCheckoutSkuList(items = []) {
    return (Array.isArray(items) ? items : []).map((item) => {
        const sku = String(item.sku || "").trim();
        const name = String(item.name || "").trim();
        const price = item.price === null || item.price === undefined ? "" : String(item.price);
        return `${sku};${name};${price}`;
    }).join("\n");
}

function parseTargetCheckoutListLineCount(value = "") {
    return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function renderTargetCheckoutListCard(list, options = {}) {
    const items = Array.isArray(list.items) ? list.items : [];
    const checked = options.selected ? "checked" : "";
    const selectable = options.selectable !== false;
    const controls = selectable
        ? `<label class="checkbox-inline"><input type="checkbox" data-target-checkout-list-select="${escapeHTML(list.id)}" ${checked} /><span>Select this list</span></label>`
        : "";

    return `
        <article class="target-checkout-list-card">
            <div class="target-checkout-list-card__header">
                <div>
                    <h3>${escapeHTML(list.title || "Untitled List")}</h3>
                    <p class="subtle-text">${items.length} SKU${items.length === 1 ? "" : "s"}${items.length >= 29 ? " • Full 29 SKU list" : ""}</p>
                </div>
                ${controls}
            </div>
            <div class="target-checkout-sku-scroll">
                <table class="mini-table">
                    <thead><tr><th>SKU</th><th>Product</th><th>Price</th></tr></thead>
                    <tbody>
                        ${items.map((item) => `
                            <tr>
                                <td>${escapeHTML(item.sku || "-")}</td>
                                <td>${escapeHTML(item.name || "-")}</td>
                                <td>${item.price === null || item.price === undefined || item.price === "" ? '<span class="subtle-text">No limit</span>' : escapeHTML(formatMoney(item.price))}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        </article>
    `;
}

async function loadTargetCheckoutListsForUser() {
    const panel = document.getElementById("targetCheckoutListsUserPanel");
    if (!panel) return;

    const message = document.getElementById("targetCheckoutListSelectionMessage");
    panel.innerHTML = '<div class="subtle-text">Loading checkout lists...</div>';

    try {
        const data = await authJSON(API + "/target-checkout-lists");
        const lists = Array.isArray(data.lists) ? data.lists : [];
        const selected = new Set(Array.isArray(data.selected_list_ids) ? data.selected_list_ids.map(String) : []);

        if (!lists.length) {
            panel.innerHTML = '<div class="empty-card"><p>No active Target checkout lists have been posted yet.</p></div>';
            return;
        }

        panel.innerHTML = lists.map((list) => renderTargetCheckoutListCard(list, {
            selected: selected.has(String(list.id)),
            selectable: true
        })).join("");

        const saveButton = document.getElementById("saveTargetCheckoutListSelections");
        if (saveButton && !saveButton.dataset.bound) {
            saveButton.dataset.bound = "1";
            saveButton.addEventListener("click", async () => {
                const selectedIds = Array.from(document.querySelectorAll("[data-target-checkout-list-select]:checked"))
                    .map((input) => input.dataset.targetCheckoutListSelect)
                    .filter(Boolean);
                saveButton.disabled = true;
                if (message) message.textContent = "Saving selected Target lists...";
                try {
                    await authJSON(API + "/target-checkout-lists/selections", {
                        method: "POST",
                        body: JSON.stringify({ selected_list_ids: selectedIds })
                    });
                    if (message) message.textContent = `Saved ${selectedIds.length} selected Target checkout list${selectedIds.length === 1 ? "" : "s"}.`;
                } catch (err) {
                    if (message) message.textContent = err.message || "Could not save selected lists.";
                } finally {
                    saveButton.disabled = false;
                }
            });
        }
    } catch (err) {
        panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || "Could not load Target checkout lists.")}</p></div>`;
    }
}

function clearTargetCheckoutListAdminForm() {
    const id = document.getElementById("targetCheckoutListId");
    const title = document.getElementById("targetCheckoutListTitle");
    const skuList = document.getElementById("targetCheckoutSkuList");
    if (id) id.value = "";
    if (title) title.value = "";
    if (skuList) skuList.value = "";
}

async function loadTargetCheckoutListsAdmin() {
    const listEl = document.getElementById("targetCheckoutListsAdminList");
    if (!listEl) return;

    listEl.innerHTML = '<div class="subtle-text">Loading Target checkout lists...</div>';

    try {
        const data = await authJSON(API + "/admin/target-checkout-lists");
        const lists = Array.isArray(data.lists) ? data.lists : [];

        if (!lists.length) {
            listEl.innerHTML = '<div class="empty-card"><p>No Target checkout lists have been created yet.</p></div>';
            return;
        }

        listEl.innerHTML = lists.map((list) => `
            <section class="target-checkout-admin-list" data-target-checkout-list="${escapeHTML(list.id)}">
                <div class="target-checkout-list-card__header">
                    <div>
                        <h3>${escapeHTML(list.title || "Untitled List")}</h3>
                        <p class="subtle-text">${Array.isArray(list.items) ? list.items.length : 0} SKU${Array.isArray(list.items) && list.items.length === 1 ? "" : "s"} • Updated ${escapeHTML(formatDateTime(list.updated_at))}</p>
                    </div>
                    <div class="panel-actions">
                        <button class="btn" type="button" data-edit-target-checkout-list="${escapeHTML(list.id)}">Edit</button>
                        <button class="btn btn-danger" type="button" data-delete-target-checkout-list="${escapeHTML(list.id)}">Delete</button>
                    </div>
                </div>
                <pre class="sku-list-preview">${escapeHTML(formatTargetCheckoutSkuList(list.items))}</pre>
            </section>
        `).join("");

        listEl.querySelectorAll("[data-edit-target-checkout-list]").forEach((button) => {
            button.addEventListener("click", () => {
                const list = lists.find((entry) => String(entry.id) === String(button.dataset.editTargetCheckoutList));
                if (!list) return;
                document.getElementById("targetCheckoutListId").value = list.id;
                document.getElementById("targetCheckoutListTitle").value = list.title || "";
                document.getElementById("targetCheckoutSkuList").value = formatTargetCheckoutSkuList(list.items);
                document.getElementById("targetCheckoutListTitle").scrollIntoView({ behavior: "smooth", block: "center" });
            });
        });

        listEl.querySelectorAll("[data-delete-target-checkout-list]").forEach((button) => {
            button.addEventListener("click", async () => {
                if (!confirm("Delete this Target checkout list?")) return;
                try {
                    await authJSON(API + "/admin/target-checkout-lists/" + encodeURIComponent(button.dataset.deleteTargetCheckoutList), {
                        method: "DELETE"
                    });
                    await loadTargetCheckoutListsAdmin();
                } catch (err) {
                    const msg = document.getElementById("targetCheckoutListMessage");
                    if (msg) msg.textContent = err.message || "Could not delete list.";
                }
            });
        });
    } catch (err) {
        listEl.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || "Could not load Target checkout lists.")}</p></div>`;
    }
}

function initTargetCheckoutListAdmin() {
    const form = document.getElementById("targetCheckoutListForm");
    if (!form || form.dataset.bound) return;

    const message = document.getElementById("targetCheckoutListMessage");
    const clearButton = document.getElementById("clearTargetCheckoutListForm");

    form.dataset.bound = "1";
    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const id = document.getElementById("targetCheckoutListId").value.trim();
        const title = document.getElementById("targetCheckoutListTitle").value.trim();
        const skuList = document.getElementById("targetCheckoutSkuList").value.trim();
        const count = parseTargetCheckoutListLineCount(skuList);

        if (!title) {
            if (message) message.textContent = "List title is required.";
            return;
        }
        if (!count) {
            if (message) message.textContent = "Add at least one SKU line.";
            return;
        }
        if (count > 29) {
            if (message) message.textContent = "Target checkout lists can only contain up to 29 SKUs.";
            return;
        }

        const submit = form.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        if (message) message.textContent = "Saving Target checkout list...";

        try {
            const data = await authJSON(API + "/admin/target-checkout-lists", {
                method: "POST",
                body: JSON.stringify({ id: id || undefined, title, sku_list: skuList })
            });
            const missing = Array.isArray(data.missing_skus) ? data.missing_skus : [];
            if (message) {
                message.textContent = missing.length
                    ? `Target checkout list saved. Added missing SKU${missing.length === 1 ? "" : "s"} to catalog as placeholder${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Go to Countdowns + Catalog, search the SKU, then fill product name/credits if needed.`
                    : "Target checkout list saved.";
            }
            clearTargetCheckoutListAdminForm();
            await loadTargetCheckoutListsAdmin();
        } catch (err) {
            if (message) message.textContent = err.message || "Could not save checkout list.";
        } finally {
            if (submit) submit.disabled = false;
        }
    });

    if (clearButton) {
        clearButton.addEventListener("click", clearTargetCheckoutListAdminForm);
    }

    loadTargetCheckoutListsAdmin();
}


function initUserDashboardNavigation() {
    const buttons = Array.from(document.querySelectorAll('[data-user-nav]'));
    const panes = Array.from(document.querySelectorAll('[data-user-pane]'));
    if (!buttons.length || !panes.length) return;

    const activate = (key) => {
        const targetKey = panes.some((pane) => pane.dataset.userPane === key) ? key : buttons[0]?.dataset.userNav;
        buttons.forEach((button) => {
            button.classList.toggle('is-active', button.dataset.userNav === targetKey);
        });
        panes.forEach((pane) => {
            pane.classList.toggle('is-active', pane.dataset.userPane === targetKey);
        });
        try { localStorage.setItem("dashboardActiveTab", targetKey); } catch (_) { }
    };

    buttons.forEach((button) => {
        button.addEventListener('click', () => activate(button.dataset.userNav));
    });

    let preferredTab = null;
    try { preferredTab = localStorage.getItem("dashboardActiveTab"); } catch (_) { }
    const activeButton =
        (preferredTab && buttons.find((button) => button.dataset.userNav === preferredTab)) ||
        buttons.find((button) => button.classList.contains('is-active')) ||
        buttons[0];

    if (activeButton) {
        activate(activeButton.dataset.userNav);
    }
}

async function loadUserActivity() {
    const summary = document.getElementById('userHistorySummary');
    const ordersBody = document.getElementById('userHistoryOrdersBody');
    const txBody = document.getElementById('userHistoryTransactionsBody');
    if (!summary || !ordersBody || !txBody) return;
    try {
        const data = await authJSON(API + '/user/activity');
        const balance = Number(data.balance || 0);
        summary.textContent = `Current balance: ${balance} credits • Lifetime granted: ${Number(data.lifetime_credits_granted || 0)} • Lifetime spent: ${Number(data.lifetime_credits_spent || 0)}${data.needs_removal ? ' • Flagged for removal until positive balance is restored' : ''}`;
        const orders = Array.isArray(data.orders) ? data.orders : [];
        ordersBody.innerHTML = orders.length ? orders.map((order) => `
            <tr><td>${escapeHTML(formatDateTime(order.created_at))}</td><td>${escapeHTML(order.site || '-')}</td><td>${escapeHTML(order.product_name || '-')}</td><td>${escapeHTML(order.status || '-')}</td><td>${escapeHTML(String(order.credits_charged || 0))}</td></tr>
        `).join('') : '<tr><td colspan="5">No orders yet.</td></tr>';
        const txs = Array.isArray(data.transactions) ? data.transactions : [];
        txBody.innerHTML = txs.length ? txs.map((tx) => `
            <tr><td>${escapeHTML(formatDateTime(tx.created_at))}</td><td>${escapeHTML(String((tx.delta || 0) > 0 ? '+' : '') + String(tx.delta || 0))}</td><td>${escapeHTML(tx.reason || '-')}</td><td>${escapeHTML(tx.note || '-')}</td></tr>
        `).join('') : '<tr><td colspan="4">No credit transactions yet.</td></tr>';
    } catch (err) {
        summary.textContent = err.message;
        ordersBody.innerHTML = '<tr><td colspan="5">Could not load orders.</td></tr>';
        txBody.innerHTML = '<tr><td colspan="4">Could not load credit transactions.</td></tr>';
    }
}

async function loadUserCreditReceipt(userId) {
    const summary = document.getElementById('creditReceiptSummary');
    const txBody = document.getElementById('creditTransactionsTableBody');
    const ordersBody = document.getElementById('userOrdersTableBody');
    if (!summary || !txBody || !ordersBody) return;

    summary.textContent = 'Loading user receipt...';
    txBody.innerHTML = '<tr><td colspan="5">Loading transactions...</td></tr>';
    ordersBody.innerHTML = '<tr><td colspan="6">Loading orders...</td></tr>';

    try {
        const data = await authJSON(API + '/admin/users/' + encodeURIComponent(userId) + '/credits/history');
        const user = data.user || {};
        const balance = Number(data.balance || 0);
        summary.innerHTML = `
            <strong>${escapeHTML(userDisplayName(user))}</strong>
            <span class="subtle-text"> • Balance: ${escapeHTML(String(balance))} credits • Granted: ${escapeHTML(String(data.lifetime_credits_granted || 0))} • Spent: ${escapeHTML(String(data.lifetime_credits_spent || 0))} • ${data.needs_removal ? 'Needs removal until positive balance' : 'Eligible / positive balance'}</span>
        `;

        const transactions = Array.isArray(data.transactions) ? data.transactions : [];
        txBody.innerHTML = transactions.length ? transactions.map((item) => `
            <tr>
              <td>${escapeHTML(formatEasternTime(item.created_at || ''))} ET</td>
              <td>${Number(item.amount_delta || 0) >= 0 ? '+' : ''}${escapeHTML(String(item.amount_delta || 0))}</td>
              <td>${escapeHTML(String(item.balance_after ?? '-'))}</td>
              <td>${escapeHTML(item.reason || '-')}</td>
              <td>${escapeHTML(item.note || '-')}</td>
            </tr>`).join('') : '<tr><td colspan="5">No credit transactions found.</td></tr>';

        const orders = Array.isArray(data.orders) ? data.orders : [];
        ordersBody.innerHTML = orders.length ? orders.map((item) => `
            <tr>
              <td>${escapeHTML(formatEasternTime(item.created_at || ''))} ET</td>
              <td>${escapeHTML(item.site || '-')}</td>
              <td>${escapeHTML(item.product_name || item.sku || '-')}</td>
              <td>${String(item.status || '') === 'insufficient_credits' ? '<span class="status-tag status-tag--danger">Insufficient Credits</span>' : '<span class="status-tag status-tag--success">Charged</span>'}</td>
              <td>${escapeHTML(String(item.credits_charged || 0))}</td>
              <td>${escapeHTML(item.external_order_id || '-')}</td>
            </tr>`).join('') : '<tr><td colspan="6">No linked orders found.</td></tr>';
    } catch (err) {
        summary.textContent = err.message;
        txBody.innerHTML = `<tr><td colspan="5">${escapeHTML(err.message)}</td></tr>`;
        ordersBody.innerHTML = `<tr><td colspan="6">${escapeHTML(err.message)}</td></tr>`;
    }
}

async function loadCreditsAdminPane() {
    const usersBody = document.getElementById('creditsUsersTableBody');
    const ordersBody = document.getElementById('ordersTableBody');
    const message = document.getElementById('creditsAdminMessage');
    if (!usersBody || !ordersBody) return;
    try {
        const [usersData, ordersData] = await Promise.all([
            authJSON(API + '/admin/credits/users'),
            authJSON(API + '/admin/orders')
        ]);

        const users = Array.isArray(usersData.items) ? usersData.items : [];
        usersBody.innerHTML = users.length ? users.map((item) => `
            <tr>
              <td>${escapeHTML(userDisplayName(item))}</td>
              <td>${escapeHTML(item.role || '-')}</td>
              <td>${escapeHTML(String(item.credits_balance || 0))}</td>
              <td>${escapeHTML(String(item.lifetime_credits_granted || 0))}</td>
              <td>${escapeHTML(String(item.lifetime_credits_spent || 0))}</td>
              <td>${item.needs_removal ? `<span class="status-tag status-tag--danger">Flagged until positive</span>` : '<span class="subtle-text">No</span>'}</td>
              <td class="table-actions">
                <button class="btn" type="button" data-credit-user="${escapeHTML(item.id)}" data-credit-action="details">Details</button>
                <button class="btn" type="button" data-credit-user="${escapeHTML(item.id)}" data-credit-action="add">Add</button>
                <button class="btn btn-danger" type="button" data-credit-user="${escapeHTML(item.id)}" data-credit-action="remove">Remove</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="7">No users found.</td></tr>';

        usersBody.querySelectorAll('[data-credit-user]').forEach((button) => {
            button.addEventListener('click', async () => {
                if (button.dataset.creditAction === 'details') {
                    await loadUserCreditReceipt(button.dataset.creditUser);
                    return;
                }
                const amountText = window.prompt(`${button.dataset.creditAction === 'add' ? 'Add' : 'Remove'} how many credits?`, '10');
                if (amountText === null) return;
                const amount = Math.round(Number(amountText || 0));
                if (!Number.isFinite(amount) || amount <= 0) return;
                const signedAmount = button.dataset.creditAction === 'remove' ? -amount : amount;
                const note = window.prompt('Reason / note for this adjustment', button.dataset.creditAction === 'remove' ? 'Manual removal' : 'Manual credit grant') || '';
                try {
                    await authJSON(API + '/admin/users/' + button.dataset.creditUser + '/credits', { method: 'POST', body: JSON.stringify({ amount: signedAmount, note }) });
                    if (message) message.textContent = 'Credits updated.';
                    await loadCreditsAdminPane();
                    await loadUserCreditReceipt(button.dataset.creditUser);
                } catch (err) {
                    if (message) message.textContent = err.message;
                }
            });
        });

        const orders = Array.isArray(ordersData.items) ? ordersData.items : [];
        ordersBody.innerHTML = orders.length ? orders.map((item) => `
            <tr>
              <td>${escapeHTML(formatEasternTime(item.created_at || ''))} ET</td>
              <td>${escapeHTML(item.user_email || '-')}</td>
              <td>${escapeHTML(item.source || '-')}</td>
              <td>${escapeHTML(item.product_name || item.sku || '-')}</td>
              <td>${String(item.status || '') === 'insufficient_credits' ? '<span class="status-tag status-tag--danger">Insufficient Credits</span>' : '<span class="status-tag status-tag--success">Charged</span>'}</td>
              <td>${escapeHTML(String(item.credits_charged || 0))}</td>
              <td>${escapeHTML(item.external_order_id || '-')}</td>
              <td><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                ${Number(item.credits_charged || 0) > 0 ? `<button class="btn" type="button" data-refund-order="${escapeHTML(item.id)}" data-refund-amount="${escapeHTML(String(item.credits_charged || 0))}">Refund Credits</button>` : '<span class="subtle-text">No charge</span>'}
                <button class="btn secondary" type="button" data-recheck-order="${escapeHTML(item.id)}">Recheck Credits</button>
                <button class="btn secondary" type="button" data-recheck-item-order="${escapeHTML(item.id)}">Check Order For Item</button>
              </div></td>
            </tr>`).join('') : '<tr><td colspan="8">No orders found yet.</td></tr>';

        ordersBody.querySelectorAll('[data-recheck-order]').forEach((button) => {
            button.addEventListener('click', async () => {
                await recheckOrderCredits(button.dataset.recheckOrder, button);
            });
        });

        ordersBody.querySelectorAll('[data-recheck-item-order]').forEach((button) => {
            button.addEventListener('click', async () => {
                await recheckOrderItem(button.dataset.recheckItemOrder, button);
            });
        });

        ordersBody.querySelectorAll('[data-refund-order]').forEach((button) => {
            button.addEventListener('click', async () => {
                const amountText = window.prompt('Refund how many credits?', button.dataset.refundAmount || '0');
                if (amountText === null) return;
                const amount = Math.round(Number(amountText || 0));
                if (!Number.isFinite(amount) || amount <= 0) return;
                const note = window.prompt('Refund note', 'Order canceled') || '';
                try {
                    await authJSON(API + '/admin/orders/' + button.dataset.refundOrder + '/refund-credits', { method: 'POST', body: JSON.stringify({ amount, note }) });
                    if (message) message.textContent = 'Credits refunded.';
                    await loadCreditsAdminPane();
                } catch (err) {
                    if (message) message.textContent = err.message;
                }
            });
        });
    } catch (err) {
        usersBody.innerHTML = `<tr><td colspan="6">${escapeHTML(err.message)}</td></tr>`;
        ordersBody.innerHTML = `<tr><td colspan="7">${escapeHTML(err.message)}</td></tr>`;
    }
}




async function copyTextToClipboard(text) {
    const value = String(text || '');
    try {
        await navigator.clipboard.writeText(value);
    } catch (_) {
        const temp = document.createElement('textarea');
        temp.value = value;
        temp.setAttribute('readonly', '');
        temp.style.position = 'fixed';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
    }
}

function skusFromProductSelectionLines(lines = []) {
    return [...new Set((Array.isArray(lines) ? lines : [])
        .flatMap((line) => String(line || '').split(/\n+/))
        .map((line) => line.split(';')[0].trim())
        .filter(Boolean))];
}

function renderProductSelectionExportBoxes(users = [], format = 'stellar') {
    const results = document.getElementById('productSelectionExportResults');
    if (!results) return;
    const boxes = [];
    users.forEach((user) => {
        const display = user.user_display || user.user_email || 'User';
        if (format === 'shikari') {
            const text = skusFromProductSelectionLines(user.lines).join(', ');
            if (text) boxes.push({ title: `${display} - Shikari SKUs`, text, count: skusFromProductSelectionLines(user.lines).length });
            return;
        }
        const batches = Array.isArray(user.batches) && user.batches.length ? user.batches : chunkArray(Array.isArray(user.lines) ? user.lines : [], 29);
        batches.forEach((batch, index) => {
            boxes.push({ title: `${display} - Stellar Batch ${index + 1}`, text: batch.join('\n'), count: batch.length });
        });
    });
    if (!boxes.length) {
        results.innerHTML = '';
        return;
    }
    results.innerHTML = boxes.map((box, idx) => `
        <section class="panel panel--inner">
          <div class="panel-header"><div><h3>${escapeHTML(box.title)}</h3><p class="subtle-text">${box.count} SKU${box.count === 1 ? '' : 's'}</p></div><div class="panel-actions"><button class="btn" type="button" data-copy-selection-box="${idx}">Copy ${format === 'shikari' ? 'Shikari List' : 'Batch'}</button></div></div>
          <textarea class="input" rows="${format === 'shikari' ? 4 : Math.min(14, Math.max(6, box.count + 1))}" readonly>${escapeHTML(box.text)}</textarea>
        </section>
    `).join('');
    results.querySelectorAll('[data-copy-selection-box]').forEach((button) => {
        button.addEventListener('click', async () => {
            const box = boxes[Number(button.dataset.copySelectionBox)];
            await copyTextToClipboard(box?.text || '');
            const original = button.textContent;
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = original; }, 1200);
        });
    });
}

function chunkArray(items = [], size = 29) {
    const out = [];
    const n = Math.max(1, Number(size) || 29);
    for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
    return out;
}

async function clearProductSelectionsForSelectedStore() {
    const site = document.getElementById("productSelectionExportSite")?.value || "target";
    const message = document.getElementById("productSelectionExportMessage");
    if (!["target", "amazon", "samsclub"].includes(site)) {
        if (message) message.textContent = "Only Target, Sam's Club, or Amazon selections can be cleared.";
        return;
    }
    if (!confirm(`Clear all saved ${site} product selections for users you manage? Users will need to reselect with the new limits.`)) return;

    try {
        if (message) message.textContent = `Clearing ${site} selections...`;
        await authJSON(API + "/admin/product-selections/clear?site=" + encodeURIComponent(site), { method: "DELETE" });
        if (message) message.textContent = `Cleared all ${site} selections.`;
        const output = document.getElementById("productSelectionExportText");
        if (output) output.value = "";
        await loadProductSelectionChanges();
    } catch (err) {
        if (message) message.textContent = err.message || "Could not clear selections.";
    }
}

async function loadProductSelectionChanges() {
    const body = document.getElementById("productSelectionChangesBody");
    if (!body) return;
    body.innerHTML = '<tr><td colspan="6">Loading changes...</td></tr>';
    try {
        const data = await authJSON(API + "/admin/product-selection-changes");
        const items = Array.isArray(data.items) ? data.items : [];
        body.innerHTML = items.length ? items.map((item) => {
            const product = item.product || {};
            return `<tr>
                <td>${escapeHTML(formatDateTime(item.created_at))}</td>
                <td>${escapeHTML(userExportDisplayName(item))}</td>
                <td>${escapeHTML(item.site || "-")}</td>
                <td>${escapeHTML(item.action || "-")}</td>
                <td>${escapeHTML(product.sku || "-")}</td>
                <td>${escapeHTML(product.product_name || product.sku || "-")}</td>
            </tr>`;
        }).join("") : '<tr><td colspan="6">No selection changes yet.</td></tr>';
    } catch (err) {
        body.innerHTML = `<tr><td colspan="6">${escapeHTML(err.message || "Could not load changes.")}</td></tr>`;
    }
}

let productSelectionExportUsersCache = [];

function updateProductSelectionExportStatusBanner() {
    const banner = document.getElementById("productSelectionExportStatus");
    const select = document.getElementById("productSelectionExportUser");
    const siteSelect = document.getElementById("productSelectionExportSite");
    if (!banner || !select) return;

    const siteLabel = siteSelect?.selectedOptions?.[0]?.textContent || "this store";
    const userId = select.value || "";
    banner.className = "export-sync-banner export-sync-banner--neutral";

    if (!productSelectionExportUsersCache.length) {
        banner.textContent = `No users currently have selected products for ${siteLabel}.`;
        return;
    }

    if (!userId) {
        const pending = productSelectionExportUsersCache.filter((user) => user.changed_since_export).length;
        const synced = productSelectionExportUsersCache.length - pending;
        if (pending > 0) {
            banner.className = "export-sync-banner export-sync-banner--pending";
            banner.textContent = `Needs attention: ${pending} user${pending === 1 ? "" : "s"} have ${siteLabel} product changes that have not been marked copied. ${synced} synced.`;
        } else {
            banner.className = "export-sync-banner export-sync-banner--synced";
            banner.textContent = `All ${siteLabel} user product exports are synced. Products are running properly.`;
        }
        return;
    }

    const user = productSelectionExportUsersCache.find((row) => row.user_id === userId);
    if (!user) {
        banner.textContent = "Choose a user to check export status.";
        return;
    }

    if (user.changed_since_export) {
        banner.className = "export-sync-banner export-sync-banner--pending";
        banner.textContent = `Needs export update: ${userExportDisplayName(user)} changed ${siteLabel} selections. Copy the updated list, then click Mark Copied.`;
    } else {
        banner.className = "export-sync-banner export-sync-banner--synced";
        banner.textContent = `Export synced: ${userExportDisplayName(user)} has no new ${siteLabel} product changes. All products are running properly.`;
    }
}

async function loadProductSelectionExportUsers() {
    const select = document.getElementById("productSelectionExportUser");
    const site = document.getElementById("productSelectionExportSite")?.value || "target";
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">All users</option>';
    try {
        const data = await authJSON(API + "/admin/product-selection-export-users?site=" + encodeURIComponent(site));
        const users = Array.isArray(data.users) ? data.users : [];
        productSelectionExportUsersCache = users;
        users.forEach((user) => {
            const option = document.createElement("option");
            option.value = user.user_id;
            option.textContent = `${user.changed_since_export ? "🔴" : "🟢"} ${userExportDisplayName(user)} (${user.selection_count})${user.changed_since_export ? " - needs update" : " - synced"}`;
            option.dataset.changed = user.changed_since_export ? "1" : "0";
            select.appendChild(option);
        });
        if (currentValue && users.some((user) => user.user_id === currentValue)) select.value = currentValue;
        updateProductSelectionExportStatusBanner();
    } catch (_) {
        productSelectionExportUsersCache = [];
        updateProductSelectionExportStatusBanner();
    }
}

async function loadProductSelectionExport(format = 'stellar') {
    const site = document.getElementById("productSelectionExportSite")?.value || "target";
    const userId = document.getElementById("productSelectionExportUser")?.value || "";
    const output = document.getElementById("productSelectionExportText");
    const results = document.getElementById("productSelectionExportResults");
    const message = document.getElementById("productSelectionExportMessage");
    if (!output) return;
    if (message) message.textContent = format === 'shikari' ? "Loading Shikari export..." : "Loading Stellar export...";
    try {
        const qs = new URLSearchParams({ site });
        if (userId) qs.set("user_id", userId);
        const data = await authJSON(API + "/admin/product-selections/export?" + qs.toString());
        const users = Array.isArray(data.users) ? data.users : [];
        if (format === 'shikari') {
            const shikariText = users.map((user) => skusFromProductSelectionLines(user.lines).join(', ')).filter(Boolean).join('\n\n');
            output.value = shikariText;
            renderProductSelectionExportBoxes(users, 'shikari');
        } else {
            output.value = data.text || "";
            renderProductSelectionExportBoxes(users, 'stellar');
        }
        const count = userId ? (users[0]?.lines?.length || 0) : users.length;
        if (message) message.textContent = userId
            ? `Loaded ${count} selected product${count === 1 ? "" : "s"} for this user.`
            : `Loaded ${users.length} user export${users.length === 1 ? "" : "s"}.`;
        updateProductSelectionExportStatusBanner();
    } catch (err) {
        if (results) results.innerHTML = '';
        if (message) message.textContent = err.message || "Could not load export.";
    }
}

async function loadProductSelectionShikariExport() {
    return loadProductSelectionExport('shikari');
}

async function copyProductSelectionExport() {
    const output = document.getElementById("productSelectionExportText");
    const message = document.getElementById("productSelectionExportMessage");
    if (!output) return;
    await copyTextToClipboard(output.value || "");
    if (message) message.textContent = "Copied export to clipboard.";
}

async function markProductSelectionExported() {
    const site = document.getElementById("productSelectionExportSite")?.value || "target";
    const userId = document.getElementById("productSelectionExportUser")?.value || "";
    const message = document.getElementById("productSelectionExportMessage");
    if (!userId) {
        if (message) message.textContent = "Choose one user before marking copied.";
        return;
    }
    try {
        await authJSON(API + "/admin/product-selections/mark-exported", {
            method: "POST",
            body: JSON.stringify({ site, user_id: userId })
        });
        if (message) message.textContent = "Marked this user's list as copied. Future user changes will show as changed.";
        await loadProductSelectionExportUsers();
    } catch (err) {
        if (message) message.textContent = err.message || "Could not mark copied.";
    }
}

async function loadTargetRecommendedListNameAdmin() {
    const input = document.getElementById("targetRecommendedListNameInput");
    if (!input) return;
    try {
        const data = await authJSON(API + "/admin/target-recommended-list-name");
        input.value = data.name || data.default_name || "";
    } catch (_) { }
}

async function saveTargetRecommendedListNameAdmin() {
    const input = document.getElementById("targetRecommendedListNameInput");
    const message = document.getElementById("targetRecommendedListNameMessage");
    if (!input) return;
    try {
        const data = await authJSON(API + "/admin/target-recommended-list-name", {
            method: "POST",
            body: JSON.stringify({ name: input.value })
        });
        if (message) message.textContent = `Saved. Users will now see this running list as: ${data.name}.`;
    } catch (err) {
        if (message) message.textContent = err.message || "Could not save list name.";
    }
}

function initProductSelectionAdminTools() {
    const refresh = document.getElementById("refreshProductSelectionChangesButton");
    const loadExport = document.getElementById("loadProductSelectionExportButton");
    const copyExport = document.getElementById("copyProductSelectionExportButton");
    const shikariExport = document.getElementById("loadProductSelectionShikariExportButton");
    const markExported = document.getElementById("markProductSelectionExportedButton");
    const siteSelect = document.getElementById("productSelectionExportSite");
    const saveName = document.getElementById("saveTargetRecommendedListNameButton");

    if (refresh && !refresh.dataset.bound) {
        refresh.dataset.bound = "1";
        refresh.addEventListener("click", loadProductSelectionChanges);
    }
    if (loadExport && !loadExport.dataset.bound) {
        loadExport.dataset.bound = "1";
        loadExport.addEventListener("click", () => loadProductSelectionExport('stellar'));
    }
    if (copyExport && !copyExport.dataset.bound) {
        copyExport.dataset.bound = "1";
        copyExport.addEventListener("click", copyProductSelectionExport);
    }
    if (shikariExport && !shikariExport.dataset.bound) {
        shikariExport.dataset.bound = "1";
        shikariExport.addEventListener("click", loadProductSelectionShikariExport);
    }
    if (markExported && !markExported.dataset.bound) {
        markExported.dataset.bound = "1";
        markExported.addEventListener("click", markProductSelectionExported);
    }
    const exportUserSelect = document.getElementById("productSelectionExportUser");
    if (exportUserSelect && !exportUserSelect.dataset.statusBound) {
        exportUserSelect.dataset.statusBound = "1";
        exportUserSelect.addEventListener("change", updateProductSelectionExportStatusBanner);
    }
    if (siteSelect && !siteSelect.dataset.exportUsersBound) {
        siteSelect.dataset.exportUsersBound = "1";
        siteSelect.addEventListener("change", async () => {
            await loadProductSelectionExportUsers();
            const output = document.getElementById("productSelectionExportText");
            const results = document.getElementById("productSelectionExportResults");
            if (output) output.value = "";
            if (results) results.innerHTML = "";
            updateProductSelectionExportStatusBanner();
        });
    }
    if (saveName && !saveName.dataset.bound) {
        saveName.dataset.bound = "1";
        saveName.addEventListener("click", saveTargetRecommendedListNameAdmin);
    }
    const listNameInput = document.getElementById("targetRecommendedListNameInput");
    if (listNameInput && !listNameInput.dataset.bound) {
        listNameInput.dataset.bound = "1";
        listNameInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                saveTargetRecommendedListNameAdmin();
            }
        });
    }
    const clearButton = document.getElementById("clearProductSelectionsButton");
    if (clearButton && !clearButton.dataset.bound) {
        clearButton.dataset.bound = "1";
        clearButton.addEventListener("click", clearProductSelectionsForSelectedStore);
    }
    loadProductSelectionChanges().catch(() => {});
    loadProductSelectionExportUsers().catch(() => {});
    loadTargetRecommendedListNameAdmin().catch(() => {});
}




/* ================= STORE RUN STATUS ================= */

const STORE_RUN_STATUS_OPTIONS = [
    { site: 'target', label: 'Target' },
    { site: 'walmart', label: 'Walmart' },
    { site: 'samsclub', label: "Sam's Club" },
    { site: 'amazon', label: 'Amazon' },
    { site: 'general', label: 'General' },
    { site: 'crunchyroll', label: 'Crunchyroll' },
    { site: 'pokemoncenter', label: 'Pokémon Center' }
];

function formatDateTimeShort(value) {
    if (!value) return 'Never changed';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Never changed';
    return date.toLocaleString();
}

async function loadStoreRunStatusPanel() {
    const panel = document.getElementById('storeRunStatusPanel');
    if (!panel || !token()) return;
    panel.innerHTML = '<div class="empty-card"><p>Loading store run status...</p></div>';
    try {
        const data = await authJSON(API + '/store-run-status');
        const stores = Array.isArray(data.stores) ? data.stores : [];
        const html = `
            <div class="store-run-status-list">
                ${stores.map((store) => `
                    <article class="store-run-card ${store.is_enabled ? 'is-running' : ''}">
                        <div>
                            <h3>${escapeHTML(store.label)}</h3>
                            <p class="subtle-text">${store.is_enabled
                                ? 'Active: The Shore Shack may attempt checkouts for this store.'
                                : 'Paused: Your accounts should not be run for this store.'}</p>
                            <p class="subtle-text">Last updated: ${escapeHTML(formatDateTimeShort(store.updated_at))}</p>
                        </div>
                        <label class="run-toggle">
                            <input type="checkbox" data-store-run-toggle="${escapeHTML(store.site)}" ${store.is_enabled ? 'checked' : ''} />
                            <span>${store.is_enabled ? 'Active' : 'Paused'}</span>
                        </label>
                    </article>
                `).join('')}
            </div>
            <div class="banner banner-soft" style="margin-top:12px;">
                <strong>Important</strong>
                <p class="subtle-text">Active means you are authorizing The Shore Shack to try running that store. It does not guarantee a successful checkout. Paused means your accounts should not be run for that store.</p>
            </div>
        `;
        panel.innerHTML = html;
        panel.querySelectorAll('[data-store-run-toggle]').forEach((input) => {
            input.addEventListener('change', async () => {
                const site = input.dataset.storeRunToggle;
                const enabled = input.checked;
                input.disabled = true;
                try {
                    await authJSON(API + '/store-run-status', {
                        method: 'PUT',
                        body: JSON.stringify({ site, is_enabled: enabled })
                    });
                    await loadStoreRunStatusPanel();
                } catch (err) {
                    input.checked = !enabled;
                    alert(err.message || 'Could not update store run status.');
                } finally {
                    input.disabled = false;
                }
            });
        });
    } catch (err) {
        panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || 'Could not load store run status.')}</p></div>`;
    }
}

async function initAdminStoreRunStatus() {
    const panel = document.getElementById('adminRunStatusPanel');
    const storeFilter = document.getElementById('adminRunStatusStoreFilter');
    const userFilter = document.getElementById('adminRunStatusUserFilter');
    const refreshButton = document.getElementById('adminRunStatusRefreshButton');
    const exportProfilesButton = document.getElementById('adminRunStatusExportProfilesButton');
    const exportStellarProfilesButton = document.getElementById('adminRunStatusExportStellarProfilesButton');
    const exportShikariProfilesButton = document.getElementById('adminRunStatusExportShikariProfilesButton');
    const exportAccountsButton = document.getElementById('adminRunStatusExportAccountsButton');
    const exportGmailButton = document.getElementById('adminRunStatusExportGmailButton');
    const summary = document.getElementById('adminRunStatusSummary');
    if (!panel || !storeFilter || !userFilter) return;

    let lastUsers = [];
    let lastData = null;

    const renderUserOptions = (users) => {
        const current = userFilter.value;
        const byId = new Map();
        (users || []).forEach((user) => {
            if (user && user.id && !byId.has(user.id)) byId.set(user.id, user);
        });
        userFilter.innerHTML = '<option value="">All Users</option>' + [...byId.values()].map((user) =>
            `<option value="${escapeHTML(user.id)}">${escapeHTML(user.user_display || user.email || 'User')}</option>`
        ).join('');
        if ([...userFilter.options].some((opt) => opt.value === current)) userFilter.value = current;
    };

    const activeExportParams = () => {
        const selectedStore = storeFilter.value;
        if (!selectedStore) {
            alert('Select a specific store first, then export active profiles for that store.');
            return null;
        }
        const params = new URLSearchParams();
        params.set('group', selectedStore);
        params.set('active_only', '1');
        if (userFilter.value) params.set('user_id', userFilter.value);
        return params;
    };

    const activeExportFilename = (prefix) => {
        const store = storeFilter.value || 'store';
        const date = new Date().toISOString().slice(0, 10);
        return `${prefix}-${store}-active-${date}`;
    };

    const exportActive = async (endpoint, prefix, ext) => {
        try {
            const params = activeExportParams();
            if (!params) return;
            const filename = promptForExportFilename(activeExportFilename(prefix));
            if (!filename) return;
            params.set('filename', filename);
            await downloadExportFile(API + endpoint + '?' + params.toString(), filename + ext);
        } catch (err) {
            if (err.message) alert(err.message);
        }
    };

    if (exportProfilesButton) exportProfilesButton.addEventListener('click', () => exportActive('/admin/export/profiles-json', 'refract-profiles', '.json'));
    if (exportStellarProfilesButton) exportStellarProfilesButton.addEventListener('click', () => exportActive('/admin/export/profiles-stellar-json', 'stellar-profiles', '.json'));
    if (exportShikariProfilesButton) exportShikariProfilesButton.addEventListener('click', () => exportActive('/admin/export/profiles-shikari-csv', 'shikari-profiles', '.csv'));
    if (exportAccountsButton) exportAccountsButton.addEventListener('click', () => exportActive('/admin/export/accounts-txt', 'accounts', '.txt'));
    if (exportGmailButton) exportGmailButton.addEventListener('click', () => exportActive('/admin/export/gmail-imap-txt', 'gmail-imap', '.txt'));

    const load = async () => {
        panel.innerHTML = '<div class="empty-card"><p>Loading store run status...</p></div>';
        const params = new URLSearchParams();
        if (storeFilter.value) params.set('site', storeFilter.value);
        if (userFilter.value) params.set('user_id', userFilter.value);
        try {
            const data = await authJSON(API + '/admin/store-run-status' + (params.toString() ? `?${params.toString()}` : ''));
            lastData = data;
            const users = Array.isArray(data.users) ? data.users : [];
            if (!userFilter.value) {
                lastUsers = users;
                renderUserOptions(users);
            } else if (!lastUsers.length) {
                lastUsers = users;
                renderUserOptions(users);
                userFilter.value = params.get('user_id') || '';
            }
            const activeSummary = STORE_RUN_STATUS_OPTIONS.map((store) => `${store.label}: ${Number(data.summary?.[store.site] || 0)} active`).join(' • ');
            if (summary) summary.textContent = activeSummary;

            if (!users.length) {
                panel.innerHTML = '<div class="empty-card"><p>No users found for this filter.</p></div>';
                return;
            }

            if (!storeFilter.value && !userFilter.value) {
                const storeTotals = STORE_RUN_STATUS_OPTIONS.map((store) => {
                    let assignedProfiles = 0;
                    let activeAssignedProfiles = 0;
                    let newestRunChange = null;
                    let newestProfileChange = null;
                    users.forEach((user) => {
                        const row = (user.stores || []).find((item) => item.site === store.site);
                        if (!row) return;
                        assignedProfiles += Number(row.profile_count || 0);
                        if (row.is_enabled) activeAssignedProfiles += Number(row.profile_count || 0);
                        if (row.updated_at && (!newestRunChange || new Date(row.updated_at) > new Date(newestRunChange))) newestRunChange = row.updated_at;
                        if (row.profile_updated_at && (!newestProfileChange || new Date(row.profile_updated_at) > new Date(newestProfileChange))) newestProfileChange = row.profile_updated_at;
                    });
                    return { store, assignedProfiles, activeAssignedProfiles, newestRunChange, newestProfileChange, activeUsers: Number(data.summary?.[store.site] || 0) };
                });

                panel.innerHTML = `
                    <table class="admin-table">
                        <thead>
                            <tr>
                                <th>Store</th>
                                <th>Active Users</th>
                                <th>Active Assigned Profiles</th>
                                <th>Total Assigned Profiles</th>
                                <th>Newest Run Change</th>
                                <th>Newest Profile Change</th>
                            </tr>
                        </thead>
                        <tbody>${storeTotals.map((row) => `
                            <tr>
                                <td>${escapeHTML(row.store.label)}</td>
                                <td>${row.activeUsers}</td>
                                <td>${row.activeAssignedProfiles}</td>
                                <td>${row.assignedProfiles}</td>
                                <td>${escapeHTML(formatDateTimeShort(row.newestRunChange))}</td>
                                <td>${escapeHTML(formatDateTimeShort(row.newestProfileChange))}</td>
                            </tr>
                        `).join('')}</tbody>
                    </table>
                    <div class="banner banner-soft" style="margin-top:12px;">
                        <strong>Export active profiles</strong>
                        <p class="subtle-text">Choose a specific store above, then use the export buttons. The export will include only users with that store marked Active.</p>
                    </div>
                `;
                return;
            }

            const rows = [];
            users.forEach((user) => {
                (user.stores || []).forEach((store) => {
                    rows.push(`
                        <tr>
                            <td>${escapeHTML(user.user_display || user.email || 'User')}</td>
                            <td>${escapeHTML(store.label)}</td>
                            <td><span class="status-pill ${store.is_enabled ? 'status-success' : 'status-muted'}">${store.is_enabled ? 'Active' : 'Paused'}</span></td>
                            <td>${Number(store.profile_count || 0)}</td>
                            <td>${escapeHTML(formatDateTimeShort(store.updated_at))}</td>
                            <td>${escapeHTML(formatDateTimeShort(store.profile_updated_at))}</td>
                        </tr>
                    `);
                });
            });

            panel.innerHTML = `
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>User</th>
                            <th>Store</th>
                            <th>Run Status</th>
                            <th>Assigned Profiles</th>
                            <th>Run Status Changed</th>
                            <th>Profile Changed</th>
                        </tr>
                    </thead>
                    <tbody>${rows.join('')}</tbody>
                </table>
            `;
        } catch (err) {
            panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || 'Could not load store run status.')}</p></div>`;
        }
    };

    storeFilter.addEventListener('change', load);
    userFilter.addEventListener('change', load);
    if (refreshButton) refreshButton.addEventListener('click', load);
    await load();
}


document.addEventListener("DOMContentLoaded", async () => {
    if (!requireAuthForPrivatePages()) return;
    try {
        if (token()) { await refreshCurrentUserFromServer(); }
    } catch (_) { }
    try { syncSuperAdminStorefrontLink(); } catch (_) { }
    try { await loadPublicCountdowns(); } catch (_) { }

    if (
        document.getElementById("dashboard") ||
        document.getElementById("targetProfilesPanel") ||
        document.getElementById("walmartProfilesPanel") ||
        document.getElementById("samsclubProfilesPanel") ||
        document.getElementById("amazonProfilesPanel") ||
        document.getElementById("generalProfilesPanel") ||
        document.getElementById("raffleProfilesPanel")
    ) {
        initUserDashboardNavigation();
        await loadProfiles();
        try { await loadStoreRunStatusPanel(); } catch (err) { console.error("Store run status failed:", err); }
        try { await loadStoreProductPanels(); } catch (err) { console.error("Store products failed:", err); }
        try { await loadTargetCheckoutListsForUser(); } catch (err) { console.error("Target checkout lists failed:", err); }
        try { await loadCreditsBalance(); } catch (_) { }
        try { await loadUserActivity(); } catch (_) { }
    }

    if (document.getElementById("profileForm")) {
        await loadProfileEditor();
    }

    if (document.querySelector('[data-admin-nav]')) {
        initAdminSidebar();
    }

    if (document.getElementById("inviteTableBody")) {
        setupInviteControls();
        try { await loadOwnerAdminFilter(); } catch (_) { }
        try { await loadExportAccounts(); } catch (_) { }
        try { await loadInvites(1); } catch (_) { }
        try { await loadUsers(1); } catch (_) { }
        try { updateExportCount(); } catch (_) { }
        try { await initCountdownManager(); } catch (_) { }
        try { await initCatalogTools(); } catch (_) { }
        try { initProductSelectionAdminTools(); } catch (_) { }
        try { initTargetCheckoutListAdmin(); } catch (_) { }
        try { await loadCreditsAdminPane(); } catch (_) { }
        try { await loadWebhookSettings(); } catch (_) { }
        try { await loadAnnouncementSettings(); } catch (_) { }
        try { await initAdminStoreRunStatus(); } catch (_) { }
    }
    if (document.getElementById('userDiscordHandle')) {
        try { await loadUserSettings(); } catch (_) { }
    }
    if (document.getElementById('customCreditsAmount')) {
        try { await loadCreditsBalance(); } catch (_) { }
    }
    try { await initSkuRequestForm(); } catch (_) { }
});


/* ================= FORGOT / RESET PASSWORD ================= */

const forgotPasswordForm = document.getElementById("forgotPasswordForm");
if (forgotPasswordForm) {
    forgotPasswordForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await fetch(API + "/auth/forgot-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: document.getElementById("email").value })
            });
            const data = await res.json();
            const msg = document.getElementById("error");
            msg.innerText = data.error || data.message || "If this email exists, a reset link has been sent.";
            msg.className = data.error ? "error-text" : "success-text";
        } catch {
            const msg = document.getElementById("error");
            msg.innerText = "Could not connect to the server.";
            msg.className = "error-text";
        }
    };
}

const resetPasswordForm = document.getElementById("resetPasswordForm");
if (resetPasswordForm) {
    resetPasswordForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
            const params = new URLSearchParams(window.location.search);
            const tokenValue = params.get("token");
            const res = await fetch(API + "/auth/reset-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    token: tokenValue,
                    newPassword: document.getElementById("newPassword").value
                })
            });
            const data = await res.json();
            const msg = document.getElementById("error");
            msg.innerText = data.error || "Password reset successful. You can now log in.";
            msg.className = data.error ? "error-text" : "success-text";
            if (!data.error) {
                setTimeout(() => { window.location = "login.html"; }, 1200);
            }
        } catch {
            const msg = document.getElementById("error");
            msg.innerText = "Could not connect to the server.";
            msg.className = "error-text";
        }
    };
}

// Toggle explanatory help text blocks such as Gmail app password guidance.
document.addEventListener('click', (event) => {
    const helpButton = event.target.closest('[data-toggle-help]');
    if (!helpButton) return;
    const helpId = helpButton.getAttribute('data-toggle-help');
    const helpEl = helpId ? document.getElementById(helpId) : null;
    if (helpEl) helpEl.hidden = !helpEl.hidden;
});

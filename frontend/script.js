const API =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:3000"
        : "https://profile-platform.onrender.com";

let invitePage = 1;
let usersPage = 1;
const PAGE_SIZE = 10;


let profileImportBound = false;
let raffleBuilderBound = false;
let allDashboardProfiles = [];
let profileGroupFilters = { general: '', walmart: '', target: '', amazon: '', raffle: '' };
let selectedProfileIds = new Set();


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
    const el = document.getElementById("account_type");
    return el ? el.value : "";
}

function toggleAccountCredentialFields() {
    const section = document.getElementById("accountCredentialsSection");
    const gmailFields = document.getElementById("gmailAccountFields");
    const amazonFields = document.getElementById("amazonAccountFields");
    if (!section || !gmailFields || !amazonFields) return;

    const type = selectedAccountType();
    section.style.display = "none";
    gmailFields.style.display = "none";
    amazonFields.style.display = "none";

    if (type === "walmart" || type === "target") {
        section.style.display = "block";
        gmailFields.style.display = "block";
    } else if (type === "amazon") {
        section.style.display = "block";
        amazonFields.style.display = "block";
    }
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
        general: document.getElementById("generalProfilesPanel"),
        walmart: document.getElementById("walmartProfilesPanel"),
        target: document.getElementById("targetProfilesPanel"),
        amazon: document.getElementById("amazonProfilesPanel"),
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
        const groups = { general: [], walmart: [], target: [], amazon: [], raffle: [] };
        profiles.forEach((p) => {
            const key = String(p.account_type || "general").toLowerCase();
            if (groups[key]) groups[key].push(p);
        });

        const setStat = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setStat("profileCountStat", profiles.length);
        setStat("amazonProfileCountStat", groups.amazon.length);
        setStat("retailProfileCountStat", groups.target.length + groups.walmart.length);
        setStat("raffleProfileCountStat", groups.raffle.length);
        setStat("generalProfileCountStat", groups.general.length);

        const labels = {
            general: "General Profiles",
            walmart: "Walmart Profiles",
            target: "Target Profiles",
            amazon: "Amazon Profiles",
            raffle: "Raffle Profiles"
        };

        const descriptions = {
            general: "Flexible profiles for general checkouts.",
            walmart: "Profiles configured for Walmart accounts.",
            target: "Profiles configured for Target accounts.",
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
                                <span class="badge">${escapeHTML(p.account_type || groupKey)}</span>
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
            allDashboardProfiles.filter((p) => p.account_type === group).forEach((p) => {
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
            const ids = allDashboardProfiles.filter((p) => p.account_type === group && selectedProfileIds.has(String(p.id))).map((p) => String(p.id));
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

            message.textContent = `Built ${created} raffle profile${created === 1 ? "" : "s"}. Skipped ${skipped}. Errors ${errors}.`;
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
    const button = document.getElementById('profileImportButton');
    const fileInput = document.getElementById('profileImportFile');
    const typeSelect = document.getElementById('profileImportType');
    const message = document.getElementById('profileImportMessage');
    if (!button || !fileInput || !typeSelect || !message) return;
    profileImportBound = true;
    button.addEventListener('click', async () => {
        message.textContent = '';
        const file = fileInput.files?.[0];
        if (!file) {
            message.textContent = 'Choose a JSON export first.';
            return;
        }
        button.disabled = true;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const profiles = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.profiles) ? parsed.profiles : []);
            if (!profiles.length) throw new Error('No profiles found in that file.');
            const res = await fetch(API + '/profiles/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
                body: JSON.stringify({ account_type: typeSelect.value, profiles })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            message.textContent = `Imported ${data.imported_count || 0}, skipped ${data.skipped_count || 0}, errors ${data.error_count || 0}.`;
            fileInput.value = '';
            await loadProfiles();
        } catch (error) {
            message.textContent = error.message || 'Could not import profiles.';
        } finally {
            button.disabled = false;
        }
    });
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
    if (accountTypeSelect) {
        accountTypeSelect.addEventListener("change", toggleAccountCredentialFields);
    }

    const editId = localStorage.getItem("edit");
    if (!editId) {
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

    toggleAccountCredentialFields();

    if (profile.account_type === "walmart" || profile.account_type === "target") {
        const gmailEmailEl = document.getElementById("account_login_email");
        const gmailPasswordEl = document.getElementById("account_login_password");
        const gmailAppPasswordEl = document.getElementById("gmail_app_password");
        if (gmailEmailEl) gmailEmailEl.value = account.login_email || "";
        if (gmailPasswordEl) gmailPasswordEl.value = account.login_password || "";
        if (gmailAppPasswordEl) gmailAppPasswordEl.value = account.gmail_app_password || "";
    }

    if (profile.account_type === "amazon") {
        const amazonEmailEl = document.getElementById("amazon_login_email");
        const amazonPasswordEl = document.getElementById("amazon_login_password");
        const amazonSecretEl = document.getElementById("amazon_2fa_secret");
        if (amazonEmailEl) amazonEmailEl.value = account.login_email || "";
        if (amazonPasswordEl) amazonPasswordEl.value = account.login_password || "";
        if (amazonSecretEl) amazonSecretEl.value = account.amazon_2fa_secret || "";
    }
}

const profileForm = document.getElementById("profileForm");
if (profileForm) {
    profileForm.onsubmit = async (e) => {
        e.preventDefault();

        const message = document.getElementById("profileMessage");
        const editId = localStorage.getItem("edit");
        const type = account_type.value;

        let accountLoginEmail = "";
        let accountLoginPassword = "";
        let gmailAppPassword = "";
        let amazon2FASecret = "";

        if (type === "walmart" || type === "target") {
            accountLoginEmail = document.getElementById("account_login_email")?.value.trim() || "";
            accountLoginPassword = document.getElementById("account_login_password")?.value.trim() || "";
            gmailAppPassword = document.getElementById("gmail_app_password")?.value.trim() || "";
        }

        if (type === "amazon") {
            accountLoginEmail = document.getElementById("amazon_login_email")?.value.trim() || "";
            accountLoginPassword = document.getElementById("amazon_login_password")?.value.trim() || "";
            amazon2FASecret = document.getElementById("amazon_2fa_secret")?.value.trim() || "";
        }

        const payload = {
            profile_name: profile_name.value.trim(),
            account_type: account_type.value,
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
            account_login_email: accountLoginEmail,
            account_login_password: accountLoginPassword,
            gmail_app_password: gmailAppPassword,
            amazon_2fa_secret: amazon2FASecret
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

    if (!roleSelect || !quantitySelect) return;

    const selectedRole = roleSelect.value;
    const superAdmin = isSuperAdmin();

    if (!superAdmin && selectedRole === "admin") {
        roleSelect.value = "user";
        quantitySelect.disabled = false;
        return;
    }

    if (selectedRole === "admin") {
        quantitySelect.value = "1";
        quantitySelect.disabled = true;
    } else {
        quantitySelect.disabled = false;
    }
}

function setupInviteControls() {
    const roleSelect = document.getElementById("inviteRoleSelect");
    const quantitySelect = document.getElementById("inviteQuantitySelect");

    if (!roleSelect || !quantitySelect) return;

    if (!isSuperAdmin()) {
        roleSelect.innerHTML = `<option value="user">User Invite</option>`;
    }

    handleInviteRoleChange();
}

async function createInvite(inviteRole = "user", quantity = 1) {
    const resultBox = document.getElementById("inviteResult");
    if (!resultBox) return;

    const res = await fetch(API + "/admin/create-invite", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token()
        },
        body: JSON.stringify({
            invite_role: inviteRole,
            quantity
        })
    });

    const data = await res.json();

    if (data.error) {
        resultBox.innerText = data.error;
        return;
    }

    const codes = Array.isArray(data.codes) ? data.codes : [];

    if (codes.length === 1) {
        resultBox.innerText = `${inviteRole === "admin" ? "Admin" : "User"} invite created: ${codes[0]}`;
    } else {
        resultBox.innerText = `${inviteRole === "admin" ? "Admin" : "User"} invites created: ${codes.join(", ")}`;
    }

    invitePage = 1;
    loadInvites(1);
}

async function submitInviteCreation() {
    const roleSelect = document.getElementById("inviteRoleSelect");
    const quantitySelect = document.getElementById("inviteQuantitySelect");

    const inviteRole = roleSelect ? roleSelect.value : "user";
    const quantity = quantitySelect ? Number(quantitySelect.value || 1) : 1;

    return createInvite(inviteRole, quantity);
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
                    <td>${u.email}</td>
                    <td>${u.role}</td>
                    <td>${u.owner_admin_email || (u.owner_admin_id ? u.owner_admin_id : "-")}</td>
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
    if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
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
                body: JSON.stringify({ site: siteSelect.value, sku: skuInput.value })
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
            if (exportResults) exportResults.innerHTML = '<div class="subtle-text">Building export batches...</div>';
            try {
                const site = document.getElementById('catalogExportSite').value;
                const batchSize = document.getElementById('catalogExportBatchSize').value || '29';
                const qs = new URLSearchParams({ site, batchSize });
                const data = await authJSON(API + '/admin/catalog-products/export-lines?' + qs.toString());
                const batches = Array.isArray(data.batches) ? data.batches : [];
                if (!batches.length) {
                    if (exportResults) exportResults.innerHTML = '<div class="subtle-text">No products found to export.</div>';
                    return;
                }
                if (exportResults) {
                    exportResults.innerHTML = batches.map((batch) => `
                        <section class="panel panel--inner">
                          <div class="panel-header"><div><h3>${escapeHTML(site.toUpperCase())} Batch ${batch.index}</h3><p class="subtle-text">${batch.count} products</p></div></div>
                          <textarea class="input" rows="${Math.min(14, Math.max(6, batch.count + 1))}" readonly>${escapeHTML(batch.text)}</textarea>
                        </section>
                    `).join('');
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

async function loadWebhookLogs() {
    const container = document.getElementById('webhookLogs');
    if (!container) return;
    try {
        container.textContent = 'Loading webhook logs...';
        const data = await authJSON(API + '/admin/webhooks/logs');
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
            return `
            <tr>
              <td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td>
              <td>${escapeHtml(item.type || '-')}</td>
              <td>${escapeHtml(item.status || '-')}</td>
              <td>${escapeHtml(item.site || '-')}</td>
              <td>${escapeHtml(item.product_type || '-')}</td>
              <td style="max-width:280px;word-break:break-word;">${escapeHtml(item.product || '-')}</td>
              <td>${escapeHtml(item.sku || '-')}</td>
              <td style="max-width:360px;word-break:break-word;">${escapeHtml(item.error || '')}${details}${targetDetails}${payloadDetails}</td>
            </tr>`;
        }).join('');
        container.innerHTML = `
            <div style="overflow:auto;">
              <table class="admin-table">
                <thead><tr><th>Time</th><th>Type</th><th>Status</th><th>Site</th><th>Product Type</th><th>Product</th><th>SKU</th><th>Error / Debug</th></tr></thead>
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
    if (!input) return;

    try {
        const data = await authJSON(API + '/user/settings');
        input.value = data.discord_user_id || '';
        if (message) message.textContent = 'Discord settings loaded.';
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
    } catch (err) {
        if (message) message.textContent = err.message;
    }
}



function renderStoreProductCard(product) {
    const title = product.product_name || product.sku || 'Product';
    const sku = product.sku || '-';
    const price = product.default_max_price !== null && product.default_max_price !== undefined ? formatMoney(product.default_max_price) : '—';
    const credits = formatCredits(product.credit_cost || 0);
    const link = product.product_url ? `<a href="${escapeHTML(product.product_url)}" target="_blank" rel="noopener">Open</a>` : '';
    return `
        <article class="store-product-card">
            ${product.image_url ? `<img src="${escapeHTML(product.image_url)}" alt="" />` : ''}
            <div>
                <strong>${escapeHTML(title)}</strong>
                <span>SKU: ${escapeHTML(sku)}</span>
                <span>${escapeHTML(price)} • ${escapeHTML(credits)}</span>
                ${link}
            </div>
        </article>
    `;
}

async function loadStoreProductsForSite(site) {
    const panel = document.getElementById(site + "ProductsPanel");
    if (!panel) return;

    panel.innerHTML = '<div class="subtle-text">Loading products...</div>';

    try {
        const qs = new URLSearchParams({ site });
        const data = await authJSON(API + '/product-catalog?' + qs.toString());
        const products = Array.isArray(data.products) ? data.products : [];
        if (!products.length) {
            panel.innerHTML = '<div class="empty-card"><p>No products are currently listed for this store.</p></div>';
            return;
        }

        panel.innerHTML = `
            <div class="store-product-summary">${products.length} product${products.length === 1 ? '' : 's'} available</div>
            <div class="store-product-scroll">
                <div class="store-product-grid">
                    ${products.map(renderStoreProductCard).join('')}
                </div>
            </div>
        `;
    } catch (err) {
        panel.innerHTML = `<div class="empty-card"><p>${escapeHTML(err.message || 'Could not load products.')}</p></div>`;
    }
}

async function loadStoreProductPanels() {
    await Promise.all(['target', 'walmart', 'amazon', 'general'].map(loadStoreProductsForSite));
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
            <strong>${escapeHTML(user.email || '-')}</strong>
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
              <td>${escapeHTML(item.email || '-')}</td>
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
              <td>${Number(item.credits_charged || 0) > 0 ? `<button class="btn" type="button" data-refund-order="${escapeHTML(item.id)}" data-refund-amount="${escapeHTML(String(item.credits_charged || 0))}">Refund Credits</button>` : '<span class="subtle-text">No charge</span>'}</td>
            </tr>`).join('') : '<tr><td colspan="8">No orders found yet.</td></tr>';

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
        document.getElementById("amazonProfilesPanel") ||
        document.getElementById("generalProfilesPanel") ||
        document.getElementById("raffleProfilesPanel")
    ) {
        initUserDashboardNavigation();
        await loadProfiles();
        try { await loadStoreProductPanels(); } catch (err) { console.error("Store products failed:", err); }
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
        try { await loadCreditsAdminPane(); } catch (_) { }
        try { await loadWebhookSettings(); } catch (_) { }
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

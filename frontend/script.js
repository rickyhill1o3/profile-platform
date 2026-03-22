const API =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:3000"
        : "https://profile-platform.onrender.com";

let invitePage = 1;
let usersPage = 1;
const PAGE_SIZE = 10;


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

function logout() {
    localStorage.clear();
    location = "login.html";
}

function openAdminPanel() {
    location = "admin.html";
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
    const dashboardEl = document.getElementById("dashboard");
    if (!dashboardEl) return;

    let user = currentUser();
    const adminButton = document.getElementById("adminPanelButton");

    try {
        const refreshedUser = await refreshCurrentUserFromServer();
        user = refreshedUser || user;
    } catch (_) {}

    if (adminButton) {
        adminButton.style.display = isAdminRole(user?.role) ? "inline-flex" : "none";
    }

    try {
        const res = await fetch(API + "/profiles", {
            headers: { Authorization: "Bearer " + token() }
        });

        const profiles = await res.json();

        if (!Array.isArray(profiles)) {
            dashboardEl.innerHTML = `${profiles.error || "Could not load profiles."}`;
            return;
        }

        const groups = {
            general: [],
            walmart: [],
            target: [],
            amazon: []
        };

        profiles.forEach((p) => {
            if (groups[p.account_type]) groups[p.account_type].push(p);
        });

        const setStat = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setStat("profileCountStat", profiles.length);
        setStat("amazonProfileCountStat", groups.amazon.length);
        setStat("retailProfileCountStat", groups.target.length + groups.walmart.length);
        setStat("generalProfileCountStat", groups.general.length);

        const labels = {
            general: "General Profiles",
            walmart: "Walmart Profiles",
            target: "Target Profiles",
            amazon: "Amazon Profiles"
        };

        const descriptions = {
            general: "Flexible profiles for general checkouts.",
            walmart: "Profiles configured for Walmart accounts.",
            target: "Profiles configured for Target accounts.",
            amazon: "Profiles configured for Amazon accounts."
        };

        let html = "";

        Object.keys(groups).forEach((groupKey) => {
            const items = groups[groupKey];

            html += `
                <section class="profile-group-section">
                    <div class="profile-group-header">
                        <div>
                            <h3 class="profile-group-title">${labels[groupKey]}</h3>
                            <div class="profile-group-subtitle">${descriptions[groupKey]}</div>
                        </div>
                        <span class="badge">${items.length} saved</span>
                    </div>
            `;

            if (!items.length) {
                html += `
                    <div class="empty-card">
                        <h4>No profiles yet</h4>
                        <p>Create your first ${groupKey} profile.</p>
                        <div class="panel-actions">
                            <button class="btn btn-primary" onclick="createProfile()">Create Profile</button>
                        </div>
                    </div>
                `;
            } else {
                html += `<div class="profile-card-grid">`;

                items.forEach((p) => {
                    const address = p.addresses?.[0] || {};
                    const payment = p.payments?.[0] || {};
                    const state = address.state || "";
                    const city = address.city || "";
                    const maskedCard = maskCard(payment.card_number, payment.card_last4);

                    html += `
                        <article class="profile-card-modern">
                            <div class="profile-card-top">
                                <div>
                                    <h4>${p.profile_name}</h4>
                                    <div class="subtle-text">${city}${city && state ? ", " : ""}${state || "No location set"}</div>
                                </div>
                                <span class="badge">${p.account_type}</span>
                            </div>
                            <div class="profile-detail-list">
                                <div><span>Email</span><strong>${address.email || "-"}</strong></div>
                                <div><span>Phone</span><strong>${address.phone || "-"}</strong></div>
                                <div><span>Card</span><strong>${maskedCard}</strong></div>
                            </div>
                            <div class="panel-actions">
                                <button class="btn" onclick="edit('${p.id}')">Edit</button>
                                <button class="btn btn-danger" onclick="del('${p.id}')">Delete</button>
                            </div>
                        </article>
                    `;
                });

                html += `</div>`;
            }

            html += `</section>`;
        });

        dashboardEl.innerHTML = html;
    } catch {
        dashboardEl.innerHTML = `<p>Could not connect to the server.</p>`;
    }
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
                try { await loadProducts(); } catch (_) {}
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
                <span class="subtle-text">${escapeHTML(countdownSiteLabel(item.site))} • ${escapeHTML(formatEasternTime(item.scheduled_for))} ET</span>
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
              <td>${escapeHTML(item.product_name || '-')}</td>
              <td>${escapeHTML(item.sku || '-')}</td>
              <td>${escapeHTML(formatMoney(item.default_max_price))}</td>
              <td>${item.metadata && item.metadata.virtual ? 'Virtual' : 'Live'}</td>
              <td>${superAdmin ? `<button class="btn btn-danger" type="button" data-delete-catalog-product="${escapeHTML(item.id)}">Delete</button>` : '<span class="subtle-text">Super admin only</span>'}</td>
            </tr>`).join('');
        if (!superAdmin) return;
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

document.addEventListener("DOMContentLoaded", async () => {
    if (!requireAuthForPrivatePages()) return;
    try {
        if (token()) { await refreshCurrentUserFromServer(); }
    } catch (_) {}
    try { await loadPublicCountdowns(); } catch (_) {}

    if (document.getElementById("dashboard")) {
        await loadProfiles();
    }

    if (document.getElementById("profileForm")) {
        await loadProfileEditor();
    }

    if (document.querySelector('[data-admin-nav]')) {
        initAdminSidebar();
    }

    if (document.getElementById("inviteTableBody")) {
        setupInviteControls();
        try { await loadOwnerAdminFilter(); } catch (_) {}
        try { await loadExportAccounts(); } catch (_) {}
        try { await loadInvites(1); } catch (_) {}
        try { await loadUsers(1); } catch (_) {}
        try { updateExportCount(); } catch (_) {}
        try { await initCountdownManager(); } catch (_) {}
        try { await initCatalogTools(); } catch (_) {}
    }
    try { await initSkuRequestForm(); } catch (_) {}
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

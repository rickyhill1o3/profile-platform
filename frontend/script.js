const API =
    window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:3000"
        : "https://profile-platform.onrender.com";

let invitePage = 1;
let usersPage = 1;
const PAGE_SIZE = 10;

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

    const refreshedUser = await refreshCurrentUserFromServer();
    const user = refreshedUser || currentUser();

    const adminButton = document.getElementById("adminPanelButton");
    if (isAdminRole(user?.role) && adminButton) {
        adminButton.style.display = "inline-block";
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
            if (groups[p.account_type]) {
                groups[p.account_type].push(p);
            }
        });

        let html = "";
        Object.keys(groups).forEach((g) => {
            html += `<h2>${g.toUpperCase()} PROFILES</h2>`;

            groups[g].forEach((p) => {
                const address = p.addresses?.[0] || {};
                const payment = p.payments?.[0] || {};
                const state = address.state || "";
                const city = address.city || "";
                const maskedCard = maskCard(payment.card_number, payment.card_last4);

                html += `
          <div class="profile-card">
            <h3>${p.profile_name}</h3>
            <p><strong>Email:</strong> ${address.email || ""}</p>
            <p><strong>Phone:</strong> ${address.phone || ""}</p>
            <p><strong>Card:</strong> ${maskedCard}</p>
            <p><strong>Group:</strong> ${p.account_type}</p>
            <p><strong>Location:</strong> ${city}${city && state ? ", " : ""}${state}</p>
            <div class="row-actions">
              <button onclick="edit('${p.id}')">Edit</button>
              <button onclick="del('${p.id}')">Delete</button>
            </div>
          </div>
        `;
            });

            if (groups[g].length === 0) {
                html += `
          <div class="empty-card">
            <h3>No profiles yet</h3>
            <p>Create your first ${g} profile.</p>
            <button onclick="createProfile()">Create Profile</button>
          </div>
        `;
            }
        });

        dashboardEl.innerHTML = html;
    } catch {
        dashboardEl.innerHTML = `<p>Could not connect to the server.</p>`;
    }
}
loadProfiles();

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
loadProfileEditor();

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

    invitePage = page;

    const res = await fetch(API + `/admin/invites?page=${invitePage}&limit=${PAGE_SIZE}`, {
        headers: { Authorization: "Bearer " + token() }
    });
    const payload = await res.json();

    const invites = Array.isArray(payload) ? payload : (payload.items || []);
    const currentPage = Array.isArray(payload) ? 1 : (payload.page || 1);
    const totalPages = Array.isArray(payload) ? 1 : (payload.total_pages || 1);

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
        tableBody.innerHTML = `No invite codes yet.`;
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
        if (totalPages > 1) {
            pager.innerHTML = `
                <button onclick="loadInvites(${Math.max(1, currentPage - 1)})" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
                <span>Page ${currentPage} of ${totalPages}</span>
                <button onclick="loadInvites(${currentPage + 1})" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
            `;
        } else {
            pager.innerHTML = "";
        }
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

    usersPage = page;

    const refreshedUser = await refreshCurrentUserFromServer();
    const activeUser = refreshedUser || currentUser();

    const ownerFilter = document.getElementById("usersOwnerFilter")?.value || "";
    const roleFilter = document.getElementById("usersRoleFilter")?.value || "";
    const createdAfter = document.getElementById("usersCreatedAfter")?.value || "";
    const createdBefore = document.getElementById("usersCreatedBefore")?.value || "";

    const params = new URLSearchParams();
    params.append("page", usersPage);
    params.append("limit", PAGE_SIZE);

    if (ownerFilter) params.append("owner_admin_id", ownerFilter);
    if (roleFilter) params.append("role", roleFilter);
    if (createdAfter) params.append("created_after", createdAfter);
    if (createdBefore) params.append("created_before", createdBefore);

    const res = await fetch(API + "/admin/users?" + params.toString(), {
        headers: { Authorization: "Bearer " + token() }
    });
    const payload = await res.json();

    const usersData = Array.isArray(payload) ? payload : (payload.items || []);
    const currentPage = Array.isArray(payload) ? 1 : (payload.page || 1);
    const totalPages = Array.isArray(payload) ? 1 : (payload.total_pages || 1);
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
        tableBody.innerHTML = `No users found.`;
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
        if (totalPages > 1) {
            pager.innerHTML = `
                <button onclick="loadUsers(${Math.max(1, currentPage - 1)})" ${currentPage <= 1 ? "disabled" : ""}>Previous</button>
                <span>Page ${currentPage} of ${totalPages}</span>
                <button onclick="loadUsers(${currentPage + 1})" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
            `;
        } else {
            pager.innerHTML = "";
        }
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

const passwordForm = document.getElementById("passwordForm");
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
        msg.innerText = data.error || "Password updated";
    };
}


/* ================= PAGE LOAD ================= */

document.addEventListener("DOMContentLoaded", async () => {
    try {
        await refreshCurrentUserFromServer();

        if (document.getElementById("dashboard")) {
            await loadProfiles();
        }

        if (document.getElementById("profileForm")) {
            await loadProfileEditor();
        }

        if (document.getElementById("inviteTableBody")) {
            setupInviteControls();
            await loadOwnerAdminFilter();
            await loadExportAccounts();
            await loadInvites(1);
            await loadUsers(1);
        }
    } catch (err) {
        console.error(err);
    }
});


const API =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://profile-platform.onrender.com";

let invitePage = 1;
let usersPage = 1;
const PAGE_SIZE = 10;

function token() { return localStorage.getItem("token"); }
function currentUser() { try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; } }
function isAdminRole(role) { return role === "admin" || role === "super_admin"; }
function isSuperAdmin() { return currentUser()?.role === "super_admin"; }
function logout() { localStorage.clear(); location = "login.html"; }
function openAdminPanel() { location = "admin.html"; }
function openUserDashboard() { location = "dashboard.html"; }
function goToChangePassword() { location = "change-password.html"; }
function createProfile() { localStorage.removeItem("edit"); location = "profile.html"; }
function edit(id) { localStorage.edit = id; location = "profile.html"; }
function togglePasswordVisibility(inputId, buttonEl) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  if (buttonEl) buttonEl.textContent = isPassword ? "Hide" : "Show";
}

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || "Request failed");
  return data;
}

async function refreshCurrentUserFromServer() {
  const savedToken = token();
  if (!savedToken) return null;
  try {
    const data = await fetchJSON(API + "/auth/me", {
      headers: { Authorization: "Bearer " + savedToken }
    });
    if (data.user) {
      localStorage.user = JSON.stringify(data.user);
      return data.user;
    }
    return null;
  } catch {
    return null;
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
    gmailFields.style.display = "grid";
  } else if (type === "amazon") {
    section.style.display = "block";
    amazonFields.style.display = "grid";
  }
}

async function loadProfiles() {
  const dashboardEl = document.getElementById("dashboard");
  if (!dashboardEl) return;

  let user = currentUser();
  try { user = (await refreshCurrentUserFromServer()) || user; } catch {}
  const adminButton = document.getElementById("adminPanelButton");
  if (adminButton) adminButton.style.display = isAdminRole(user?.role) ? "inline-flex" : "none";

  try {
    const profiles = await fetchJSON(API + "/profiles", {
      headers: { Authorization: "Bearer " + token() }
    });

    const groups = { general: [], walmart: [], target: [], amazon: [] };
    profiles.forEach((p) => { if (groups[p.account_type]) groups[p.account_type].push(p); });

    const stat = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    stat("profileCountStat", profiles.length);
    stat("amazonProfileCountStat", groups.amazon.length);
    stat("retailProfileCountStat", groups.target.length + groups.walmart.length);
    stat("generalProfileCountStat", groups.general.length);

    const labels = {
      general: "General Profiles",
      walmart: "Walmart Profiles",
      target: "Target Profiles",
      amazon: "Amazon Profiles"
    };
    const descriptions = {
      general: "Flexible profiles for general checkout flows.",
      walmart: "Profiles configured for Walmart accounts.",
      target: "Profiles configured for Target accounts.",
      amazon: "Profiles configured for Amazon accounts."
    };

    let html = "";
    Object.keys(groups).forEach((groupKey) => {
      const items = groups[groupKey];
      html += `
        <section class="profile-group-section">
          <div class="section-heading">
            <div>
              <h3>${labels[groupKey]}</h3>
              <p class="subtle-text">${descriptions[groupKey]}</p>
            </div>
            <span class="badge">${items.length} saved</span>
          </div>
      `;

      if (!items.length) {
        html += `
          <div class="empty-card">
            <h4>No profiles yet</h4>
            <p>Create your first ${groupKey} profile.</p>
            <button class="btn btn-primary" onclick="createProfile()">Create Profile</button>
          </div>
        `;
      } else {
        html += `<div class="profile-card-grid">`;
        items.forEach((p) => {
          const address = p.addresses?.[0] || {};
          const payment = p.payments?.[0] || {};
          const state = address.state || "";
          const city = address.city || "";
          html += `
            <article class="profile-card-modern">
              <div class="profile-card-top">
                <div>
                  <h4>${p.profile_name}</h4>
                  <p class="subtle-text">${city}${city && state ? ", " : ""}${state || "No location set"}</p>
                </div>
                <span class="badge">${p.account_type}</span>
              </div>
              <div class="profile-detail-list">
                <div><span>Email</span><strong>${address.email || "-"}</strong></div>
                <div><span>Phone</span><strong>${address.phone || "-"}</strong></div>
                <div><span>Card</span><strong>${maskCard(payment.card_number, payment.card_last4)}</strong></div>
              </div>
              <div class="panel-actions">
                <button class="btn" onclick="edit('${p.id}')">Edit</button>
                <button class="btn" onclick="del('${p.id}')">Delete</button>
              </div>
            </article>
          `;
        });
        html += `</div>`;
      }
      html += `</section>`;
    });
    dashboardEl.innerHTML = html;
  } catch (err) {
    dashboardEl.innerHTML = `<p class="error-text">${err.message || "Could not connect to the server."}</p>`;
  }
}

async function del(id) {
  await fetch(API + "/profiles/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + token() } });
  location.reload();
}

async function loadProfileEditor() {
  const form = document.getElementById("profileForm");
  if (!form) return;

  let user = currentUser();
  try { user = (await refreshCurrentUserFromServer()) || user; } catch {}
  const adminButton = document.getElementById("adminPanelButtonProfile");
  if (adminButton) adminButton.style.display = isAdminRole(user?.role) ? "inline-flex" : "none";

  const accountTypeSelect = document.getElementById("account_type");
  if (accountTypeSelect) accountTypeSelect.addEventListener("change", toggleAccountCredentialFields);

  const editId = localStorage.getItem("edit");
  if (!editId) { toggleAccountCredentialFields(); return; }

  const profiles = await fetchJSON(API + "/profiles", { headers: { Authorization: "Bearer " + token() } });
  const profile = profiles.find((p) => p.id === editId);
  if (!profile) { toggleAccountCredentialFields(); return; }

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

  const gmailEmailEl = document.getElementById("account_login_email");
  const gmailPasswordEl = document.getElementById("account_login_password");
  const gmailAppPasswordEl = document.getElementById("gmail_app_password");
  const amazonEmailEl = document.getElementById("amazon_login_email");
  const amazonPasswordEl = document.getElementById("amazon_login_password");
  const amazonSecretEl = document.getElementById("amazon_2fa_secret");

  if (gmailEmailEl) gmailEmailEl.value = account.login_email || "";
  if (gmailPasswordEl) gmailPasswordEl.value = account.login_password || "";
  if (gmailAppPasswordEl) gmailAppPasswordEl.value = account.gmail_app_password || "";
  if (amazonEmailEl) amazonEmailEl.value = account.login_email || "";
  if (amazonPasswordEl) amazonPasswordEl.value = account.login_password || "";
  if (amazonSecretEl) amazonSecretEl.value = account.amazon_2fa_secret || "";
}

async function loadInvites(page = invitePage) {
  const tableBody = document.getElementById("inviteTableBody");
  const pager = document.getElementById("invitePagination");
  if (!tableBody) return;
  invitePage = page;
  try {
    const payload = await fetchJSON(API + `/admin/invites?page=${invitePage}&limit=${PAGE_SIZE}`, {
      headers: { Authorization: "Bearer " + token() }
    });
    const invites = Array.isArray(payload) ? payload : (payload.items || []);
    const currentPage = Array.isArray(payload) ? 1 : (payload.page || 1);
    const totalPages = Array.isArray(payload) ? 1 : (payload.total_pages || 1);

    const badge = (invite) => invite.canceled ? "Canceled" : invite.used ? "Used" : "Active";
    tableBody.innerHTML = invites.map((invite) => `
      <tr>
        <td>${invite.code}</td>
        <td>${invite.invite_role || "user"}</td>
        <td>${invite.created_by_email || ""}</td>
        <td>${badge(invite)}</td>
        <td>${new Date(invite.created_at).toLocaleString()}</td>
        <td>${invite.used_by_email || ""}</td>
        <td>
          ${invite.canceled || invite.used ? "" : `<button class="btn" onclick="cancelInvite('${invite.id}')">Cancel</button>`}
        </td>
      </tr>
    `).join("");

    pager.innerHTML = `
      <button class="btn" ${currentPage <= 1 ? "disabled" : ""} onclick="loadInvites(${currentPage - 1})">Prev</button>
      <span class="subtle-text">Page ${currentPage} / ${totalPages}</span>
      <button class="btn" ${currentPage >= totalPages ? "disabled" : ""} onclick="loadInvites(${currentPage + 1})">Next</button>
    `;

    const active = invites.filter((i) => !i.used && !i.canceled).length;
    const used = invites.filter((i) => i.used).length;
    const canceled = invites.filter((i) => i.canceled).length;
    const activeEl = document.getElementById("activeInviteCount");
    const usedEl = document.getElementById("usedInviteCount");
    const canceledEl = document.getElementById("canceledInviteCount");
    if (activeEl) activeEl.textContent = active;
    if (usedEl) usedEl.textContent = used;
    if (canceledEl) canceledEl.textContent = canceled;
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="7">${err.message}</td></tr>`;
    if (pager) pager.innerHTML = "";
  }
}

async function loadUsers(page = usersPage) {
  const tableBody = document.getElementById("usersTableBody");
  const pager = document.getElementById("usersPagination");
  const exportUserFilter = document.getElementById("exportUserFilter");
  if (!tableBody) return;
  usersPage = page;
  try {
    const payload = await fetchJSON(API + `/admin/users?page=${usersPage}&limit=${PAGE_SIZE}`, {
      headers: { Authorization: "Bearer " + token() }
    });
    const users = payload.items || [];
    tableBody.innerHTML = users.map((u) => `
      <tr>
        <td>${u.email}</td>
        <td>${u.role}</td>
        <td>${u.owner_admin_email || ""}</td>
        <td>${u.revoked ? "Revoked" : "Active"}</td>
        <td>${u.profile_count || 0}</td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleString() : ""}</td>
        <td></td>
      </tr>
    `).join("");
    if (exportUserFilter) {
      exportUserFilter.innerHTML = `<option value="">All Accounts</option>` + users.map((u) => `<option value="${u.id}">${u.email}</option>`).join("");
    }
    const userCountEl = document.getElementById("userCount");
    if (userCountEl) userCountEl.textContent = payload.total || users.length;
    pager.innerHTML = `
      <button class="btn" ${payload.page <= 1 ? "disabled" : ""} onclick="loadUsers(${payload.page - 1})">Prev</button>
      <span class="subtle-text">Page ${payload.page} / ${payload.total_pages}</span>
      <button class="btn" ${payload.page >= payload.total_pages ? "disabled" : ""} onclick="loadUsers(${payload.page + 1})">Next</button>
    `;
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="7">${err.message}</td></tr>`;
    if (pager) pager.innerHTML = "";
  }
}

function handleInviteRoleChange() {
  const roleSelect = document.getElementById("inviteRoleSelect");
  const quantitySelect = document.getElementById("inviteQuantitySelect");
  if (!roleSelect || !quantitySelect) return;
  const selectedRole = roleSelect.value;
  if (!isSuperAdmin() && selectedRole === "admin") {
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
  if (!roleSelect) return;
  if (!isSuperAdmin()) roleSelect.innerHTML = `<option value="user">User Invite</option>`;
  handleInviteRoleChange();
}

async function submitInviteCreation() {
  const inviteRole = document.getElementById("inviteRoleSelect")?.value || "user";
  const quantity = Number(document.getElementById("inviteQuantitySelect")?.value || 1);
  const resultBox = document.getElementById("inviteResult");
  try {
    const data = await fetchJSON(API + "/admin/create-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
      body: JSON.stringify({ invite_role: inviteRole, quantity })
    });
    const codes = Array.isArray(data.codes) ? data.codes : [];
    resultBox.textContent = codes.length ? `Created: ${codes.join(", ")}` : "Invite created.";
    loadInvites(1);
  } catch (err) {
    if (resultBox) resultBox.textContent = err.message;
  }
}

async function cancelInvite(id) {
  await fetchJSON(API + `/admin/invites/${id}/cancel`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token() }
  });
  loadInvites(invitePage);
}

function promptForExportFilename(fallback) {
  const value = prompt("Enter export file name:", fallback || "export");
  if (!value) return "";
  return value.trim().replace(/[^a-zA-Z0-9-_]/g, "") || fallback;
}

async function downloadExportFile(url, filename) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token() } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Export failed");
  }
  const blob = await res.blob();
  const objectUrl = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(objectUrl);
}

async function getExportCountAndParams() {
  const params = new URLSearchParams();
  const userId = document.getElementById("exportUserFilter")?.value || "";
  const group = document.getElementById("exportGroupFilter")?.value || "";
  if (userId) params.append("user_id", userId);
  if (group) params.append("group", group);
  return { params };
}

async function updateExportCount() {
  const info = document.getElementById("exportCountInfo");
  if (!info) return;
  const group = document.getElementById("exportGroupFilter")?.value || "";
  const userId = document.getElementById("exportUserFilter")?.value || "";
  info.textContent = `Ready to export ${group || "all groups"}${userId ? " for one user" : ""}.`;
}

async function exportProfilesJson() {
  try {
    const { params } = await getExportCountAndParams();
    const filename = promptForExportFilename("profiles");
    if (!filename) return;
    params.append("filename", filename);
    await downloadExportFile(API + "/admin/export/profiles-json?" + params.toString(), filename + ".json");
  } catch (err) {
    alert(err.message);
  }
}

async function exportAccountsTxt() {
  try {
    const { params } = await getExportCountAndParams();
    const filename = promptForExportFilename("accounts");
    if (!filename) return;
    params.append("filename", filename);
    await downloadExportFile(API + "/admin/export/accounts-txt?" + params.toString(), filename + ".txt");
  } catch (err) {
    alert(err.message);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const data = await fetchJSON(API + "/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value, password: password.value })
        });
        localStorage.token = data.token;
        localStorage.user = JSON.stringify(data.user);
        location = "dashboard.html";
      } catch (err) {
        error.innerText = err.message;
      }
    };
  }

  const signupForm = document.getElementById("signupForm");
  if (signupForm) {
    signupForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await fetchJSON(API + "/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value, password: password.value, invite_code: invite.value })
        });
        alert("Account created");
        location = "login.html";
      } catch (err) {
        error.innerText = err.message;
      }
    };
  }

  const changePasswordForm = document.getElementById("changePasswordForm");
  if (changePasswordForm) {
    changePasswordForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await fetchJSON(API + "/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
          body: JSON.stringify({ oldPassword: oldPassword.value, newPassword: newPassword.value })
        });
        alert("Password changed");
        location = "dashboard.html";
      } catch (err) {
        error.innerText = err.message;
      }
    };
  }

  const forgotPasswordForm = document.getElementById("forgotPasswordForm");
  if (forgotPasswordForm) {
    forgotPasswordForm.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const data = await fetchJSON(API + "/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value })
        });
        error.className = "success-text";
        error.innerText = data.message || "Reset email sent.";
      } catch (err) {
        error.className = "error-text";
        error.innerText = err.message;
      }
    };
  }

  const resetPasswordForm = document.getElementById("resetPasswordForm");
  if (resetPasswordForm) {
    resetPasswordForm.onsubmit = async (e) => {
      e.preventDefault();
      const tokenValue = new URLSearchParams(location.search).get("token");
      try {
        await fetchJSON(API + "/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: tokenValue, newPassword: newPassword.value })
        });
        alert("Password reset");
        location = "login.html";
      } catch (err) {
        error.className = "error-text";
        error.innerText = err.message;
      }
    };
  }

  const profileForm = document.getElementById("profileForm");
  if (profileForm) {
    await loadProfileEditor();
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
      try {
        await fetchJSON(url, {
          method,
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token() },
          body: JSON.stringify(payload)
        });
        localStorage.removeItem("edit");
        location = "dashboard.html";
      } catch (err) {
        message.textContent = err.message;
      }
    };
  }

  if (document.getElementById("dashboard")) await loadProfiles();

  if (document.getElementById("inviteTableBody")) {
    await refreshCurrentUserFromServer();
    setupInviteControls();
    await loadInvites();
    await loadUsers();
    updateExportCount();
  }
});

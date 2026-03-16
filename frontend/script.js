const API = "http://localhost:3000"

function token() {
    return localStorage.getItem("token")
}

function currentUser() {
    try {
        return JSON.parse(localStorage.getItem("user") || "null")
    } catch {
        return null
    }
}

function logout() {
    localStorage.clear()
    location = "login.html"
}

function openAdminPanel() {
    location = "admin.html"
}

function openUserDashboard() {
    location = "dashboard.html"
}

function goToChangePassword() {
    location = "change-password.html"
}

function scrollToSection(id) {
    const el = document.getElementById(id)
    if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" })
    }
}

function maskCard(cardNumber, fallbackLast4 = "") {
    const digits = (cardNumber || "").replace(/\D/g, "")
    const last4 = digits.slice(-4) || fallbackLast4 || "----"
    return "**** **** **** " + last4
}

/* ================= LOGIN ================= */

const loginForm = document.getElementById("loginForm")

if (loginForm) {
    loginForm.onsubmit = async (e) => {
        e.preventDefault()

        const res = await fetch(API + "/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: email.value,
                password: password.value
            })
        })

        const data = await res.json()

        if (data.error) {
            error.innerText = data.error
            return
        }

        localStorage.token = data.token
        localStorage.user = JSON.stringify(data.user)

        if (data.user.role === "admin") {
            location = "admin.html"
        } else {
            location = "dashboard.html"
        }
    }
}

/* ================= SIGNUP ================= */

const signupForm = document.getElementById("signupForm")

if (signupForm) {
    signupForm.onsubmit = async (e) => {
        e.preventDefault()

        const res = await fetch(API + "/auth/signup", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                email: email.value,
                password: password.value,
                invite_code: invite.value
            })
        })

        const data = await res.json()

        if (data.error) {
            error.innerText = data.error
            return
        }

        alert("Account created")
        location = "login.html"
    }
}

/* ================= DASHBOARD ================= */

async function loadProfiles() {
    if (!document.getElementById("dashboard")) return

    const user = currentUser()
    const adminButton = document.getElementById("adminPanelButton")

    if (user?.role === "admin" && adminButton) {
        adminButton.style.display = "inline-block"
    }

    const res = await fetch(API + "/profiles", {
        headers: {
            Authorization: "Bearer " + token()
        }
    })

    const profiles = await res.json()

    if (!Array.isArray(profiles)) {
        dashboard.innerHTML = `<p>${profiles.error || "Could not load profiles."}</p>`
        return
    }

    const groups = {
        general: [],
        walmart: [],
        target: [],
        amazon: []
    }

    profiles.forEach((p) => {
        if (groups[p.account_type]) {
            groups[p.account_type].push(p)
        }
    })

    let html = ""

    Object.keys(groups).forEach((g) => {
        html += `
      <div class="profile-group">
        <h2>${g.toUpperCase()} PROFILES</h2>
        <div class="profile-grid">
    `

        groups[g].forEach((p) => {
            const address = p.addresses?.[0] || {}
            const payment = p.payments?.[0] || {}
            const profileEmail = address.email || ""
            const profilePhone = address.phone || ""
            const state = address.state || ""
            const city = address.city || ""
            const maskedCard = maskCard(payment.card_number, payment.card_last4)

            html += `
        <div class="profile-card">
          <h3>${p.profile_name}</h3>
          <p><strong>Email:</strong> ${profileEmail}</p>
          <p><strong>Phone:</strong> ${profilePhone}</p>
          <p><strong>Card:</strong> ${maskedCard}</p>
          <p><strong>Group:</strong> ${p.account_type}</p>
          <p><strong>Location:</strong> ${city}${city && state ? ", " : ""}${state}</p>

          <div class="card-actions">
            <button onclick="edit('${p.id}')">Edit</button>
            <button onclick="del('${p.id}')">Delete</button>
          </div>
        </div>
      `
        })

        if (groups[g].length === 0) {
            html += `
        <div class="profile-card">
          <h3>No profiles yet</h3>
          <p>Create your first ${g} profile.</p>
          <div class="card-actions">
            <button onclick="createProfile()">Create Profile</button>
          </div>
        </div>
      `
        }

        html += `
        </div>
      </div>
    `
    })

    dashboard.innerHTML = html
}

loadProfiles()

function createProfile() {
    localStorage.removeItem("edit")
    location = "profile.html"
}

function edit(id) {
    localStorage.edit = id
    location = "profile.html"
}

async function del(id) {
    await fetch(API + "/profiles/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token() }
    })

    location.reload()
}

/* ================= PROFILE FORM ================= */

async function loadProfileEditor() {
    const form = document.getElementById("profileForm")
    if (!form) return

    const user = currentUser()
    const adminButton = document.getElementById("adminPanelButtonProfile")

    if (user?.role === "admin" && adminButton) {
        adminButton.style.display = "inline-block"
    }

    const editId = localStorage.getItem("edit")
    if (!editId) return

    const res = await fetch(API + "/profiles", {
        headers: {
            Authorization: "Bearer " + token()
        }
    })

    const profiles = await res.json()
    if (!Array.isArray(profiles)) return

    const profile = profiles.find((p) => p.id === editId)
    if (!profile) return

    const addr = profile.addresses?.[0] || {}
    const pay = profile.payments?.[0] || {}

    profile_name.value = profile.profile_name || ""
    account_type.value = profile.account_type || "general"
    first_name.value = addr.first_name || ""
    last_name.value = addr.last_name || ""
    email.value = addr.email || ""
    phone.value = addr.phone || ""
    address1.value = addr.address1 || ""
    city.value = addr.city || ""
    state.value = addr.state || ""
    zip.value = addr.zip || ""
    card.value = pay.card_number || ""
    exp_month.value = pay.exp_month || ""
    exp_year.value = pay.exp_year || ""
    cvv.value = pay.cvv || ""
}

loadProfileEditor()

const profileForm = document.getElementById("profileForm")

if (profileForm) {
    profileForm.onsubmit = async (e) => {
        e.preventDefault()

        const message = document.getElementById("profileMessage")
        const editId = localStorage.getItem("edit")

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
            cvv: cvv.value.trim()
        }

        const url = editId ? API + "/profiles/" + editId : API + "/profiles"
        const method = editId ? "PUT" : "POST"

        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token()
            },
            body: JSON.stringify(payload)
        })

        const data = await res.json()

        if (data.error) {
            message.textContent = data.error
            message.style.color = "#b91c1c"
            return
        }

        localStorage.removeItem("edit")
        location = "dashboard.html"
    }
}

/* ================= ADMIN INVITES ================= */

function inviteStatusBadge(invite) {
    if (invite.canceled) {
        return `<span class="status-badge status-canceled">Canceled</span>`
    }

    if (invite.used) {
        return `<span class="status-badge status-used">Used</span>`
    }

    return `<span class="status-badge status-active">Active</span>`
}

function userStatusBadge(user) {
    if (user.revoked) {
        return `<span class="status-badge status-canceled">Revoked</span>`
    }

    return `<span class="status-badge status-active">Active</span>`
}

async function createInvite() {
    const resultBox = document.getElementById("inviteResult")
    if (!resultBox) return

    const res = await fetch(API + "/admin/create-invite", {
        method: "POST",
        headers: { Authorization: "Bearer " + token() }
    })

    const data = await res.json()

    if (data.error) {
        resultBox.innerText = data.error
        return
    }

    resultBox.innerText = "Latest Invite Code: " + data.code
    loadInvites()
}

async function loadInvites() {
    const tableBody = document.getElementById("inviteTableBody")
    if (!tableBody) return

    const res = await fetch(API + "/admin/invites", {
        headers: { Authorization: "Bearer " + token() }
    })

    const invites = await res.json()

    if (!Array.isArray(invites)) {
        tableBody.innerHTML = `<tr><td colspan="5">Could not load invite codes.</td></tr>`
        return
    }

    const activeCount = invites.filter(i => !i.used && !i.canceled).length
    const usedCount = invites.filter(i => i.used).length
    const canceledCount = invites.filter(i => i.canceled).length

    const activeCounter = document.getElementById("activeInviteCount")
    const usedCounter = document.getElementById("usedInviteCount")
    const canceledCounter = document.getElementById("canceledInviteCount")

    if (activeCounter) activeCounter.textContent = activeCount
    if (usedCounter) usedCounter.textContent = usedCount
    if (canceledCounter) canceledCounter.textContent = canceledCount

    if (invites.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5">No invite codes yet.</td></tr>`
        return
    }

    let html = ""

    invites.forEach((invite) => {
        const usedBy = invite.used_by || "-"
        const createdAt = new Date(invite.created_at).toLocaleString()

        let actionHtml = ""

        if (!invite.used && !invite.canceled) {
            actionHtml = `
        <button onclick="cancelInvite('${invite.id}')">Cancel</button>
        <button class="danger-btn" onclick="deleteInvite('${invite.id}')">Delete</button>
      `
        } else {
            actionHtml = `
        <button class="danger-btn" onclick="deleteInvite('${invite.id}')">Delete</button>
      `
        }

        html += `
      <tr>
        <td><strong>${invite.code}</strong></td>
        <td>${inviteStatusBadge(invite)}</td>
        <td>${createdAt}</td>
        <td>${usedBy}</td>
        <td>${actionHtml}</td>
      </tr>
    `
    })

    tableBody.innerHTML = html
}

async function cancelInvite(id) {
    const res = await fetch(API + "/admin/invites/" + id + "/cancel", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    })

    const data = await res.json()

    if (data.error) {
        alert(data.error)
        return
    }

    loadInvites()
}

async function deleteInvite(id) {
    const res = await fetch(API + "/admin/invites/" + id, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token() }
    })

    const data = await res.json()

    if (data.error) {
        alert(data.error)
        return
    }

    loadInvites()
}

/* ================= ADMIN USERS ================= */

async function loadUsers() {
    const tableBody = document.getElementById("usersTableBody")
    const exportUserFilter = document.getElementById("exportUserFilter")
    if (!tableBody && !exportUserFilter) return

    const res = await fetch(API + "/admin/users", {
        headers: { Authorization: "Bearer " + token() }
    })

    const usersData = await res.json()

    if (!Array.isArray(usersData)) {
        if (tableBody) {
            tableBody.innerHTML = `<tr><td colspan="5">Could not load users.</td></tr>`
        }
        return
    }

    const userCounter = document.getElementById("userCount")
    if (userCounter) {
        userCounter.textContent = usersData.length
    }

    if (tableBody) {
        if (usersData.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5">No users found.</td></tr>`
        } else {
            let html = ""

            usersData.forEach((u) => {
                let actionHtml = `<span class="subtle-text">No action</span>`

                if (u.role !== "admin") {
                    actionHtml = u.revoked
                        ? `<button onclick="restoreUser('${u.id}')">Restore</button>`
                        : `<button class="danger-btn" onclick="revokeUser('${u.id}')">Revoke</button>`
                }

                html += `
          <tr>
            <td>${u.email}</td>
            <td>${u.role}</td>
            <td>${userStatusBadge(u)}</td>
            <td>${new Date(u.created_at).toLocaleString()}</td>
            <td>${actionHtml}</td>
          </tr>
        `
            })

            tableBody.innerHTML = html
        }
    }

    if (exportUserFilter) {
        let options = `<option value="">All Users</option>`
        usersData.forEach((u) => {
            options += `<option value="${u.id}">${u.email}</option>`
        })
        exportUserFilter.innerHTML = options
        updateExportCount()
    }
}

async function revokeUser(id) {
    const res = await fetch(API + "/admin/users/" + id + "/revoke", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    })

    const data = await res.json()

    if (data.error) {
        alert(data.error)
        return
    }

    loadUsers()
}

async function restoreUser(id) {
    const res = await fetch(API + "/admin/users/" + id + "/restore", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token() }
    })

    const data = await res.json()

    if (data.error) {
        alert(data.error)
        return
    }

    loadUsers()
}

/* ================= EXPORT ================= */

async function updateExportCount() {
    const banner = document.getElementById("exportCountBanner")
    const userFilter = document.getElementById("exportUserFilter")
    const groupFilter = document.getElementById("exportGroupFilter")

    if (!banner) return

    const params = new URLSearchParams()

    const selectedUserId = userFilter?.value || ""
    const selectedGroup = groupFilter?.value || ""

    if (selectedUserId) {
        params.append("user_id", selectedUserId)
    }

    if (selectedGroup) {
        params.append("group", selectedGroup)
    }

    const url = API + "/admin/export/count" + (params.toString() ? "?" + params.toString() : "")

    const res = await fetch(url, {
        headers: { Authorization: "Bearer " + token() }
    })

    const data = await res.json()

    if (data.error) {
        banner.textContent = data.error
        return
    }

    const count = data.count || 0
    const selectedUserText =
        userFilter && userFilter.selectedIndex > 0
            ? userFilter.options[userFilter.selectedIndex].text
            : "all users"
    const selectedGroupText = selectedGroup || "all groups"

    if (count === 1) {
        banner.textContent = `1 profile will be exported for ${selectedUserText} in ${selectedGroupText}.`
    } else {
        banner.textContent = `${count} profiles will be exported for ${selectedUserText} in ${selectedGroupText}.`
    }
}

function clearExportFilters() {
    const userFilter = document.getElementById("exportUserFilter")
    const groupFilter = document.getElementById("exportGroupFilter")

    if (userFilter) userFilter.value = ""
    if (groupFilter) groupFilter.value = ""

    updateExportCount()
}

async function exportProfiles() {
    const userFilter = document.getElementById("exportUserFilter")
    const groupFilter = document.getElementById("exportGroupFilter")
    const banner = document.getElementById("exportCountBanner")

    const params = new URLSearchParams()

    if (userFilter && userFilter.value) {
        params.append("user_id", userFilter.value)
    }

    if (groupFilter && groupFilter.value) {
        params.append("group", groupFilter.value)
    }

    const countUrl = API + "/admin/export/count" + (params.toString() ? "?" + params.toString() : "")
    const countRes = await fetch(countUrl, {
        headers: { Authorization: "Bearer " + token() }
    })

    const countData = await countRes.json()

    if (countData.error) {
        if (banner) banner.textContent = countData.error
        return
    }

    if (!countData.count) {
        if (banner) banner.textContent = "0 profiles will be exported."
        alert("No profiles match the selected filters.")
        return
    }

    const url = API + "/admin/export/aycd" + (params.toString() ? "?" + params.toString() : "")

    const res = await fetch(url, {
        headers: { Authorization: "Bearer " + token() }
    })

    const blob = await res.blob()
    const downloadUrl = window.URL.createObjectURL(blob)
    const a = document.createElement("a")

    a.href = downloadUrl
    a.download = "profiles.json"
    a.click()
}

/* ================= CHANGE PASSWORD ================= */

const passwordForm = document.getElementById("passwordForm")

if (passwordForm) {
    passwordForm.onsubmit = async (e) => {
        e.preventDefault()

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
        })

        const data = await res.json()

        msg.innerText = data.error || "Password updated"
    }
}

/* ================= PAGE LOAD ================= */

loadInvites()
loadUsers()
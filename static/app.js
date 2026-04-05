let html5QrcodeScanner = null;
let currentScanMode = null;

function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');

    if (sectionId === 'adjust')    loadAdjustList();
    if (sectionId === 'alerts')    loadAlertList();
    if (sectionId === 'fill')      loadFillList();
    if (sectionId === 'addScript') loadMedDropdown();
    if (sectionId === 'deleteMed') loadDeleteList();
}

function toggleScanner(mode) {
    currentScanMode = mode;
    const scannerDiv = document.getElementById('scanner');

    if (html5QrcodeScanner) {
        html5QrcodeScanner.clear();
        html5QrcodeScanner = null;
        scannerDiv.innerHTML = '';
        return;
    }

    html5QrcodeScanner = new Html5QrcodeScanner("scanner", { fps: 10, qrbox: 250 });
    html5QrcodeScanner.render(onScanSuccess, onScanError);
}

function onScanSuccess(decodedText) {
    if (currentScanMode === 'med') {
        document.getElementById('medBarcode').value = decodedText;
        showManualMed(true);
    } else if (currentScanMode === 'script') {
        document.getElementById('scriptBarcode').value = decodedText;
        showManualScript(true);
    }
    html5QrcodeScanner.clear();
    html5QrcodeScanner = null;
}

function onScanError(err) { /* ignore */ }

// Toggle show/hide — force=true always opens (used by scanner)
function showManualMed(force) {
    const el = document.getElementById('manualMedForm');
    el.style.display = (force || el.style.display === 'none') ? 'block' : 'none';
}

function showManualScript(force) {
    const el = document.getElementById('manualScriptForm');
    el.style.display = (force || el.style.display === 'none') ? 'block' : 'none';
}

// -----------------------------------------------------------------------
// Add medication
// -----------------------------------------------------------------------
async function submitMedication() {
    const name = document.getElementById('medName').value.trim();
    if (!name) {
        alert('Medication name is required');
        return;
    }

    const data = {
        name:            name,
        barcode:         document.getElementById('medBarcode').value.trim(),
        daily_dose:      parseInt(document.getElementById('medDailyDose').value || '1'),
        time_of_day:     '08:00',   // default; overridable via Adjust > Dose Times
        current_qty:     parseInt(document.getElementById('medQty').value || '0'),
        alert_threshold: parseInt(document.getElementById('medAlert').value || '7')
    };

    const response = await fetch('/api/medications', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    });

    if (response.ok) {
        alert('Medication added');
        document.getElementById('medName').value      = '';
        document.getElementById('medBarcode').value   = '';
        document.getElementById('medDailyDose').value = '1';
        document.getElementById('medQty').value       = '0';
        document.getElementById('medAlert').value     = '7';
        document.getElementById('manualMedForm').style.display = 'none';
    } else {
        const err = await response.json();
        alert('Error: ' + (err.error || 'unknown'));
    }
}

// -----------------------------------------------------------------------
// Add prescription
// -----------------------------------------------------------------------
async function loadMedDropdown() {
    // raw=1 returns bare medication names without x{units} suffix
    const response = await fetch('/api/medications?raw=1');
    const meds = await response.json();
    const select = document.getElementById('scriptMedId');
    select.innerHTML = '<option value="">Select medication...</option>';
    // Deduplicate by med_id — API returns one row per prescription joined to med
    const seen = new Set();
    meds.forEach(med => {
        const id   = med.med_id ?? med.id;
        if (seen.has(id)) return;
        seen.add(id);
        const name = med.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        select.innerHTML += `<option value="${id}">${name}</option>`;
    });
}

async function submitScript() {
    const medId = parseInt(document.getElementById('scriptMedId').value);
    if (!medId) {
        alert('Select a medication');
        return;
    }

    const data = {
        med_id:         medId,
        total_repeats:  parseInt(document.getElementById('scriptRepeats').value || '0'),
        units_per_fill: parseInt(document.getElementById('scriptUnits').value || '0'),
        expiry_date:    document.getElementById('scriptExpiry').value,
        barcode:        document.getElementById('scriptBarcode').value.trim()
    };

    const response = await fetch('/api/prescriptions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
    });

    if (response.ok) {
        const result = await response.json();
        alert(result.merged
            ? `Repeats added to existing prescription (merged)`
            : 'Prescription added');
        document.getElementById('scriptMedId').value    = '';
        document.getElementById('scriptRepeats').value  = '';
        document.getElementById('scriptUnits').value    = '';
        document.getElementById('scriptExpiry').value   = '';
        document.getElementById('scriptBarcode').value  = '';
        document.getElementById('manualScriptForm').style.display = 'none';
    } else {
        const err = await response.json();
        alert('Error: ' + (err.error || 'unknown'));
    }
}

// -----------------------------------------------------------------------
// Adjust — save qty / dose
// -----------------------------------------------------------------------
async function saveAdjust(medId) {
    const qtyField   = document.getElementById(`qty-${medId}`);
    const doseField  = document.getElementById(`dose-${medId}`);
    const alertField = document.getElementById(`alert-${medId}`);

    const qty   = parseInt(qtyField.value);
    const dose  = parseInt(doseField.value);
    const alertTh = parseInt(alertField.value);

    const body = {};
    if (!Number.isNaN(qty))     body.current_qty      = qty;
    if (!Number.isNaN(dose))    body.daily_dose       = dose;
    if (!Number.isNaN(alertTh)) body.alert_threshold  = alertTh;

    if (Object.keys(body).length === 0) {
        alert('Nothing to save');
        return;
    }

    const response = await fetch(`/api/medications/${medId}/adjust`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.json();
        alert('Error: ' + (err.error || 'unknown'));
    } else {
        loadAdjustList();
        loadAlertList();
    }
}

// -----------------------------------------------------------------------
// Delete medication
// -----------------------------------------------------------------------
async function deleteMed(medId, btn) {
    // Two-step: first click arms, second click within 3s confirms
    if (btn && !btn.dataset.armed) {
        btn.dataset.armed = '1';
        const orig = btn.textContent;
        btn.textContent = 'Confirm delete?';
        btn.style.background = '#7b0000';
        setTimeout(() => {
            if (btn.dataset.armed) {
                delete btn.dataset.armed;
                btn.textContent = orig;
                btn.style.background = '';
            }
        }, 3000);
        return;
    }
    if (btn) { delete btn.dataset.armed; }

    const res = await fetch(`/api/medications/${medId}`, { method: 'DELETE' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showDeleteMsg('error', 'Error deleting: ' + (err.error || 'unknown'));
        return;
    }
    showDeleteMsg('ok', 'Medication deleted.');
    loadDeleteList();
    loadAlertList();
}

function showDeleteMsg(type, text) {
    let box = document.getElementById('deleteMsg');
    if (!box) return;
    box.style.background = type === 'ok' ? '#d4edda' : '#f8d7da';
    box.style.color      = type === 'ok' ? '#155724' : '#721c24';
    box.textContent = text;
    setTimeout(() => { box.textContent = ''; box.style.background = ''; }, 4000);
}

async function loadDeleteList() {
    const response = await fetch('/api/medications?raw=1');
    const rows     = await response.json();
    const list     = document.getElementById('deleteList');
    if (!list) return;

    // Deduplicate by med_id
    const seen = new Set();
    const meds = [];
    for (const row of rows) {
        const id = row.med_id ?? row.id;
        if (!seen.has(id)) { seen.add(id); meds.push({ id, name: row.name }); }
    }
    meds.sort((a, b) => a.name.localeCompare(b.name));

    if (meds.length === 0) {
        list.innerHTML = '<p>No medications.</p>';
        return;
    }

    list.innerHTML = meds.map(m => {
        const safeName = m.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `
            <div style="display:flex; justify-content:space-between; align-items:center;
                        padding:10px 14px; border:1px solid #ddd; border-radius:4px; margin:5px 0;">
                <span>${safeName}</span>
                <button class="btn-danger" onclick="deleteMed(${m.id}, this)">Delete</button>
            </div>
        `;
    }).join('');
}

// -----------------------------------------------------------------------
// Dose times — add / remove
// -----------------------------------------------------------------------
async function addDose(medId) {
    const t     = document.getElementById(`new-dose-time-${medId}`).value;
    const amt   = parseInt(document.getElementById(`new-dose-amt-${medId}`).value || '1');
    const label = document.getElementById(`new-dose-label-${medId}`).value.trim();

    if (!t) {
        alert('Time is required');
        return;
    }

    const res = await fetch(`/api/medications/${medId}/doses`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ time_of_day: t, amount: amt, label })
    });

    if (!res.ok) {
        const err = await res.json();
        alert('Error adding dose: ' + (err.error || 'unknown'));
        return;
    }
    await syncDoseTotal(medId);
    loadAdjustList();
}

async function removeDose(doseId, medId) {
    const res = await fetch(`/api/doses/${doseId}`, { method: 'DELETE' });
    if (!res.ok) {
        const err = await res.json();
        alert('Error deleting dose: ' + (err.error || 'unknown'));
        return;
    }
    await syncDoseTotal(medId);
    loadAdjustList();
}

// Fetch current dose_times, sum amounts, save as daily_dose
async function syncDoseTotal(medId) {
    const res   = await fetch(`/api/medications/${medId}/doses`);
    const doses = await res.json();
    const total = doses.reduce((sum, d) => sum + (d.amount || 0), 0);
    if (total > 0) {
        await fetch(`/api/medications/${medId}/adjust`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ daily_dose: total })
        });
    }
}

// -----------------------------------------------------------------------
// Alerts
// -----------------------------------------------------------------------
async function checkAlerts() {
    const res  = await fetch('/api/check-alerts', { method: 'POST' });
    const data = await res.json();
    const box  = document.getElementById('alertMessages');
    box.innerHTML = '';
    if (!data.alerts || data.alerts.length === 0) {
        box.innerHTML = '<p style="color:green;">No alerts.</p>';
        return;
    }
    data.alerts.forEach(a => {
        const colour = a.type === 'out' ? '#f8d7da' : '#fff3cd';
        box.innerHTML += `<div style="padding:8px; margin:4px 0; background:${colour}; border-radius:4px;">${a.text}</div>`;
    });
}

// -----------------------------------------------------------------------
// List loaders
// -----------------------------------------------------------------------
let _adjustLoading = false;
async function loadAdjustList() {
    if (_adjustLoading) return;
    _adjustLoading = true;

    try {
        const response = await fetch('/api/medications');
        const meds     = await response.json();

        if (meds.length === 0) {
            document.getElementById('adjustList').innerHTML = '<p>No medications added yet.</p>';
            return;
        }

        // Deduplicate: API returns one row per prescription joined to med
        const seen = new Set();
        const uniqueMeds = [];
        for (const med of meds) {
            const id = med.med_id ?? med.id;
            if (!seen.has(id)) {
                seen.add(id);
                uniqueMeds.push({ ...med, _id: id });
            }
        }

        // Alphabetical order
        uniqueMeds.sort((a, b) => a.name.localeCompare(b.name));

        // Fetch all dose schedules in parallel instead of sequential awaits
        const doseResults = await Promise.all(
            uniqueMeds.map(med => fetch(`/api/medications/${med._id}/doses`).then(r => r.json()))
        );

        // Build all HTML first, then do a single DOM write
        const fragments = [];

        uniqueMeds.forEach((med, idx) => {
            const medId = med._id;
            const qty   = med.current_qty ?? 0;
            const dose  = med.daily_dose  || 1;
            const doses = doseResults[idx];

            // Sum dose times to show in daily total field
            const doseTotal = doses.reduce((sum, d) => sum + (d.amount || 0), 0);
            const effectiveDose = doseTotal > 0 ? doseTotal : dose;

            // Escape name for safe use in onclick attributes
            const safeName = med.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');

            let dosesHtml = '';
            doses.forEach(d => {
                const safeLabel = (d.label || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                dosesHtml += `
                    <div class="dose-row" style="display:flex; gap:6px; align-items:center; margin:4px 0;">
                        <input type="time"   value="${d.time_of_day}" disabled style="width:110px;">
                        <input type="number" value="${d.amount}"      disabled style="width:60px;">
                        <span style="min-width:80px;">${safeLabel}</span>
                        <button type="button" class="btn-danger" onclick="removeDose(${d.id}, ${medId})">Remove</button>
                    </div>
                `;
            });

            dosesHtml += `
                <div style="display:flex; gap:6px; align-items:center; margin-top:6px; flex-wrap:wrap;">
                    <input type="time"   id="new-dose-time-${medId}"  value="08:00"           style="width:110px;">
                    <input type="number" id="new-dose-amt-${medId}"   value="1"               style="width:60px;">
                    <input type="text"   id="new-dose-label-${medId}" placeholder="label (opt)" style="width:140px;">
                    <button type="button" class="btn-success" onclick="addDose(${medId})">Add time</button>
                </div>
            `;

            const alertTh = med.alert_threshold ?? 7;

            fragments.push(`
                <div style="border:1px solid #ddd; border-radius:4px; margin:5px 0; overflow:hidden;">
                    <div onclick="toggleAdjust(${medId})"
                         style="padding:10px 14px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; background:#f8f9fa; user-select:none;">
                        <strong>${safeName}</strong>
                        <span id="arrow-${medId}" style="font-size:0.85em; color:#666;">&#9660;</span>
                    </div>
                    <div id="adjust-body-${medId}" style="display:none; padding:12px; border-top:1px solid #ddd;">
                        <div style="display:flex; gap:16px; flex-wrap:wrap; margin-bottom:10px;">
                            <label style="font-weight:normal;">
                                Current qty
                                <input type="number" id="qty-${medId}"  value="${qty}"  style="width:80px; display:block;">
                            </label>
                            <label style="font-weight:normal;">
                                Alert threshold
                                <input type="number" id="alert-${medId}" value="${alertTh}" style="width:80px; display:block;">
                            </label>
                            <label style="font-weight:normal;">
                                Daily total ${doseTotal > 0 ? '(auto from dose times)' : '(fallback)'}
                                <input type="number" id="dose-${medId}" value="${effectiveDose}" style="width:80px; display:block;" ${doseTotal > 0 ? 'readonly title="Set by dose times sum"' : ''}>
                            </label>
                        </div>
                        <div style="margin-bottom:10px;">
                            <strong>Dose times</strong> (override daily total):<br>
                            ${dosesHtml}
                        </div>
                        <div style="display:flex; gap:8px;">
                            <button onclick="saveAdjust(${medId})" class="btn-success">Save</button>
                        </div>
                    </div>
                </div>
            `);
        });

        // Single DOM write — no intermediate states where buttons are detached
        document.getElementById('adjustList').innerHTML = fragments.join('');
    } finally {
        _adjustLoading = false;
    }
}

// Group flat API rows into { med, scripts[] } — used by alert and fill lists
function groupMedsByScripts(rows) {
    const map = new Map();
    for (const row of rows) {
        const id = row.med_id ?? row.id;
        if (!map.has(id)) {
            map.set(id, {
                _id:             id,
                name:            row.name,
                current_qty:     row.current_qty,
                alert_threshold: row.alert_threshold,
                daily_dose:      row.daily_dose,
                time_of_day:     row.time_of_day,
                scripts: []
            });
        }
        if (row.script_id) {
            map.get(id).scripts.push({
                id:            row.script_id,
                repeats_left:  row.repeats_left,
                units_per_fill: row.units_per_fill,
                expiry_date:   row.expiry_date
            });
        }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadAlertList() {
    const response = await fetch('/api/medications');
    const rows     = await response.json();
    const list     = document.getElementById('alertList');
    const banner   = document.getElementById('alertMessages');
    list.innerHTML   = '';
    banner.innerHTML = '';

    const grouped     = groupMedsByScripts(rows);
    const bannerItems = [];

    grouped.forEach(med => {
        const qty     = med.current_qty ?? 0;
        const alertTh = med.alert_threshold ?? 0;
        const totalRepeats = med.scripts.reduce((s, p) => s + (p.repeats_left || 0), 0);

        // Banner alerts
        if (qty <= 0) {
            bannerItems.push({ colour: '#f8d7da', text: `${med.name} is OUT OF STOCK` });
        } else if (qty <= alertTh) {
            bannerItems.push({ colour: '#fff3cd', text: `${med.name} is low: ${qty} remaining (threshold: ${alertTh})` });
        }
        if (totalRepeats <= 0) {
            bannerItems.push({ colour: '#f8d7da', text: `${med.name} has no prescriptions left` });
        } else if (totalRepeats === 1) {
            bannerItems.push({ colour: '#fff3cd', text: `${med.name} has only 1 repeat left` });
        }

        // Script rows
        let scriptHtml = '';
        if (med.scripts.length === 0) {
            scriptHtml = '<span style="color:#999;">No prescriptions</span>';
        } else {
            med.scripts.forEach(s => {
                const exp = s.expiry_date || 'no expiry';
                scriptHtml += `<div style="font-size:0.9em;">Script #${s.id}: ${s.repeats_left} repeats left | ${s.units_per_fill} units/fill | expires ${exp}</div>`;
            });
        }

        let className = '';
        if (qty <= 0)            className = 'out-stock';
        else if (qty <= alertTh) className = 'low-stock';

        list.innerHTML += `
            <div class="med-item ${className}" style="flex-direction:column; align-items:flex-start;">
                <strong>${med.name}</strong>
                <div>Qty: ${qty} | Alert at: ${alertTh} | Total repeats: ${totalRepeats}</div>
                <div style="margin-top:4px;">${scriptHtml}</div>
            </div>
        `;
    });

    // Render banner
    if (bannerItems.length === 0) {
        banner.innerHTML = '<div style="padding:8px; background:#d4edda; border-radius:4px; color:#155724;">All medications OK</div>';
    } else {
        bannerItems.forEach(a => {
            banner.innerHTML += `<div style="padding:8px; margin:4px 0; background:${a.colour}; border-radius:4px;">${a.text}</div>`;
        });
    }
}

// -----------------------------------------------------------------------
// Fill Prescription
// -----------------------------------------------------------------------
let _fillLoading = false;
async function loadFillList() {
    if (_fillLoading) return;
    _fillLoading = true;

    try {
        const response = await fetch('/api/medications');
        const rows     = await response.json();

        const grouped = groupMedsByScripts(rows);

        if (grouped.length === 0) {
            document.getElementById('fillList').innerHTML = '<p>No medications added yet.</p>';
            return;
        }

        const fragments = [];

        grouped.forEach(med => {
            const qty = med.current_qty ?? 0;
            // Escape name for safe use in onclick attributes
            const safeName = med.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const displayName = med.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');

            // Sort scripts by earliest expiry first (nulls last)
            const scripts = [...med.scripts].sort((a, b) => {
                if (!a.expiry_date) return 1;
                if (!b.expiry_date) return -1;
                return a.expiry_date.localeCompare(b.expiry_date);
            });

            let scriptHtml = '';
            if (scripts.length === 0) {
                scriptHtml = '<span style="color:#999;">No prescriptions on file</span>';
            } else {
                scripts.forEach(s => {
                    const exp      = s.expiry_date || 'no expiry';
                    const canFill  = s.repeats_left > 0;
                    scriptHtml += `
                        <div style="display:flex; align-items:center; gap:10px; margin:4px 0; flex-wrap:wrap;">
                            <span style="font-size:0.9em; ${!canFill ? 'color:#999;' : ''}">
                                ${s.units_per_fill} units | ${s.repeats_left} repeats left | expires ${exp}
                            </span>
                            <button class="btn-success" ${!canFill ? 'disabled style="opacity:0.4;"' : ''}
                                    onclick="fillScript(${s.id}, '${safeName}', ${s.units_per_fill}, this)">
                                Fill (+${s.units_per_fill})
                            </button>
                        </div>
                    `;
                });
            }

            fragments.push(`
                <div style="border:1px solid #ddd; border-radius:4px; margin:5px 0; overflow:hidden;">
                    <div onclick="toggleFill(${med._id})"
                         style="padding:10px 14px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; background:#f8f9fa; user-select:none;">
                        <strong>${displayName}</strong>
                        <span style="font-size:0.85em; color:#666;">
                            In stock: ${qty} &nbsp;
                            <span id="fill-arrow-${med._id}">&#9660;</span>
                        </span>
                    </div>
                    <div id="fill-body-${med._id}" style="display:none; padding:10px 14px; border-top:1px solid #ddd;">
                        ${scriptHtml}
                    </div>
                </div>
            `);
        });

        // Single DOM write
        document.getElementById('fillList').innerHTML = fragments.join('');
    } finally {
        _fillLoading = false;
    }
}

async function fillScript(scriptId, medName, units, btn) {
    // Two-step: first click arms the button, second click fires
    if (btn && !btn.dataset.armed) {
        btn.dataset.armed = '1';
        const orig = btn.textContent;
        btn.textContent = 'Confirm fill?';
        btn.style.background = '#e65c00';
        setTimeout(() => {
            if (btn.dataset.armed) {
                delete btn.dataset.armed;
                btn.textContent = orig;
                btn.style.background = '';
            }
        }, 3000);
        return;
    }
    if (btn) { delete btn.dataset.armed; }

    const res  = await fetch(`/api/prescriptions/${scriptId}/fill`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
        showFillMsg('error', 'Error: ' + (data.error || 'unknown'));
        return;
    }
    showFillMsg('ok', `Filled — added ${data.added} units to stock.`);
    loadFillList();
    loadAlertList();
}

function showFillMsg(type, text) {
    let box = document.getElementById('fillMsg');
    if (!box) {
        box = document.createElement('div');
        box.id = 'fillMsg';
        box.style.cssText = 'padding:8px 12px; border-radius:4px; margin:8px 0; font-weight:bold;';
        const list = document.getElementById('fillList');
        list.parentNode.insertBefore(box, list);
    }
    box.style.background = type === 'ok' ? '#d4edda' : '#f8d7da';
    box.style.color      = type === 'ok' ? '#155724' : '#721c24';
    box.textContent = text;
    setTimeout(() => { box.textContent = ''; box.style.background = ''; }, 4000);
}

// -----------------------------------------------------------------------
// Test deduction
// -----------------------------------------------------------------------
async function runTestDeduction() {
    const val = document.getElementById('testNow').value;
    if (!val) { alert('Select a datetime first'); return; }
    const res  = await fetch('/api/test-deduction-at', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ now: val })
    });
    const data = await res.json();
    alert(data.message || data.error);
    loadAdjustList();
}

async function runTestDeductionReal() {
    const res  = await fetch('/api/test-deduction', { method: 'POST' });
    const data = await res.json();
    alert(data.message || data.error);
    loadAdjustList();
}

function toggleFill(medId) {
    const body  = document.getElementById(`fill-body-${medId}`);
    const arrow = document.getElementById(`fill-arrow-${medId}`);
    const open  = body.style.display === 'none';
    body.style.display = open ? 'block' : 'none';
    arrow.innerHTML    = open ? '&#9650;' : '&#9660;';
}

function toggleAdjust(medId) {
    const body  = document.getElementById(`adjust-body-${medId}`);
    const arrow = document.getElementById(`arrow-${medId}`);
    const open  = body.style.display === 'none';
    body.style.display  = open ? 'block' : 'none';
    arrow.innerHTML     = open ? '&#9650;' : '&#9660;';
}

function saveAndExit() {
    window.close();
}

// -----------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------
showSection('addMed');

let html5QrcodeScanner = null;
let currentScanMode = null;

function showSection(sectionId) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(sectionId).classList.add('active');

  if (sectionId === 'adjust') loadAdjustList();
  if (sectionId === 'alerts') loadAlertList();
  if (sectionId === 'addScript') loadMedDropdown();
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
    showManualMed();
  } else if (currentScanMode === 'script') {
    document.getElementById('scriptBarcode').value = decodedText;
    showManualScript();
  }
  html5QrcodeScanner.clear();
  html5QrcodeScanner = null;
}

function onScanError(err) {
  // ignore scan errors
}

function showManualMed() {
  document.getElementById('manualMedForm').style.display = 'block';
}

function showManualScript() {
  document.getElementById('manualScriptForm').style.display = 'block';
}

// --- Add Medication with duplicate protection and zero-floor checks ---

async function submitMedication() {
  const name    = document.getElementById('medName').value.trim();
  const barcode = document.getElementById('medBarcode').value.trim();

  if (!name) {
    alert('Medication name is required');
    return;
  }

  // Front-end duplicate check by name or barcode
  try {
    const existingRes = await fetch('/api/medications');
    if (existingRes.ok) {
      const existing = await existingRes.json();
      const dup = existing.find(m =>
        (name && m.name && m.name.toLowerCase() === name.toLowerCase()) ||
        (barcode && m.barcode && m.barcode === barcode)
      );
      if (dup) {
        alert('Medication already exists. Use Adjust to change quantity.');
        return;
      }
    }
  } catch (e) {
    // if this fails, we still continue and let backend enforce uniqueness
  }

  const dailyDose = parseInt(document.getElementById('medDailyDose').value || '1', 10);
  const currentQty = parseInt(document.getElementById('medQty').value || '0', 10);
  const alertThreshold = parseInt(document.getElementById('medAlert').value || '7', 10);

  if (currentQty < 0) {
    alert("Quantity can't be negative");
    return;
  }

  const data = {
    name,
    barcode,
    daily_dose: isNaN(dailyDose) ? 1 : dailyDose,
    time_of_day: document.getElementById('medTime').value,
    current_qty: isNaN(currentQty) ? 0 : currentQty,
    alert_threshold: isNaN(alertThreshold) ? 7 : alertThreshold
  };

  const response = await fetch('/api/medications', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });

  if (response.ok) {
    alert('Medication added');
    document.getElementById('medName').value = '';
    document.getElementById('medBarcode').value = '';
    document.getElementById('medDailyDose').value = '1';
    document.getElementById('medTime').value = '08:00';
    document.getElementById('medQty').value = '0';
    document.getElementById('medAlert').value = '';
  } else {
    const err = await response.json().catch(() => ({}));
    alert('Error: ' + (err.error || 'unknown'));
  }
}

// --- Script ---

async function submitScript() {
  const data = {
    med_id: parseInt(document.getElementById('scriptMedId').value, 10),
    total_repeats: parseInt(document.getElementById('scriptRepeats').value || '0', 10),
    expiry_date: document.getElementById('scriptExpiry').value,
    barcode: document.getElementById('scriptBarcode').value
  };

  const response = await fetch('/api/prescriptions', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });

  if (response.ok) {
    alert('Prescription added');
    document.getElementById('scriptMedId').value = '';
    document.getElementById('scriptRepeats').value = '';
    document.getElementById('scriptExpiry').value = '';
    document.getElementById('scriptBarcode').value = '';
  } else {
    const err = await response.json().catch(() => ({}));
    alert('Error: ' + (err.error || 'unknown'));
  }
}

// --- Daily use with "more than you have" guard ---

async function logUsage(medId, qty) {
  // Get current med to know quantity
  const medRes = await fetch(`/api/medications/${medId}`);
  if (!medRes.ok) {
    alert('Error: could not load medication');
    return;
  }
  const med = await medRes.json();
  const current = med.current_qty ?? 0;

  if (qty > current) {
    alert("That's more than you have.");
    return;
  }
  if (qty <= 0) {
    alert('Usage amount must be positive');
    return;
  }

  const response = await fetch(`/api/medications/${medId}/use`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ qty_used: qty })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    alert('Error: ' + (err.error || 'unknown'));
  }
  loadUsageList();
  loadAlertList();
}

// --- Adjust: delta-based, no negative, with "Updating…" popup ---

async function loadAdjustList() {
  const response = await fetch('/api/medications');
  if (!response.ok) {
    alert('Error loading medications');
    return;
  }
  const meds = await response.json();
  const list = document.getElementById('adjustList');
  list.innerHTML = '';

  for (const med of meds) {
    const qty = med.current_qty ?? 0;
    const dose = med.daily_dose || 1;
    const time = med.time_of_day || '08:00';

    const dosesRes = await fetch(`/api/medications/${med.id}/doses`);
    const doses = dosesRes.ok ? await dosesRes.json() : [];

    let dosesHtml = '';
    doses.forEach(d => {
      dosesHtml += `
        <div class="dose-row" data-dose-id="${d.id}">
          <input type="time" value="${d.time_of_day}" disabled style="width:110px;">
          <input type="number" value="${d.amount}" disabled style="width:60px;">
          <span>${d.label || ''}</span>
          <button type="button" class="btn-danger" onclick="removeDose(${d.id})">X</button>
        </div>
      `;
    });

    dosesHtml += `
      <div class="dose-row">
        <input type="time" id="new-dose-time-${med.id}" value="08:00" style="width:110px;">
        <input type="number" id="new-dose-amt-${med.id}" value="1" style="width:60px;">
        <input type="text" id="new-dose-label-${med.id}" placeholder="label (optional)" style="width:140px;">
        <button type="button" class="btn-success" onclick="addDose(${med.id})">Add time</button>
      </div>
    `;

    list.innerHTML += `
      <div class="med-item">
        <div class="med-main">
          <strong>${med.name}</strong><br>
          Qty:
          <input type="number" id="qty-${med.id}" value="${qty}" style="width:80px;">
          Change (±):
          <input type="number" id="delta-${med.id}" value="0" style="width:80px;">
          Daily total:
          <input type="number" id="dose-${med.id}" value="${dose}" style="width:60px;">
          Default time:
          <input type="time" id="time-${med.id}" value="${time}" style="width:110px;">
          <div style="margin-top:8px;">
            <strong>Dose times:</strong><br>
            ${dosesHtml}
          </div>
        </div>
        <div class="med-actions">
          <button onclick="saveAdjust(${med.id})" class="btn-success">Adjust</button>
          <button onclick="deleteMed(${med.id})" class="btn-danger">Delete</button>
        </div>
      </div>
    `;
  }
}

async function saveAdjust(medId) {
  alert('Updating…');

  const qtyField   = document.getElementById(`qty-${medId}`);
  const deltaField = document.getElementById(`delta-${medId}`);
  const doseField  = document.getElementById(`dose-${medId}`);
  const timeField  = document.getElementById(`time-${medId}`);

  const baseQty = parseInt(qtyField.value, 10);
  const delta   = parseInt(deltaField?.value || '0', 10);
  const dose    = parseInt(doseField.value, 10);
  const time    = timeField.value;

  const body = {};

  // Prefer delta if non-zero, else absolute
  if (!Number.isNaN(delta) && delta !== 0) {
    body.adjust_by = delta;
  } else if (!Number.isNaN(baseQty)) {
    if (baseQty < 0) {
      alert("Quantity can't be negative");
      return;
    }
    body.current_qty = baseQty;
  }

  if (!Number.isNaN(dose) && dose > 0) body.daily_dose = dose;
  if (time) body.time_of_day = time;

  const response = await fetch(`/api/medications/${medId}/adjust`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    alert('Error: ' + (err.error || 'unknown'));
  } else {
    alert('Updated');
    if (deltaField) deltaField.value = '0';
    loadAdjustList();
    loadAlertList();
  }
}

// --- Alerts / Inventory ---

async function checkAlerts() {
  await fetch('/api/check-alerts', { method: 'POST' });
  alert('Alerts sent to ntfy (if any)');
}

async function loadMedDropdown() {
  const response = await fetch('/api/medications');
  if (!response.ok) return;
  const meds = await response.json();
  const select = document.getElementById('scriptMedId');
  select.innerHTML = '<option value="">Select medication...</option>';
  meds.forEach(med => {
    select.innerHTML += `<option value="${med.id}">${med.name}</option>`;
  });
}

async function loadUsageList() {
  const response = await fetch('/api/medications');
  if (!response.ok) {
    alert('Error loading medications');
    return;
  }
  const meds = await response.json();
  const list = document.getElementById('usageList');
  list.innerHTML = '';
  meds.forEach(med => {
    const dose = med.daily_dose || 1;
    const qty = med.current_qty ?? 0;
    list.innerHTML += `
      <div class="med-item">
        <span>${med.name} - ${qty} left</span>
        <button onclick="logUsage(${med.id}, ${dose})" class="btn-success">
          Take ${dose}
        </button>
      </div>
    `;
  });
}

async function loadAlertList() {
  const response = await fetch('/api/medications');
  if (!response.ok) {
    alert('Error loading alerts');
    return;
  }
  const meds = await response.json();
  const list = document.getElementById('alertList');
  list.innerHTML = '';
  meds.forEach(med => {
    const qty = med.current_qty ?? 0;
    const alertTh = med.alert_threshold ?? 0;
    const repeats = med.repeats_left ?? 0;
    let className = '';
    if (qty <= 0) className = 'out-stock';
    else if (qty <= alertTh) className = 'low-stock';

    list.innerHTML += `
      <div class="med-item ${className}">
        <div>
          <strong>${med.name}</strong><br>
          Qty: ${qty} | Alert: ${alertTh} | Repeats: ${repeats}
          ${med.expiry_date ? `| Expires: ${med.expiry_date}` : ''}
        </div>
      </div>
    `;
  });
}

// --- Doses ---

async function addDose(medId) {
  const t = document.getElementById(`new-dose-time-${medId}`).value;
  const amt = parseInt(document.getElementById(`new-dose-amt-${medId}`).value || '1', 10);
  const label = document.getElementById(`new-dose-label-${medId}`).value;

  if (!t || isNaN(amt) || amt <= 0) {
    alert('Time and positive amount are required');
    return;
  }

  const res = await fetch(`/api/medications/${medId}/doses`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ time_of_day: t, amount: amt, label })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Error adding dose: ' + (err.error || 'unknown'));
    return;
  }
  loadAdjustList();
}

async function removeDose(doseId) {
  const res = await fetch(`/api/doses/${doseId}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Error deleting dose: ' + (err.error || 'unknown'));
    return;
  }
  loadAdjustList();
}

// --- Delete medication ---

async function deleteMed(medId) {
  if (!confirm('Delete this medication and all related data?')) return;

  const res = await fetch(`/api/medications/${medId}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('Error deleting: ' + (err.error || 'unknown'));
    return;
  }
  loadAdjustList();
  loadUsageList();
  loadAlertList();
}

// --- Save & Exit (UI state only) ---

function saveAndExit() {
  const activeSection = document.querySelector('.section.active');
  const sectionId = activeSection ? activeSection.id : 'addMed';

  const state = {
    section: sectionId,
    medForm: {
      name: document.getElementById('medName')?.value || '',
      barcode: document.getElementById('medBarcode')?.value || ''
    }
  };
  try {
    localStorage.setItem('medAppState', JSON.stringify(state));
  } catch (e) {
    // ignore storage errors
  }
  alert('Saved. You can close this page.');
}

// Restore last UI state
window.addEventListener('DOMContentLoaded', () => {
  try {
    const saved = localStorage.getItem('medAppState');
    if (saved) {
      const state = JSON.parse(saved);
      showSection(state.section || 'addMed');
      if (state.medForm) {
        if (document.getElementById('medName')) {
          document.getElementById('medName').value = state.medForm.name || '';
        }
        if (document.getElementById('medBarcode')) {
          document.getElementById('medBarcode').value = state.medForm.barcode || '';
        }
      }
      return;
    }
  } catch (e) {
    // ignore
  }
  showSection('addMed');
});

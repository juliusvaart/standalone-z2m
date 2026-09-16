const $ = (id) => document.getElementById(id);

let snapshot = {
  devices: [],
  groups: [],
  recent: [],
  commands: [],
  occupancyActions: [],
  haConfigured: false,
};
let haLights = [];
let rules = [];

const api = (path, init) =>
  fetch(`api/${path}`, init).then(async (res) => {
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.errors?.join(', ') || body.error || `request failed (${res.status})`);
    return body;
  });

function selectedKind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function renderStatus() {
  const mqtt = $('mqtt-status');
  mqtt.textContent = snapshot.mqttConnected ? 'MQTT connected' : 'MQTT offline';
  mqtt.className = `pill ${snapshot.mqttConnected ? 'ok' : 'bad'}`;

  const ha = $('ha-status');
  if (!snapshot.haConfigured) {
    ha.textContent = 'Home Assistant not configured';
    ha.className = 'pill';
  } else if (snapshot.haReachable) {
    ha.textContent = 'Home Assistant linked';
    ha.className = 'pill ok';
  } else {
    ha.textContent = 'Home Assistant unreachable · fallbacks active';
    ha.className = 'pill bad';
  }
}

function renderCommands() {
  const select = $('command');
  if (select.options.length === snapshot.commands.length) return;
  select.innerHTML = snapshot.commands
    .map((c) => `<option value="${c.id}">${c.label}</option>`)
    .join('');
}

function renderDeviceList() {
  $('device-list').innerHTML = snapshot.devices
    .map((d) => `<option value="${d.friendly_name}">${d.description}</option>`)
    .join('');
}

function actionLabel(action) {
  return snapshot.occupancyActions.find((a) => a.id === action)?.label || '';
}

function renderActionList() {
  const device = $('device').value.trim();
  const seen = snapshot.recent.filter((e) => !device || e.device === device).map((e) => e.action);
  // A sensor never presses a button, so its actions have to be offered up front.
  const sensors = snapshot.devices.filter((d) => d.exposes_occupancy);
  const offerOccupancy = device
    ? sensors.some((d) => d.friendly_name === device)
    : sensors.length > 0;
  const actions = [
    ...new Set([...(offerOccupancy ? snapshot.occupancyActions.map((a) => a.id) : []), ...seen]),
  ];
  $('action-list').innerHTML = actions
    .map((a) => `<option value="${a}">${actionLabel(a)}</option>`)
    .join('');
}

function z2mOptions() {
  return [
    ...snapshot.groups.map((g) => ({
      value: g.friendly_name,
      label: `${g.friendly_name} · group of ${g.members}`,
    })),
    ...snapshot.devices
      .filter((d) => d.is_light)
      .map((d) => ({
        value: d.friendly_name,
        label: d.description ? `${d.friendly_name} · ${d.description}` : d.friendly_name,
      })),
  ];
}

function renderTargetList() {
  const hint = $('kind-hint');
  const stepHint = $('step-hint');
  const options = z2mOptions();
  $('z2m-list').innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  $('fallback-field').hidden = selectedKind() !== 'ha';

  if (selectedKind() === 'ha') {
    $('target-list').innerHTML = haLights
      .map((l) => `<option value="${l.entity_id}">${l.name}</option>`)
      .join('');
    $('target').placeholder = 'light.living_room';
    hint.textContent = snapshot.haConfigured
      ? 'Commands run through Home Assistant, so Adaptive Lighting stays in charge of brightness and colour temperature.'
      : 'Set HA_URL and HA_TOKEN in .env to use Home Assistant targets.';
    stepHint.textContent = '(percent, default 12)';
  } else {
    $('target-list').innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    $('target').placeholder = 'living_room_group';
    hint.textContent = 'Commands go straight to Zigbee2MQTT. Works without Home Assistant, but Adaptive Lighting may treat the change as manual control.';
    stepHint.textContent = '(0-254, default 40)';
  }
}

function renderRecent() {
  const list = $('recent');
  if (!snapshot.recent.length) {
    list.innerHTML = '<li class="empty">Waiting for switch events…</li>';
    return;
  }
  list.innerHTML = snapshot.recent
    .map(
      (e, i) => `<li data-index="${i}">
        <span><code>${e.device}</code> → <strong>${e.action}</strong>${
          actionLabel(e.action) ? ` <span class="hint">${actionLabel(e.action)}</span>` : ''
        }</span>
        <time>${new Date(e.at).toLocaleTimeString()}</time>
      </li>`,
    )
    .join('');
}

function delayLabel(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function targetLabel(rule) {
  if (rule.target.kind !== 'ha') return `Z2M · ${rule.target.id}`;
  const fallback = rule.fallback
    ? `<br><span class="hint">fallback → ${rule.fallback}</span>`
    : '<br><span class="hint warn">no fallback</span>';
  return `HA · ${rule.target.id}${fallback}`;
}

function renderRules() {
  const body = document.querySelector('#rules tbody');
  $('rules-empty').hidden = rules.length > 0;
  body.innerHTML = rules
    .map(
      (r) => `<tr class="${r.enabled === false ? 'disabled' : ''}">
        <td>${r.name}</td>
        <td><code>${r.device}</code></td>
        <td><code>${r.action}</code></td>
        <td>${snapshot.commands.find((c) => c.id === r.command)?.label || r.command}${
          r.delay ? `<br><span class="hint">after ${delayLabel(r.delay)} of no activity</span>` : ''
        }</td>
        <td>${targetLabel(r)}</td>
        <td class="controls">
          <button class="small" data-test="${r.id}">Test</button>
          <button class="small" data-edit="${r.id}">Edit</button>
          <button class="small" data-duplicate="${r.id}">Duplicate</button>
          <button class="small" data-delete="${r.id}">Delete</button>
        </td>
      </tr>`,
    )
    .join('');
}

function resetForm() {
  $('rule-id').value = '';
  $('rule-form').reset();
  $('form-title').textContent = 'New binding';
  $('cancel').hidden = true;
  $('form-error').hidden = true;
  renderTargetList();
}

function fillForm(rule, { id, name, title }) {
  $('rule-id').value = id;
  $('name').value = name;
  $('device').value = rule.device;
  $('action').value = rule.action;
  $('command').value = rule.command;
  document.querySelector(`input[name="kind"][value="${rule.target.kind}"]`).checked = true;
  renderTargetList();
  $('target').value = rule.target.id;
  $('fallback').value = rule.fallback || '';
  $('step').value = rule.step ?? '';
  $('delay').value = rule.delay ?? '';
  $('enabled').checked = rule.enabled !== false;
  $('form-title').textContent = title;
  $('cancel').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function editRule(rule) {
  fillForm(rule, { id: rule.id, name: rule.name, title: 'Edit binding' });
}

function duplicateRule(rule) {
  fillForm(rule, { id: '', name: `${rule.name} copy`, title: 'Duplicate binding' });
}

async function loadHaLights() {
  if (!snapshot.haConfigured) return;
  try {
    haLights = await api('ha/lights');
  } catch (err) {
    console.warn(`Home Assistant lights unavailable: ${err.message}`);
    haLights = [];
  }
}

async function refreshState() {
  snapshot = await api('state');
  renderStatus();
  renderCommands();
  renderDeviceList();
  renderActionList();
  renderRecent();
  renderTargetList();
}

async function refreshRules() {
  rules = await api('rules');
  renderRules();
}

$('rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    name: $('name').value,
    device: $('device').value,
    action: $('action').value,
    command: $('command').value,
    target: { kind: selectedKind(), id: $('target').value },
    fallback: $('fallback').value,
    step: $('step').value,
    delay: $('delay').value,
    enabled: $('enabled').checked,
  };
  const id = $('rule-id').value;
  try {
    await api(id ? `rules/${id}` : 'rules', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    resetForm();
    await refreshRules();
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').hidden = false;
  }
});

$('cancel').addEventListener('click', resetForm);
$('device').addEventListener('input', renderActionList);
for (const radio of document.querySelectorAll('input[name="kind"]')) {
  radio.addEventListener('change', () => {
    $('target').value = '';
    $('fallback').value = '';
    renderTargetList();
  });
}

$('recent').addEventListener('click', (event) => {
  const li = event.target.closest('li[data-index]');
  if (!li) return;
  const entry = snapshot.recent[Number(li.dataset.index)];
  $('device').value = entry.device;
  $('action').value = entry.action;
  renderActionList();
});

document.querySelector('#rules tbody').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { test, edit, duplicate, delete: remove } = button.dataset;
  try {
    if (edit) editRule(rules.find((r) => r.id === edit));
    if (duplicate) duplicateRule(rules.find((r) => r.id === duplicate));
    if (test) {
      await api(`rules/${test}/test`, { method: 'POST' });
      button.textContent = 'Sent';
      setTimeout(() => (button.textContent = 'Test'), 1500);
    }
    if (remove && confirm('Delete this binding?')) {
      await api(`rules/${remove}`, { method: 'DELETE' });
      await refreshRules();
    }
  } catch (err) {
    alert(err.message);
  }
});

(async function init() {
  await refreshState();
  await loadHaLights();
  renderTargetList();
  await refreshRules();
  setInterval(() => refreshState().catch((err) => console.warn(err.message)), 3000);
})();

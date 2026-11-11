const $ = (id) => document.getElementById(id);

// Every name below comes from a user or a device and ends up in innerHTML.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Matches the breakpoint in style.css below which only one panel shows at a time.
const phone = window.matchMedia('(max-width: 719px)');

let snapshot = { devices: [], groups: [], recent: [], commands: [], haConfigured: false };
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

// Long text on desktop, short text on a phone; the long one stays reachable as a tooltip.
function setPill(el, state, full, short) {
  el.className = `pill ${state}`;
  el.title = full;
  el.innerHTML = `<span class="full">${esc(full)}</span><span class="short">${esc(short)}</span>`;
}

function renderStatus() {
  const mqtt = snapshot.mqttConnected;
  setPill($('mqtt-status'), mqtt ? 'ok' : 'bad', mqtt ? 'MQTT connected' : 'MQTT offline', 'MQTT');

  const ha = $('ha-status');
  if (!snapshot.haConfigured) setPill(ha, '', 'Home Assistant not configured', 'No HA');
  else if (snapshot.haReachable) setPill(ha, 'ok', 'Home Assistant linked', 'HA');
  else setPill(ha, 'bad', 'Home Assistant unreachable · fallbacks active', 'HA down');
}

function renderCommands() {
  const select = $('command');
  if (select.options.length === snapshot.commands.length) return;
  select.innerHTML = snapshot.commands
    .map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`)
    .join('');
}

function renderDeviceList() {
  $('device-list').innerHTML = snapshot.devices
    .map((d) => `<option value="${esc(d.friendly_name)}">${esc(d.description)}</option>`)
    .join('');
}

function actionLabel(action) {
  for (const device of snapshot.devices) {
    const match = device.actions?.find((a) => a.id === action);
    if (match) return match.label;
  }
  return '';
}

function renderActionList() {
  const device = $('device').value.trim();
  const seen = snapshot.recent.filter((e) => !device || e.device === device).map((e) => e.action);
  // Sensors report a state instead of a press, so their actions are offered up front
  // rather than learnt from recent activity.
  const offered = snapshot.devices
    .filter((d) => !device || d.friendly_name === device)
    .flatMap((d) => d.actions || [])
    .map((a) => a.id);
  const actions = [...new Set([...offered, ...seen])];
  $('action-list').innerHTML = actions
    .map((a) => `<option value="${esc(a)}">${esc(actionLabel(a))}</option>`)
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

const optionList = (options) =>
  options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');

function renderTargetList() {
  const hint = $('kind-hint');
  const stepHint = $('step-hint');
  const options = z2mOptions();
  $('z2m-list').innerHTML = optionList(options);
  $('fallback-field').hidden = selectedKind() !== 'ha';

  if (selectedKind() === 'ha') {
    $('target-list').innerHTML = optionList(haLights.map((l) => ({ value: l.entity_id, label: l.name })));
    $('target').placeholder = 'light.living_room';
    hint.textContent = snapshot.haConfigured
      ? 'Commands run through Home Assistant, so Adaptive Lighting stays in charge of brightness and colour temperature.'
      : 'Set HA_URL and HA_TOKEN in .env to use Home Assistant targets.';
    stepHint.textContent = '(percent, default 12)';
  } else {
    $('target-list').innerHTML = optionList(options);
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
        <span><code>${esc(e.device)}</code> → <strong>${esc(e.action)}</strong>${
          actionLabel(e.action) ? ` <span class="hint">${esc(actionLabel(e.action))}</span>` : ''
        }</span>
        <time>${new Date(e.at).toLocaleTimeString()}</time>
      </li>`,
    )
    .join('');
}

// Activity the phone user has not looked at yet. Timestamps are ISO strings, so
// they compare as text. The page starts with nothing unseen.
let recentSeenAt;

function renderRecentBadge() {
  const latest = snapshot.recent[0]?.at || '';
  if (recentSeenAt === undefined || $('main').dataset.view === 'recent') recentSeenAt = latest;
  const unseen = snapshot.recent.filter((e) => e.at > recentSeenAt).length;
  const badge = $('recent-badge');
  badge.hidden = unseen === 0;
  badge.textContent = unseen;
}

function delayLabel(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function targetLabel(rule) {
  if (rule.target.kind !== 'ha') return `Z2M · ${esc(rule.target.id)}`;
  const fallback = rule.fallback
    ? `<br><span class="hint">fallback → ${esc(rule.fallback)}</span>`
    : '<br><span class="hint warn">no fallback</span>';
  return `HA · ${esc(rule.target.id)}${fallback}`;
}

// One block per switch or sensor, because a binding is only readable next to the
// other bindings of the same device.
function groupByDevice(list) {
  const groups = new Map();
  for (const rule of list) {
    if (!groups.has(rule.device)) groups.set(rule.device, []);
    groups.get(rule.device).push(rule);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([device, deviceRules]) => [
      device,
      [...deviceRules].sort((a, b) => a.action.localeCompare(b.action) || a.name.localeCompare(b.name)),
    ]);
}

function deviceHeader(device, count) {
  const known = snapshot.devices.find((d) => d.friendly_name === device);
  const detail = [known?.description, `${count} ${count === 1 ? 'binding' : 'bindings'}`]
    .filter(Boolean)
    .join(' · ');
  // A device that was removed from the network still has its bindings here.
  const missing = known ? '' : ' <span class="hint warn">not paired</span>';
  return `<tr class="group">
    <td colspan="5"><code>${esc(device)}</code>${missing} <span class="hint">${esc(detail)}</span></td>
  </tr>`;
}

// Cell contents sit in a div so the phone layout can put the data-label beside them
// as a two-column grid without every <br> and <span> becoming a grid item.
function ruleRow(r) {
  const id = esc(r.id);
  const command = snapshot.commands.find((c) => c.id === r.command)?.label || r.command;
  return `<tr class="${r.enabled === false ? 'disabled' : ''}">
    <td class="name">${esc(r.name)}</td>
    <td data-label="Action"><div><code>${esc(r.action)}</code>${
      actionLabel(r.action) ? `<br><span class="hint">${esc(actionLabel(r.action))}</span>` : ''
    }</div></td>
    <td data-label="Command"><div>${esc(command)}${
      r.delay ? `<br><span class="hint">after ${delayLabel(r.delay)} of no activity</span>` : ''
    }</div></td>
    <td data-label="Target"><div>${targetLabel(r)}</div></td>
    <td class="controls">
      <button class="small" data-test="${id}">Test</button>
      <button class="small" data-edit="${id}">Edit</button>
      <button class="small" data-duplicate="${id}">Duplicate</button>
      <button class="small" data-delete="${id}">Delete</button>
    </td>
  </tr>`;
}

function renderRules() {
  const body = document.querySelector('#rules tbody');
  $('rules-empty').hidden = rules.length > 0;
  body.innerHTML = groupByDevice(rules)
    .map(([device, deviceRules]) => deviceHeader(device, deviceRules.length) + deviceRules.map(ruleRow).join(''))
    .join('');
}

// Only matters on a phone; from the breakpoint up every panel is visible regardless.
function showView(view) {
  const main = $('main');
  if (main.dataset.view === view) return;
  main.dataset.view = view;
  for (const tab of document.querySelectorAll('.tabs button')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view === 'recent') renderRecentBadge();
  if (phone.matches) window.scrollTo(0, 0);
}

function resetForm() {
  $('rule-id').value = '';
  $('rule-form').reset();
  $('form-title').textContent = 'New binding';
  $('tab-form').textContent = 'New';
  $('cancel').hidden = true;
  $('form-error').hidden = true;
  renderTargetList();
}

function fillForm(rule, { id, name, title }) {
  showView('form');
  $('tab-form').textContent = id ? 'Edit' : 'New';
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
  renderRecentBadge();
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
    showView('rules');
  } catch (err) {
    $('form-error').textContent = err.message;
    $('form-error').hidden = false;
  }
});

$('cancel').addEventListener('click', () => {
  resetForm();
  showView('rules');
});
document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('button[data-view]');
  if (tab) showView(tab.dataset.view);
});
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
  showView('form');
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

/* Theme. The <head> script already applied the stored preference before the first
   paint; this only owns the button that cycles it. Auto stores nothing, so the
   stylesheet's prefers-color-scheme rule keeps following the OS, live. */
const THEMES = ['auto', 'light', 'dark'];
const THEME_NAMES = { auto: 'Auto', light: 'Light', dark: 'Dark' };

function storedTheme() {
  try {
    const pref = localStorage.getItem('theme');
    return THEMES.includes(pref) ? pref : 'auto';
  } catch (err) {
    return 'auto';
  }
}

function applyTheme(pref) {
  if (pref === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  try {
    if (pref === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', pref);
  } catch (err) {}
  setPill($('theme'), '', `Theme: ${THEME_NAMES[pref]}`, THEME_NAMES[pref]);
}

$('theme').addEventListener('click', () => {
  applyTheme(THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length]);
});

applyTheme(storedTheme());

(async function init() {
  await refreshState();
  await loadHaLights();
  renderTargetList();
  await refreshRules();
  setInterval(() => refreshState().catch((err) => console.warn(err.message)), 3000);
})();

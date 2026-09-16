import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import mqtt from 'mqtt';
import { listRules, replaceRules } from './store.js';
import { COMMANDS, DIM_COMMANDS, createExecutor } from './executor.js';
import * as ha from './ha.js';

const here = dirname(fileURLToPath(import.meta.url));
const baseTopic = process.env.Z2M_BASE_TOPIC || 'zigbee2mqtt';
const port = Number(process.env.PORT || 3000);
const RECENT_LIMIT = 30;
const MAX_DELAY_SECONDS = 86_400;
const OCCUPANCY_ACTION = 'occupancy';
const NO_OCCUPANCY_ACTION = 'no_occupancy';
// Offered in the UI for devices that report occupancy, because a sensor has no
// button press to learn the action name from.
const OCCUPANCY_ACTIONS = [
  { id: OCCUPANCY_ACTION, label: 'Motion detected' },
  { id: NO_OCCUPANCY_ACTION, label: 'Motion cleared' },
];

// Exposes are flat for simple devices and nested under `features` for composite ones.
function exposesProperty(definition, property) {
  const walk = (list) =>
    (list || []).some(
      (e) => e.property === property || e.name === property || walk(e.features),
    );
  return walk(definition?.exposes);
}

const state = {
  devices: [],
  groups: [],
  recent: [],
  mqttConnected: false,
};

// Motion sensors repeat their whole state on every report, so a rule may only run
// when occupancy actually flips. Last seen value per device.
const occupancy = new Map();

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://mosquitto:1883', {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  clientId: `switchboard-${Math.random().toString(16).slice(2, 10)}`,
  reconnectPeriod: 5000,
});

const executor = createExecutor({
  publishSet: (name, payload) =>
    new Promise((resolve, reject) => {
      client.publish(`${baseTopic}/${name}/set`, JSON.stringify(payload), (err) =>
        err ? reject(err) : resolve(),
      );
    }),
});

client.on('connect', () => {
  state.mqttConnected = true;
  console.log(`[mqtt] connected, base topic ${baseTopic}`);
  client.subscribe(`${baseTopic}/#`, (err) => {
    if (err) console.error(`[mqtt] subscribe failed: ${err.message}`);
  });
});

client.on('close', () => {
  state.mqttConnected = false;
  executor.stopAll();
});

client.on('error', (err) => console.error(`[mqtt] ${err.message}`));

// Buttons report an `action` string; motion sensors report a boolean `occupancy`.
// Both become one action name, so a rule stays device + action + command.
function triggerFor(device, payload) {
  if (typeof payload.action === 'string' && payload.action !== '') return payload.action;

  if (typeof payload.occupancy === 'boolean') {
    if (occupancy.get(device) === payload.occupancy) return undefined;
    occupancy.set(device, payload.occupancy);
    return payload.occupancy ? OCCUPANCY_ACTION : NO_OCCUPANCY_ACTION;
  }

  return undefined;
}

function recordAction(device, action) {
  state.recent = [
    { device, action, at: new Date().toISOString() },
    ...state.recent.filter((e) => !(e.device === device && e.action === action)),
  ].slice(0, RECENT_LIMIT);
}

client.on('message', (topic, buffer) => {
  if (!topic.startsWith(`${baseTopic}/`)) return;
  const sub = topic.slice(baseTopic.length + 1);

  let payload;
  try {
    payload = JSON.parse(buffer.toString());
  } catch {
    return;
  }

  if (sub === 'bridge/devices') {
    state.devices = payload
      .filter((d) => d.type !== 'Coordinator' && d.friendly_name)
      .map((d) => ({
        friendly_name: d.friendly_name,
        description: d.definition?.description || d.definition?.model || d.type || '',
        exposes_action: exposesProperty(d.definition, 'action'),
        exposes_occupancy: exposesProperty(d.definition, 'occupancy'),
        is_light: Boolean(d.definition?.exposes?.some((e) => e.type === 'light')),
      }))
      .sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));
    return;
  }

  if (sub === 'bridge/groups') {
    state.groups = payload
      .map((g) => ({ friendly_name: g.friendly_name, members: g.members?.length || 0 }))
      .sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));
    return;
  }

  if (sub.startsWith('bridge/') || /\/(set|get|availability)$/.test(sub)) return;

  const action = triggerFor(sub, payload);
  if (!action) return;

  recordAction(sub, action);

  // Fresh activity on this device voids any delayed run it was still waiting on,
  // so motion returning keeps the light on instead of letting the off through.
  executor.cancelPending(sub);

  for (const rule of listRules()) {
    if (rule.enabled === false) continue;
    if (rule.device !== sub || rule.action !== action) continue;
    executor
      .schedule(rule)
      .catch((err) => console.error(`[rule ${rule.id}] ${err.message}`));
  }
});

const commandIds = new Set(COMMANDS.map((c) => c.id));

async function validate(body) {
  const errors = [];
  const device = String(body.device || '').trim();
  const action = String(body.action || '').trim();
  const command = String(body.command || '').trim();
  const kind = String(body.target?.kind || '').trim();
  const targetId = String(body.target?.id || '').trim();

  if (!device) errors.push('device is required');
  if (!action) errors.push('action is required');
  if (!commandIds.has(command)) errors.push(`command must be one of ${[...commandIds].join(', ')}`);
  if (kind !== 'z2m' && kind !== 'ha') errors.push('target.kind must be "z2m" or "ha"');
  if (!targetId) errors.push('target.id is required');
  if (kind === 'ha' && !ha.isConfigured()) errors.push('Home Assistant targets need HA_URL and HA_TOKEN');
  if (kind === 'ha' && targetId && !/^(light|switch|group)\./.test(targetId)) {
    errors.push('target.id must be a Home Assistant entity id, e.g. light.kitchen');
  }
  // Brightness steps exist only in the light domain; switches and groups cannot dim.
  if (kind === 'ha' && DIM_COMMANDS.has(command) && targetId && !targetId.startsWith('light.')) {
    errors.push(`${targetId} is not a light, so it cannot run ${command}`);
  }

  const step = body.step === undefined || body.step === null || body.step === '' ? undefined : Number(body.step);
  if (step !== undefined && (!Number.isFinite(step) || step <= 0)) errors.push('step must be a positive number');

  // Seconds to wait before running, e.g. lights off some time after motion cleared.
  const delay =
    body.delay === undefined || body.delay === null || body.delay === '' ? undefined : Number(body.delay);
  if (delay !== undefined && (!Number.isFinite(delay) || delay <= 0 || delay > MAX_DELAY_SECONDS)) {
    errors.push(`delay must be between 1 and ${MAX_DELAY_SECONDS} seconds`);
  }

  // Zigbee2MQTT name used when Home Assistant cannot be reached.
  const fallback = kind === 'ha' ? String(body.fallback || '').trim() || undefined : undefined;
  if (fallback && /^[a-z_]+\./.test(fallback)) {
    errors.push('fallback must be a Zigbee2MQTT group or light name, not an entity id');
  }
  // Only worth a round trip once the shape is right.
  if (!errors.length && kind === 'ha') {
    const exists = await ha.entityExists(targetId);
    if (exists === false) errors.push(`${targetId} does not exist in Home Assistant`);
  }

  if (errors.length) return { errors };

  return {
    rule: {
      name: String(body.name || '').trim() || `${device} · ${action}`,
      device,
      action,
      command,
      target: { kind, id: targetId },
      fallback,
      step,
      delay,
      enabled: body.enabled !== false,
    },
  };
}

const app = express();
app.use(express.json());
app.use(express.static(join(here, '..', 'public')));

app.get('/api/state', (req, res) => {
  res.json({
    mqttConnected: state.mqttConnected,
    haConfigured: ha.isConfigured(),
    haReachable: ha.isConfigured() ? ha.isReachable() : false,
    baseTopic,
    devices: state.devices,
    groups: state.groups,
    recent: state.recent,
    commands: COMMANDS,
    occupancyActions: OCCUPANCY_ACTIONS,
  });
});

app.get('/api/ha/lights', async (req, res) => {
  if (!ha.isConfigured()) return res.json([]);
  try {
    res.json(await ha.listLights());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/rules', (req, res) => res.json(listRules()));

app.post('/api/rules', async (req, res) => {
  const { errors, rule } = await validate(req.body || {});
  if (errors) return res.status(400).json({ errors });
  const created = { id: crypto.randomUUID(), ...rule };
  replaceRules([...listRules(), created]);
  res.status(201).json(created);
});

app.put('/api/rules/:id', async (req, res) => {
  const rules = listRules();
  const index = rules.findIndex((r) => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'rule not found' });
  const { errors, rule } = await validate(req.body || {});
  if (errors) return res.status(400).json({ errors });
  const updated = { id: req.params.id, ...rule };
  const next = [...rules];
  next[index] = updated;
  replaceRules(next);
  res.json(updated);
});

app.delete('/api/rules/:id', (req, res) => {
  const rules = listRules();
  const next = rules.filter((r) => r.id !== req.params.id);
  if (next.length === rules.length) return res.status(404).json({ error: 'rule not found' });
  replaceRules(next);
  res.status(204).end();
});

// Fire a rule from the UI to check the wiring without touching the switch.
app.post('/api/rules/:id/test', async (req, res) => {
  const rule = listRules().find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: 'rule not found' });
  try {
    await executor.run(rule);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, mqttConnected: state.mqttConnected }));

const server = app.listen(port, () => console.log(`[http] listening on ${port}`));

// Keeps the UI status honest and clears the unreachable cooldown as soon as HA returns.
const haProbe = ha.isConfigured() ? setInterval(() => ha.probe(), 30_000) : undefined;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearInterval(haProbe);
    executor.stopAll();
    executor.cancelAll();
    server.close(() => client.end(false, () => process.exit(0)));
  });
}

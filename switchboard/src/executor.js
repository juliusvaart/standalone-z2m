import * as ha from './ha.js';

export const COMMANDS = [
  { id: 'toggle', label: 'Toggle' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
  { id: 'dim_up', label: 'Dim up (one step)' },
  { id: 'dim_down', label: 'Dim down (one step)' },
  { id: 'dim_up_hold', label: 'Dim up while held' },
  { id: 'dim_down_hold', label: 'Dim down while held' },
  { id: 'dim_stop', label: 'Stop dimming (hold release)' },
];

const HOLD_COMMANDS = new Set(['dim_up_hold', 'dim_down_hold']);
const HOLD_INTERVAL_MS = 600;
// A release event can get lost over the air; never dim forever because of it.
const HOLD_MAX_MS = 20_000;

// Zigbee2MQTT brightness is 0-254, Home Assistant steps are percentages.
const DEFAULT_STEP = { z2m: 40, ha: 12 };
const MAX_Z2M_STEP = 254;

function haStep(rule) {
  return Number.isFinite(rule.step) && rule.step > 0 ? rule.step : DEFAULT_STEP.ha;
}

function z2mStep(rule) {
  if (!Number.isFinite(rule.step) || rule.step <= 0) return DEFAULT_STEP.z2m;
  // A Home Assistant rule stores its step as a percentage, so scale it for the fallback.
  if (rule.target.kind === 'ha') {
    return Math.min(MAX_Z2M_STEP, Math.max(1, Math.round((rule.step / 100) * MAX_Z2M_STEP)));
  }
  return Math.min(MAX_Z2M_STEP, rule.step);
}

export function createExecutor({ publishSet }) {
  const holds = new Map();
  // Targets whose hold is currently running over Zigbee2MQTT because Home
  // Assistant was down when the button went down. The release has to stop it there.
  const fallbackHolds = new Map();

  function stopHold(key) {
    const hold = holds.get(key);
    if (!hold) return;
    clearInterval(hold.timer);
    clearTimeout(hold.deadline);
    holds.delete(key);
  }

  function startHold(key, tick) {
    stopHold(key);
    const timer = setInterval(() => {
      Promise.resolve(tick()).catch((err) => console.error(`[executor] hold ${key}: ${err.message}`));
    }, HOLD_INTERVAL_MS);
    const deadline = setTimeout(() => stopHold(key), HOLD_MAX_MS);
    holds.set(key, { timer, deadline });
  }

  function runZigbee2Mqtt(name, command, step) {
    switch (command) {
      case 'on':
        // State only, so a light restores the values Adaptive Lighting last wrote.
        return publishSet(name, { state: 'ON' });
      case 'off':
        return publishSet(name, { state: 'OFF' });
      case 'toggle':
        return publishSet(name, { state: 'TOGGLE' });
      case 'dim_up':
        return publishSet(name, { brightness_step_onoff: step });
      case 'dim_down':
        return publishSet(name, { brightness_step_onoff: -step });
      case 'dim_up_hold':
        return publishSet(name, { brightness_move_onoff: step });
      case 'dim_down_hold':
        return publishSet(name, { brightness_move_onoff: -step });
      case 'dim_stop':
        return publishSet(name, { brightness_move: 0 });
      default:
        return Promise.reject(new Error(`unknown command ${command}`));
    }
  }

  function runHomeAssistant(entityId, command, step) {
    const dim = (pct) => ha.callService('light', 'turn_on', { entity_id: entityId, brightness_step_pct: pct });

    switch (command) {
      case 'on':
        // No brightness or colour here: Adaptive Lighting picks the values for this turn_on.
        return ha.callService('light', 'turn_on', { entity_id: entityId });
      case 'off':
        return ha.callService('light', 'turn_off', { entity_id: entityId });
      case 'toggle':
        return ha.callService('light', 'toggle', { entity_id: entityId });
      case 'dim_up':
        return dim(step);
      case 'dim_down':
        return dim(-step);
      case 'dim_up_hold':
      case 'dim_down_hold': {
        const delta = command === 'dim_up_hold' ? step : -step;
        return dim(delta);
      }
      default:
        return Promise.reject(new Error(`unknown command ${command}`));
    }
  }

  async function run(rule) {
    const { command, target } = rule;

    if (target.kind !== 'ha') return runZigbee2Mqtt(target.id, command, z2mStep(rule));

    const key = `ha:${target.id}`;

    // A release never reaches Home Assistant: it stops the local repeat timer, and
    // the Zigbee2MQTT move as well if the hold had already fallen back.
    if (command === 'dim_stop') {
      stopHold(key);
      const pending = fallbackHolds.get(key);
      if (!pending) return undefined;
      fallbackHolds.delete(key);
      return runZigbee2Mqtt(pending, 'dim_stop', z2mStep(rule));
    }

    if (command === 'off') stopHold(key);

    try {
      const result = await runHomeAssistant(target.id, command, haStep(rule));
      if (HOLD_COMMANDS.has(command)) {
        fallbackHolds.delete(key);
        const delta = command === 'dim_up_hold' ? haStep(rule) : -haStep(rule);
        startHold(key, () =>
          ha.callService('light', 'turn_on', { entity_id: target.id, brightness_step_pct: delta }),
        );
      }
      return result;
    } catch (err) {
      if (!rule.fallback) throw err;
      console.warn(`[executor] ${err.message}; falling back to zigbee2mqtt/${rule.fallback}`);
      stopHold(key);
      if (HOLD_COMMANDS.has(command)) fallbackHolds.set(key, rule.fallback);
      return runZigbee2Mqtt(rule.fallback, command, z2mStep(rule));
    }
  }

  function stopAll() {
    for (const key of [...holds.keys()]) stopHold(key);
    fallbackHolds.clear();
  }

  return { run, stopAll };
}

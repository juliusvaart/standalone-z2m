const baseUrl = (process.env.HA_URL || '').replace(/\/+$/, '');
const token = process.env.HA_TOKEN || '';

const REQUEST_TIMEOUT_MS = 4000;
// After a network failure, stop dialling Home Assistant for a while so a button
// press falls through to the Zigbee2MQTT path immediately instead of waiting.
const UNREACHABLE_COOLDOWN_MS = 30_000;

let unreachableUntil = 0;

export const isConfigured = () => Boolean(baseUrl && token);
export const isReachable = () => Date.now() >= unreachableUntil;

function markUnreachable(reason) {
  if (isReachable()) console.warn(`[ha] unreachable: ${reason}`);
  unreachableUntil = Date.now() + UNREACHABLE_COOLDOWN_MS;
}

function markReachable() {
  if (!isReachable()) console.log('[ha] reachable again');
  unreachableUntil = 0;
}

async function request(path, init = {}, { allowMissing = false } = {}) {
  if (!isConfigured()) throw new Error('Home Assistant is not configured (set HA_URL and HA_TOKEN)');
  if (!isReachable()) throw new Error('Home Assistant is unreachable');

  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    markUnreachable(err.message);
    throw new Error(`Home Assistant is unreachable: ${err.message}`);
  }

  // A 5xx means the instance is there but not serving; treat it like an outage.
  // Auth and request errors are our fault, so they must not trip the cooldown.
  if (res.status >= 500) {
    markUnreachable(`responded ${res.status}`);
    throw new Error(`Home Assistant ${path} responded ${res.status}`);
  }

  markReachable();
  if (allowMissing && res.status === 404) return null;
  if (!res.ok) throw new Error(`Home Assistant ${path} responded ${res.status}`);
  return res.json();
}

// A service call for an entity that does not exist still answers 200, so a typo in a
// target would silently do nothing forever. The state endpoint does 404, so it is the
// only way to catch one before the rule is stored. Returns null when Home Assistant
// cannot be reached, because an outage must not block editing rules.
export async function entityExists(entityId) {
  if (!isConfigured()) return null;
  try {
    return (await request(`/api/states/${encodeURIComponent(entityId)}`, {}, { allowMissing: true })) !== null;
  } catch {
    return null;
  }
}

export function callService(domain, service, data) {
  return request(`/api/services/${domain}/${service}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listLights() {
  const states = await request('/api/states');
  return states
    .filter((s) => s.entity_id.startsWith('light.'))
    .map((s) => ({
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Cheap liveness check; also clears the cooldown as soon as HA comes back.
export async function probe() {
  if (!isConfigured()) return false;
  const previous = unreachableUntil;
  unreachableUntil = 0;
  try {
    await request('/api/');
    return true;
  } catch {
    if (unreachableUntil === 0) unreachableUntil = previous;
    return false;
  }
}

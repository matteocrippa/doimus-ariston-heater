const { AristonClient } = require("./client");

function createLogger(api, prefix) {
  return (level, msg) => api.log(level, `[${prefix}] ${msg}`);
}

// Water-heater operating modes per API variant. Values follow the reverse-
// engineered Ariston NET Velis API:
//   Lydos (sePlantData):  iMemory=1, Green=2, Program=6, Boost=7
//   Evo / Lux (medPlantData): Program=5, Boost=9
//   other variants fall back to Program=5.
const MODES = {
  sePlantData: { imemory: 1, green: 2, program: 6, boost: 7 },
  medPlantData: { program: 5, boost: 9 },
  evoPlantData: { program: 5 },
  slpPlantData: { program: 5 },
  onePlantData: { program: 5 },
};

function modeValues(variant) {
  return MODES[variant] || { program: 5 };
}

let client = null;
let deviceId = null;
let pollTimer = null;
let retryTimer = null;
let refreshTimer = null;
let refreshInFlight = null;
let consecutiveFailures = 0;
let config = {};
let debug = false;
let minTemp = 40;
let maxTemp = 65;
let cached = {
  power: false,
  temperature: null,
  target_temp: null,
  heating_state: null,
  mode: null,
  lastMode: null,
  boost: false,
  imemory: false,
  scheduled: false,
  green: false,
  avShw: null,
  maxAvShw: null,
};
let hasShowers = false;
let apiRef = null;
let log = null;

// Registration bookkeeping — the UI descriptor and capabilities depend on the
// discovered variant, so we re-register once the variant is known and whenever
// the device starts reporting available-showers data.
let registeredVariant = null;
let registeredForShowers = false;

// Adaptive polling state
let plantId = null;
let variant = null;
let slowPollInterval = 1800;
let fastPollInterval = 120;
let cooldownCycles = 3;
let cooldownRemaining = 0;
let currentPollIntervalSec = 0;
let prevHeatingState = null;

function generateUUID(seed) {
  const crypto = require("crypto");
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    "5" + hash.substring(12, 15),
    ((parseInt(hash.substring(15, 17), 16) & 0x3f) | 0x80).toString(16) +
      hash.substring(17, 19),
    hash.substring(19, 31),
  ].join("-");
}

function buildCapabilities() {
  const caps = ["power", "target_temp", "heating_state", "heating_mode", "mode"];
  const m = modeValues(variant);
  if (m.boost !== undefined) caps.push("boost");
  if (m.imemory !== undefined) caps.push("imemory");
  if (m.scheduled !== undefined) caps.push("scheduled");
  if (m.green !== undefined) caps.push("green");
  return caps;
}

// Declarative UI descriptor — instructs the mobile app how to render the
// device-detail controls. The app renders this generically (no Ariston-specific
// UI code), so any plugin can adopt the same mechanism.
function buildDescriptor() {
  const m = modeValues(variant);
  const rows = [
    {
      type: "value",
      key: "temperature",
      label: "Current temperature",
      unit: "celsius",
    },
    { type: "toggle", key: "power", label: "On/Off" },
  ];
  if (hasShowers) {
    rows.push({
      type: "value",
      key: "available_showers",
      label: "Available showers",
      format: "count/max",
      secondary_key: "max_showers",
    });
  }
  rows.push({
    type: "stepper",
    key: "target_temp",
    label: "Target temperature",
    min_key: "min_target_temp",
    max_key: "max_target_temp",
    step: 0.5,
    unit: "celsius",
  });
  if (m.boost !== undefined) rows.push({ type: "toggle", key: "boost", label: "Boost" });
  if (m.imemory !== undefined) rows.push({ type: "toggle", key: "imemory", label: "iMemory" });
  if (m.scheduled !== undefined) rows.push({ type: "toggle", key: "scheduled", label: "Scheduled" });
  if (m.green !== undefined) rows.push({ type: "toggle", key: "green", label: "Green" });
  return { sections: [{ title: "Water heater", rows }] };
}

function currentStateSnapshot() {
  const state = {
    power: !!cached.power,
    heating_state: cached.heating_state ?? 0,
    heating_mode: cached.heating_state ?? 0,
    temperature: cached.temperature ?? 0,
    target_temp: cached.target_temp ?? minTemp,
    min_target_temp: minTemp,
    max_target_temp: maxTemp,
    mode: cached.mode ?? 0,
    boost: !!cached.boost,
    imemory: !!cached.imemory,
    scheduled: !!cached.scheduled,
    green: !!cached.green,
  };
  if (hasShowers) {
    state.available_showers = cached.avShw ?? 0;
    state.max_showers = cached.maxAvShw ?? 0;
  }
  return state;
}

function registerDevice() {
  apiRef.registerDevice({
    id: deviceId,
    name: config.name || "Ariston Heater",
    type: "thermostat",
    capabilities: buildCapabilities(),
    state: currentStateSnapshot(),
    metadata: { ui: buildDescriptor(), icon: "thermostat" },
  });
}

function syncRegistration() {
  const needShowers = hasShowers && !registeredForShowers;
  if (variant !== registeredVariant || needShowers) {
    registeredVariant = variant;
    registeredForShowers = hasShowers;
    registerDevice();
  }
}

module.exports = {
  start(cfg, api) {
    config = cfg;
    apiRef = api;
    log = createLogger(api, "Ariston");

    minTemp = Math.max(1, Number(config.minTemp ?? 40));
    maxTemp = Math.max(minTemp + 1, Number(config.maxTemp ?? 65));
    slowPollInterval = Math.max(300, Number(config.pollInterval) || 1800);
    fastPollInterval = Math.max(30, Number(config.fastPollInterval) || 120);
    if (fastPollInterval >= slowPollInterval) {
      fastPollInterval = Math.max(30, Math.floor(slowPollInterval / 2));
    }
    cooldownCycles = Math.max(
      1,
      Math.min(10, Number(config.cooldownCycles) || 3),
    );
    debug = !!config.debug;

    const seed = "ariston-heater-" + (config.gateway || config.username);
    deviceId = generateUUID(seed);

    client = new AristonClient({
      username: config.username,
      password: config.password,
      log: {
        info: (m) => log("info", m),
        warn: (m) => log("warn", m),
        error: (m) => log("error", m),
        debug: (m) => {
          if (debug) log("debug", m);
        },
      },
      debug,
      cacheDir: process.cwd(),
    });

    api.onCommand((id, key, value) => {
      if (id !== deviceId) return;
      switch (key) {
        case "target_temp":
          setTargetTemp(Number(value));
          break;
        case "power":
          setPower(value === true || value === 1 || value === "1" || value === "true");
          break;
        case "heating_mode":
          setPower(value === 1 || value === true);
          break;
        case "boost":
          setModeToggle("boost", isTruthy(value));
          break;
        case "imemory":
          setModeToggle("imemory", isTruthy(value));
          break;
        case "scheduled":
          setModeToggle("scheduled", isTruthy(value));
          break;
        case "green":
          setModeToggle("green", isTruthy(value));
          break;
        case "mode":
          setMode(Number(value));
          break;
      }
    });

    // Register immediately so the device shows up even if cloud init fails;
    // the variant-aware capabilities + UI descriptor are applied once the
    // variant is discovered (syncRegistration in initialize).
    registerDevice();

    initialize();
  },

  setConfig(cfg) {
    config = cfg;

    // Cancel any pending retry or poll
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stopPollTimer();

    // Reset state
    consecutiveFailures = 0;
    refreshInFlight = null;
    plantId = null;
    variant = null;
    prevHeatingState = null;
    cooldownRemaining = 0;
    hasShowers = false;
    registeredVariant = null;
    registeredForShowers = false;

    // Recompute config-derived values
    minTemp = Math.max(1, Number(config.minTemp ?? 40));
    maxTemp = Math.max(minTemp + 1, Number(config.maxTemp ?? 65));
    slowPollInterval = Math.max(300, Number(config.pollInterval) || 1800);
    fastPollInterval = Math.max(30, Number(config.fastPollInterval) || 120);
    if (fastPollInterval >= slowPollInterval) {
      fastPollInterval = Math.max(30, Math.floor(slowPollInterval / 2));
    }
    cooldownCycles = Math.max(
      1,
      Math.min(10, Number(config.cooldownCycles) || 3),
    );
    debug = !!config.debug;

    // Recreate device ID in case gateway/username changed
    const seed = "ariston-heater-" + (config.gateway || config.username);
    deviceId = generateUUID(seed);

    // Create new client with updated credentials
    client = new AristonClient({
      username: config.username,
      password: config.password,
      log: {
        info: (m) => log("info", m),
        warn: (m) => log("warn", m),
        error: (m) => log("error", m),
        debug: (m) => {
          if (debug) log("debug", m);
        },
      },
      debug,
      cacheDir: process.cwd(),
    });

    registerDevice();

    initialize();
  },

  stop() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    stopPollTimer();
    retryTimer = null;
    client = null;
  },
};

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

// --- Adaptive Poll Timer ---

function stopPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  currentPollIntervalSec = 0;
}

function startPollTimer(intervalSec) {
  if (!plantId || !variant) return;
  if (currentPollIntervalSec === intervalSec && pollTimer) return; // already running at this rate

  stopPollTimer();
  currentPollIntervalSec = intervalSec;
  pollTimer = setInterval(() => refresh(plantId, variant), intervalSec * 1000);
  if (pollTimer.unref) pollTimer.unref();
}

function maybeAdjustPolling() {
  const isHeating = cached.heating_state === 1;

  if (isHeating) {
    // Actively heating: use fast interval, keep cooldown primed
    cooldownRemaining = cooldownCycles;
    if (currentPollIntervalSec !== fastPollInterval) {
      startPollTimer(fastPollInterval);
      log(
        "info",
        "Heating active → fast polling (" + fastPollInterval + "s)",
      );
    }
    return;
  }

  // Not heating
  if (cooldownRemaining > 0) {
    cooldownRemaining--;
    if (currentPollIntervalSec !== fastPollInterval) {
      startPollTimer(fastPollInterval);
    }
    if (cooldownRemaining === 0) {
      startPollTimer(slowPollInterval);
      log(
        "info",
        "Cooldown finished → slow polling (" + slowPollInterval + "s)",
      );
    }
  } else if (currentPollIntervalSec !== slowPollInterval) {
    startPollTimer(slowPollInterval);
  }
}

function forceFastPoll(reason) {
  cooldownRemaining = cooldownCycles;
  if (currentPollIntervalSec !== fastPollInterval) {
    startPollTimer(fastPollInterval);
    log("info", reason + " → fast polling (" + fastPollInterval + "s)");
  }
}

// --- Core Logic ---

async function initialize() {
  try {
    log("info", "Initializing Ariston connection...");
    await client.init();
    await client.login();
    log("info", "Login successful");

    plantId = config.gateway || null;
    if (!plantId) {
      plantId = await client.discoverPlantId();
      if (!plantId) throw new Error("No Ariston device found");
      log("info", "Discovered device: " + plantId);
    }

    variant = await client.discoverVariant(plantId);
    log("info", "Using variant: " + variant);

    // Re-register with the variant-aware capabilities + UI descriptor.
    syncRegistration();

    // Debug aid: dump raw plant settings so field names can be confirmed for
    // the user's device model.
    if (debug) {
      client.getPlantSettings(plantId, variant).then(
        (settings) => log("debug", "Plant settings: " + JSON.stringify(settings)),
        (e) => log("debug", "Plant settings unavailable: " + e.message),
      );
    }

    await refresh(plantId, variant);
    // Start with slow polling; refresh → updateState → maybeAdjustPolling will switch to fast if needed
    startPollTimer(slowPollInterval);
    log(
      "info",
      "Device ready (slow poll " +
        slowPollInterval +
        "s, fast poll " +
        fastPollInterval +
        "s)",
    );
  } catch (e) {
    log("error", "Initialization failed: " + e.message);
    retryTimer = setTimeout(() => initialize(), 60000);
  }
}

async function refresh(plantId, variant) {
  if (!plantId || !variant) return;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const data = await client.getPlantData(plantId, variant);
      if (data) {
        if (debug) log("debug", "Plant data: " + JSON.stringify(data));
        updateState(data);
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        log(
          "warn",
          "Failed to get data (attempt " + consecutiveFailures + ")",
        );
      }
    } catch (e) {
      consecutiveFailures++;
      log("warn", "Refresh error: " + (e.message || e));
      const backoff = Math.min(300, 30 * consecutiveFailures);
      log("info", "Backing off for " + backoff + "s");
      await new Promise((r) => setTimeout(r, backoff * 1000));
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function updateState(data) {
  const updates = {};
  const m = modeValues(variant);

  if (typeof data.currentTemp === "number" && data.currentTemp > 0) {
    cached.temperature = data.currentTemp;
    updates.temperature = data.currentTemp;
  }

  if (typeof data.targetTemp === "number" && data.targetTemp > 0) {
    cached.target_temp = Math.max(minTemp, Math.min(maxTemp, data.targetTemp));
    updates.target_temp = cached.target_temp;
  }

  // Accept boolean, numeric 1/0, or truthy/falsy for power state
  if (data.power !== undefined && data.power !== null) {
    const newHeatingState = data.power ? 1 : 0;
    const newPower = !!data.power;
    if (
      cached.heating_state !== newHeatingState ||
      cached.power !== newPower
    ) {
      cached.power = newPower;
      cached.heating_state = newHeatingState;
      updates.power = newPower;
      updates.heating_state = newHeatingState;
      updates.heating_mode = newHeatingState;
    }
  }

  // Mode drives the iMemory / Green / Scheduled / Boost toggles.
  const mode = data.mode !== undefined && data.mode !== null ? data.mode : cached.mode;
  if (mode !== cached.mode) {
    cached.mode = mode;
    if (cached.mode !== m.boost) cached.lastMode = cached.mode;
    cached.boost = mode === m.boost;
    cached.imemory = mode === m.imemory;
    cached.scheduled = mode === m.scheduled;
    cached.green = mode === m.green;
    updates.mode = mode;
    updates.boost = cached.boost;
    updates.imemory = cached.imemory;
    updates.scheduled = cached.scheduled;
    updates.green = cached.green;
  } else if (data.boost !== undefined && data.boost !== null && !!data.boost !== cached.boost) {
    cached.boost = !!data.boost;
    updates.boost = cached.boost;
  }

  if (data.avShw !== undefined && data.maxAvShw !== undefined) {
    cached.avShw = data.avShw;
    cached.maxAvShw = data.maxAvShw;
    updates.available_showers = data.avShw;
    updates.max_showers = data.maxAvShw;
    hasShowers = true;
  }

  if (Object.keys(updates).length > 0) {
    apiRef.updateDeviceState(deviceId, updates);
  }

  syncRegistration();

  // Adjust polling rate based on heating state transitions
  const justStartedHeating =
    prevHeatingState !== null &&
    prevHeatingState === 0 &&
    cached.heating_state === 1;
  prevHeatingState = cached.heating_state;

  if (justStartedHeating) {
    forceFastPoll("Heating started");
  } else {
    maybeAdjustPolling();
  }
}

async function setTargetTemp(newTemp) {
  if (!client) return;
  newTemp = Math.max(minTemp, Math.min(maxTemp, newTemp));
  const oldTemp = cached.target_temp || minTemp;
  log(
    "info",
    "Setting temperature: " + oldTemp + "C -> " + newTemp + "C",
  );

  cached.target_temp = newTemp;
  apiRef.updateDeviceState(deviceId, { target_temp: newTemp });

  // Optimistically switch to fast polling since the heater may start heating
  forceFastPoll("Command issued");

  try {
    await client.login();
    let pid = config.gateway || null;
    if (!pid) pid = await client.discoverPlantId();
    if (!pid) throw new Error("Cannot resolve plant ID");

    const cachedVariant = client.storage.getVariant(pid);
    const v = cachedVariant ? cachedVariant.variant : null;
    if (!v) throw new Error("Cannot resolve variant");

    const success = await client.setTemperature(pid, v, oldTemp, newTemp);
    if (success) {
      // Refresh after a short delay to confirm the new state
      setTimeout(() => refreshIfReady(pid, v), 5000);
    } else {
      cached.target_temp = oldTemp;
      apiRef.updateDeviceState(deviceId, { target_temp: oldTemp });
      log("error", "Failed to set temperature");
    }
  } catch (e) {
    cached.target_temp = oldTemp;
    apiRef.updateDeviceState(deviceId, { target_temp: oldTemp });
    log("error", "Set temperature failed: " + e.message);
  }
}

async function setPower(on) {
  if (!client) return;
  log("info", "Setting power: " + (on ? "ON" : "OFF"));

  const prev = cached.heating_state;
  cached.heating_state = on ? 1 : 0;
  cached.power = !!on;
  apiRef.updateDeviceState(deviceId, {
    power: cached.power,
    heating_state: cached.heating_state,
    heating_mode: cached.heating_state,
  });

  // If turning ON, switch to fast polling in anticipation
  if (on) {
    forceFastPoll("Power turned ON");
  }

  try {
    await client.login();
    let pid = config.gateway || null;
    if (!pid) pid = await client.discoverPlantId();
    if (!pid) throw new Error("Cannot resolve plant ID");

    const cachedVariant = client.storage.getVariant(pid);
    const v = cachedVariant ? cachedVariant.variant : null;
    if (!v) throw new Error("Cannot resolve variant");

    const success = await client.setPower(pid, v, on);
    if (success) {
      refreshTimer = setTimeout(() => refreshIfReady(pid, v), 5000);
    } else {
      cached.heating_state = prev;
      cached.power = prev === 1;
      apiRef.updateDeviceState(deviceId, {
        power: cached.power,
        heating_state: prev,
        heating_mode: prev,
      });
      log("error", "Failed to set power");
    }
  } catch (e) {
    cached.heating_state = prev;
    cached.power = prev === 1;
    apiRef.updateDeviceState(deviceId, {
      power: cached.power,
      heating_state: prev,
      heating_mode: prev,
    });
    log("error", "Set power failed: " + e.message);
  }
}

// Turns one of the mode toggles on/off. iMemory / Green / Scheduled / Boost are
// mutually exclusive operating modes on the device: turning one on switches the
// mode; turning the active one off falls back to the previous/default mode.
async function setModeToggle(key, on) {
  const m = modeValues(variant);
  const target = m[key];
  if (target === undefined) {
    log("warn", "Variant " + variant + " does not support " + key);
    return;
  }
  if (on) {
    await setMode(target);
    return;
  }
  const fallback =
    cached.lastMode ?? (m.scheduled ?? m.imemory ?? m.green ?? m.boost ?? m.program);
  const newMode = fallback === cached.mode ? (m.scheduled ?? m.imemory ?? m.program) : fallback;
  await setMode(newMode);
}

async function setMode(newMode) {
  if (!client) return;
  log("info", "Setting mode: " + newMode);

  const prevMode = cached.mode;
  const m = modeValues(variant);
  cached.mode = newMode;
  if (cached.mode !== m.boost) cached.lastMode = cached.mode;
  cached.boost = newMode === m.boost;
  cached.imemory = newMode === m.imemory;
  cached.scheduled = newMode === m.scheduled;
  cached.green = newMode === m.green;
  apiRef.updateDeviceState(deviceId, {
    mode: newMode,
    boost: cached.boost,
    imemory: cached.imemory,
    scheduled: cached.scheduled,
    green: cached.green,
  });

  try {
    await client.login();
    let pid = config.gateway || null;
    if (!pid) pid = await client.discoverPlantId();
    if (!pid) throw new Error("Cannot resolve plant ID");

    const cachedVariant = client.storage.getVariant(pid);
    const v = cachedVariant ? cachedVariant.variant : null;
    if (!v) throw new Error("Cannot resolve variant");

    const success = await client.setMode(pid, v, newMode);
    if (success) {
      refreshTimer = setTimeout(() => refreshIfReady(pid, v), 5000);
    } else {
      restoreMode(prevMode);
      log("error", "Failed to set mode");
    }
  } catch (e) {
    restoreMode(prevMode);
    log("error", "Set mode failed: " + e.message);
  }
}

function restoreMode(mode) {
  const m = modeValues(variant);
  cached.mode = mode;
  cached.boost = mode === m.boost;
  cached.imemory = mode === m.imemory;
  cached.scheduled = mode === m.scheduled;
  cached.green = mode === m.green;
  apiRef.updateDeviceState(deviceId, {
    mode: mode,
    boost: cached.boost,
    imemory: cached.imemory,
    scheduled: cached.scheduled,
    green: cached.green,
  });
}

async function refreshIfReady(plantId, variant) {
  if (plantId && variant) await refresh(plantId, variant);
}

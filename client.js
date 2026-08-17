const axios = require("axios");
const { VariantStorage } = require("./storage");

const API_BASE = "https://www.ariston-net.remotethermo.com/api/v2/";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_FALLBACK_TTL_MS = 2 * 60 * 1000;
const VARIANTS = [
  "sePlantData",
  "medPlantData",
  "slpPlantData",
  "onePlantData",
  "evoPlantData",
];

class AristonClient {
  constructor(opts = {}) {
    this.username = opts.username;
    this.password = opts.password;
    this.log = opts.log || { info() {}, warn() {}, error() {}, debug() {} };
    this.debug = !!opts.debug;
    this.token = null;
    this.loginPromise = null;
    this.initPromise = null;
    this.memoryCache = new Map();

    this.storage = new VariantStorage(opts.cacheDir, this.log);

    this.http = axios.create({
      baseURL: opts.baseURL || API_BASE,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        "User-Agent": "okhttp/4.9.3",
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    });

    this.http.interceptors.request.use((config) => {
      if (this.token) {
        if (!config.headers) config.headers = {};
        config.headers["ar.authToken"] = this.token;
      }
      return config;
    });

    this.http.interceptors.response.use(
      (res) => res,
      async (error) => {
        const { config, response } = error;
        if (
          response &&
          response.status === 401 &&
          config &&
          !config._retry &&
          !(config.url && config.url.includes("accounts/login"))
        ) {
          config._retry = true;
          await this.login();
          config.headers = config.headers || {};
          config.headers["ar.authToken"] = this.token;
          return this.http.request(config);
        }
        return Promise.reject(error);
      },
    );
  }

  async init() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.storage.init();
    })();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const res = await this.http.post("accounts/login", {
        usr: this.username,
        pwd: this.password,
        imp: false,
        notTrack: true,
        appInfo: {
          os: 2,
          appVer: "6.0.10.40276",
          appId: "com.remotethermo.aristonnet",
        },
      });
      if (res.status !== 200 || !res.data || !res.data.token) {
        this.token = null;
        this.loginPromise = null;
        const errMsg =
          (res.data && res.data.message) ||
          res.statusText ||
          String(res.status);
        throw new Error("Ariston login failed: " + errMsg);
      }
      this.token = res.data.token;
      if (this.debug) this.log.debug("Ariston login successful");
      this.loginPromise = null;
    })();
    return this.loginPromise;
  }

  async discoverPlantId() {
    await this.login();
    for (const p of ["velis/medPlants", "velis/plants"]) {
      const res = await this.http.get(p);
      if (
        res.status >= 200 &&
        res.status < 300 &&
        Array.isArray(res.data) &&
        res.data.length > 0
      ) {
        const plant = res.data[0];
        return plant.gw || plant.gateway || plant.id || plant.plantId || null;
      }
    }
    return null;
  }

  async discoverVariant(plantId) {
    const cached = this.storage.getVariant(plantId);
    if (cached) {
      if (this.debug) this.log.debug("Using cached variant:", cached.variant);
      return cached.variant;
    }
    await this.login();
    this.log.info("Discovering variant for", plantId);
    for (const variant of VARIANTS) {
      try {
        const url = "velis/" + variant + "/" + encodeURIComponent(plantId);
        const res = await this.http.get(url);
        if (
          res.status >= 200 &&
          res.status < 300 &&
          res.data &&
          typeof res.data === "object"
        ) {
          if (
            res.data.temp !== undefined ||
            res.data.reqTemp !== undefined ||
            res.data.on !== undefined
          ) {
            this.log.info("Found working variant:", variant);
            await this.storage.setVariant(plantId, variant);
            return variant;
          }
        }
        await this._delay(1000);
      } catch (e) {
        if (this.debug)
          this.log.debug("Variant", variant, "failed:", e.message);
        await this._delay(1000);
      }
    }
    throw new Error("Could not find working variant for this device");
  }

  async getPlantData(plantId, variant) {
    await this.login();
    const url = "velis/" + variant + "/" + encodeURIComponent(plantId);
    const res = await this.http.get(url);
    if (res.status >= 200 && res.status < 300) {
      if (!res.data || typeof res.data !== "object") return null;
      const parsed = this._parsePlantData(res.data, variant);
      this.memoryCache.set(plantId + "::" + variant, {
        data: parsed,
        ts: Date.now(),
      });
      return parsed;
    }
    if (res.status === 429 || res.status >= 500) {
      this.log.warn("API transient error; returning cached data if available");
      const entry = this.memoryCache.get(plantId + "::" + variant);
      if (entry && Date.now() - entry.ts <= DEFAULT_FALLBACK_TTL_MS)
        return entry.data;
      return null;
    }
    const entry = this.memoryCache.get(plantId + "::" + variant);
    if (entry && Date.now() - entry.ts <= DEFAULT_FALLBACK_TTL_MS)
      return entry.data;
    return null;
  }

  async setTemperature(plantId, variant, oldTemp, newTemp) {
    await this.login();
    const url =
      "velis/" + variant + "/" + encodeURIComponent(plantId) + "/temperature";
    const res = await this.http.post(url, {
      eco: false,
      old: oldTemp,
      new: newTemp,
    });
    return res.status >= 200 && res.status < 300;
  }

  async setPower(plantId, variant, on) {
    await this.login();
    const url =
      "velis/" + variant + "/" + encodeURIComponent(plantId) + "/switch";
    const res = await this.http.post(url, on);
    return res.status >= 200 && res.status < 300;
  }

  // Reads the device's plant settings (anti-legionella, permanent boost, night
  // mode, max setpoint, ...). Returns null when the endpoint is unavailable.
  async getPlantSettings(plantId, variant) {
    await this.login();
    const url =
      "velis/" + variant + "/" + encodeURIComponent(plantId) + "/plantSettings";
    const res = await this.http.get(url);
    if (
      res.status >= 200 &&
      res.status < 300 &&
      res.data &&
      typeof res.data === "object"
    ) {
      return res.data;
    }
    return null;
  }

  // Sets a single plant setting. oldValue is the value currently reported by
  // the device (the API rejects optimistic writes without it).
  async setPlantSetting(plantId, variant, name, value, oldValue) {
    await this.login();
    const url =
      "velis/" + variant + "/" + encodeURIComponent(plantId) + "/plantSettings";
    const res = await this.http.post(url, {
      [name]: { new: value, old: oldValue },
    });
    return res.status >= 200 && res.status < 300;
  }

  // Sets the water heater operating mode (iMemory / Green / Program / Boost).
  async setMode(plantId, variant, mode) {
    await this.login();
    const url =
      "velis/" + variant + "/" + encodeURIComponent(plantId) + "/mode";
    const res = await this.http.post(url, { new: mode });
    return res.status >= 200 && res.status < 300;
  }

  _parsePlantData(raw, variant) {
    // Normalize power to boolean — the Ariston API may return 1/0 (number),
    // true/false (boolean), or "1"/"0" (string) depending on device variant.
    const rawPower = raw.on ?? raw.power;
    const power =
      rawPower === true ||
      rawPower === 1 ||
      rawPower === "1" ||
      rawPower === "true";

    return {
      currentTemp: raw.temp ?? raw.wtrTemp ?? raw.currentTemp,
      targetTemp: raw.reqTemp ?? raw.procReqTemp ?? raw.targetTemp,
      power,
      antiLeg: raw.antiLeg ?? raw.antiLegionella,
      heatReq: raw.heatReq ?? raw.heatingReq,
      avShw: raw.avShw ?? raw.availableShowers,
      maxAvShw: raw.maxAvShw ?? raw.maxShw ?? raw.maxAvailableShowers,
      mode: raw.mode,
      boost: raw.boost ?? raw.boostOn,
    };
  }

  _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = { AristonClient };

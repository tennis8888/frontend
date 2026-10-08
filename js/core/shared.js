(function (global) {
  "use strict";

  const TAHtml = (global.TAHtml = global.TAHtml || {});

  TAHtml.constants = {
    // Must match the Tesla Android release installed on the box
    // (ro.tesla-android.build.version). The update button compares this
    // against the newest GitHub release, so a stale value nags forever.
    APP_VERSION: "2026.22.1",
    UPDATE_SEEN_KEY: "ta.update.seenVersion",
    DISPLAY_PREF_KEYS: [
      "DisplayRepository_isPrimaryDisplaySharedPreferencesKey",
      "flutter.DisplayRepository_isPrimaryDisplaySharedPreferencesKey",
    ],
    DEFAULT_NON_RESPONSIVE_SIZE: { width: 1088, height: 832 },
    RESIZE_COOLDOWN_MS: 1000,
    TOUCH_SLOT_COUNT: 10,
    DISPLAY_RENDERERS: [
      { value: 0, label: "Motion JPEG" },
      { value: 1, label: "h264 (WebCodecs)" },
      { value: 2, label: "h264 (legacy)" },
    ],
    DISPLAY_RESOLUTION_PRESETS: [
      { value: 0, label: "832p" },
      { value: 1, label: "720p" },
      { value: 2, label: "640p" },
      { value: 3, label: "544p" },
      { value: 4, label: "480p" },
    ],
    // Android "Display size" expressed as a percentage of the density the
    // resolution preset would normally use. Lower = smaller UI elements.
    DISPLAY_UI_SCALES: [
      { value: 100, label: "100% (Android default)" },
      { value: 85, label: "85% (Android minimum)" },
      { value: 75, label: "75%" },
      { value: 65, label: "65%" },
    ],
    // Applied automatically whenever the box still holds the stock density
    // for its preset and the user has never picked a UI scale explicitly.
    DEFAULT_UI_SCALE: 85,
    UI_SCALE_USER_SET_KEY: "ta.uiScale.userSet",
    DISPLAY_QUALITY_PRESETS: [
      { value: 40, label: "40" },
      { value: 50, label: "50" },
      { value: 60, label: "60" },
      { value: 70, label: "70" },
      { value: 80, label: "80" },
      { value: 90, label: "90" },
    ],
    DISPLAY_REFRESH_RATE_PRESETS: [
      { value: 30, label: "30 Hz" },
      { value: 45, label: "45 Hz" },
      { value: 60, label: "60 Hz" },
    ],
    SOFT_AP_BANDS: [
      { key: "band2_4GHz", name: "2.4 GHz", band: 1, channel: 6, channelWidth: 2 },
      { key: "band5GHz36", name: "5 GHZ - Channel 36", band: 2, channel: 36, channelWidth: 3 },
      { key: "band5GHz44", name: "5 GHZ - Channel 44", band: 2, channel: 44, channelWidth: 3 },
      { key: "band5GHz149", name: "5 GHZ - Channel 149", band: 2, channel: 149, channelWidth: 3 },
      { key: "band5GHz157", name: "5 GHZ - Channel 157", band: 2, channel: 157, channelWidth: 3 },
    ],
  };

  TAHtml.log = function log(message) {
    // Uncomment for debugging:
    // console.log("[tesla-android-web]", message);
  };

  // Device endpoint resolution.
  // Default is the production hostname served by the box over TLS. For
  // development the device can be overridden with ?device=<host> (remembered
  // in localStorage) so the page can be served from any machine and still
  // talk to a Tesla Android box. An IP or non-production host is reached
  // over plain http/ws because the box's certificate only covers the
  // production hostname.
  const DEFAULT_DEVICE_DOMAIN = "device.teslaandroid.com";
  const DEVICE_OVERRIDE_KEY = "ta.device.override";

  function resolveDeviceDomain() {
    try {
      const params = new URLSearchParams(global.location.search || "");
      if (params.has("device")) {
        const requested = String(params.get("device") || "").trim();
        if (requested.length === 0 || requested === "default") {
          global.localStorage.removeItem(DEVICE_OVERRIDE_KEY);
        } else {
          global.localStorage.setItem(DEVICE_OVERRIDE_KEY, requested);
        }
      }
      const stored = global.localStorage.getItem(DEVICE_OVERRIDE_KEY);
      if (stored && stored.length > 0) {
        return stored;
      }
    } catch (_error) {
      // localStorage may be unavailable; fall through to default
    }
    return DEFAULT_DEVICE_DOMAIN;
  }

  TAHtml.createFlavor = function createFlavor() {
    const domain = resolveDeviceDomain();
    const secure = domain === DEFAULT_DEVICE_DOMAIN;
    const http = secure ? "https" : "http";
    const ws = secure ? "wss" : "ws";
    return {
      domain,
      isDeviceOverridden: domain !== DEFAULT_DEVICE_DOMAIN,
      apiBaseUrl: http + "://" + domain + "/api",
      audioWebSocket: ws + "://" + domain + "/sockets/audio",
      displayWebSocket: ws + "://" + domain + "/sockets/display",
      gpsWebSocket: ws + "://" + domain + "/sockets/gps",
      touchscreenWebSocket: ws + "://" + domain + "/sockets/touchscreen",
    };
  };

  TAHtml.utils = {
    toInt,
    clamp,
    alignUp,
    delay,
    compareVersions,
    parseBoolean,
    getViewportSize,
    normalizeSize,
    sameSize,
    createElement,
    mapSoftApBandFromConfig,
    densityForResolutionPreset,
    densityForUiScale,
    uiScaleForDensity,
    effectiveDensity,
    markUiScaleUserSet,
    rendererName,
    resolutionPresetName,
    qualityPresetName,
    refreshRateName,
    mapDeviceModelName,
  };

  function toInt(value, fallback) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
    return fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function alignUp(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      global.setTimeout(resolve, ms);
    });
  }

  function compareVersions(currentVersion, latestVersion) {
    const currentParts = String(currentVersion || "")
      .split(".")
      .map((part) => toInt(part, 0));
    const latestParts = String(latestVersion || "")
      .split(".")
      .map((part) => toInt(part, 0));

    const maxLength = Math.max(currentParts.length, latestParts.length);
    for (let index = 0; index < maxLength; index += 1) {
      const currentValue = index < currentParts.length ? currentParts[index] : 0;
      const latestValue = index < latestParts.length ? latestParts[index] : 0;
      if (latestValue > currentValue) {
        return 1;
      }
      if (latestValue < currentValue) {
        return -1;
      }
    }
    return 0;
  }

  function parseBoolean(value) {
    if (value === true || value === "true" || value === "1" || value === 1) {
      return true;
    }
    if (value === false || value === "false" || value === "0" || value === 0) {
      return false;
    }
    return null;
  }

  function getViewportSize() {
    if (global.visualViewport) {
      return {
        width: Math.max(1, Math.round(global.visualViewport.width)),
        height: Math.max(1, Math.round(global.visualViewport.height)),
      };
    }

    return {
      width: Math.max(1, Math.round(global.innerWidth)),
      height: Math.max(1, Math.round(global.innerHeight)),
    };
  }

  function normalizeSize(size, options) {
    const fallback = options && options.fallback ? options.fallback : { width: 1, height: 1 };

    const width = toInt(size && size.width, fallback.width);
    const height = toInt(size && size.height, fallback.height);

    return {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  }

  function sameSize(left, right) {
    if (!left || !right) {
      return false;
    }
    return left.width === right.width && left.height === right.height;
  }

  function createElement(tag, className, textContent) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (textContent !== undefined && textContent !== null) {
      element.textContent = textContent;
    }
    return element;
  }

  function mapSoftApBandFromConfig(config) {
    const band = toInt(config && config["persist.tesla-android.softap.band_type"], 1);
    const channel = toInt(config && config["persist.tesla-android.softap.channel"], 6);

    if (band === 1) {
      return TAHtml.constants.SOFT_AP_BANDS[0];
    }

    for (let index = 0; index < TAHtml.constants.SOFT_AP_BANDS.length; index += 1) {
      const item = TAHtml.constants.SOFT_AP_BANDS[index];
      if (item.channel === channel) {
        return item;
      }
    }
    return TAHtml.constants.SOFT_AP_BANDS[1];
  }

  function densityForResolutionPreset(preset, isH264) {
    const normalizedPreset = toInt(preset, 0);
    if (isH264) {
      switch (normalizedPreset) {
        case 0:
          return 200;
        case 1:
          return 175;
        default:
          return 175;
      }
    }
    switch (normalizedPreset) {
      case 0:
        return 200;
      case 1:
        return 175;
      case 2:
        return 155;
      case 3:
        return 130;
      case 4:
        return 115;
      default:
        return 200;
    }
  }

  function rendererName(renderer) {
    return _lookupLabel(TAHtml.constants.DISPLAY_RENDERERS, renderer, "Motion JPEG");
  }

  // Density to send to the box for a given preset and UI scale percentage.
  function densityForUiScale(preset, isH264, scalePercent) {
    const base = densityForResolutionPreset(preset, isH264);
    const scale = clamp(toInt(scalePercent, 100), 50, 100);
    return Math.max(80, Math.round((base * scale) / 100));
  }

  // The density the fork wants on the box: honours whatever is stored unless
  // it is still the stock value for the preset and the user never chose a
  // scale, in which case the fork default (smallest Android size) applies.
  function effectiveDensity(preset, isH264, storedDensity) {
    const base = densityForResolutionPreset(preset, isH264);
    const stored = toInt(storedDensity, 0);
    let userSet = false;
    try {
      userSet = global.localStorage.getItem(TAHtml.constants.UI_SCALE_USER_SET_KEY) === "1";
    } catch (_error) {
      userSet = false;
    }
    if (stored === base && !userSet) {
      return densityForUiScale(preset, isH264, TAHtml.constants.DEFAULT_UI_SCALE);
    }
    if (stored >= 80 && stored <= 400) {
      return stored;
    }
    return densityForUiScale(preset, isH264, TAHtml.constants.DEFAULT_UI_SCALE);
  }

  function markUiScaleUserSet() {
    try {
      global.localStorage.setItem(TAHtml.constants.UI_SCALE_USER_SET_KEY, "1");
    } catch (_error) {
      // no-op
    }
  }

  // Reverse of densityForUiScale: which UI scale option best explains the
  // density currently stored on the box. Snaps to the nearest option so a
  // density written by an older frontend still maps to "Default".
  function uiScaleForDensity(preset, isH264, density) {
    const base = densityForResolutionPreset(preset, isH264);
    const actual = toInt(density, base);
    if (!base || !actual) {
      return 100;
    }
    const percent = (actual / base) * 100;
    const options = TAHtml.constants.DISPLAY_UI_SCALES;
    let best = options[0].value;
    let bestDistance = Infinity;
    for (let index = 0; index < options.length; index += 1) {
      const distance = Math.abs(options[index].value - percent);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = options[index].value;
      }
    }
    return best;
  }

  function resolutionPresetName(preset) {
    return _lookupLabel(TAHtml.constants.DISPLAY_RESOLUTION_PRESETS, preset, "832p");
  }

  function qualityPresetName(value) {
    return _lookupLabel(TAHtml.constants.DISPLAY_QUALITY_PRESETS, value, "90");
  }

  function refreshRateName(value) {
    return _lookupLabel(TAHtml.constants.DISPLAY_REFRESH_RATE_PRESETS, value, "30 Hz");
  }

  function mapDeviceModelName(rawModel) {
    if (rawModel === "rpi4") {
      return "Raspberry Pi 4";
    }
    if (rawModel === "cm4") {
      return "Compute Module 4";
    }
    return "UNOFFICIAL " + String(rawModel || "undefined");
  }

  function _lookupLabel(options, value, fallback) {
    const target = toInt(value, toInt(options[0].value, 0));
    for (let index = 0; index < options.length; index += 1) {
      if (toInt(options[index].value, 0) === target) {
        return options[index].label;
      }
    }
    return fallback;
  }
})(window);

(function (global) {
  "use strict";

  const TAHtml = global.TAHtml;

  // Remembers whether the user last left browser audio on or off, so a
  // reload comes back in the same state without a button press.
  const AUTOSTART_PREF_KEY = "ta.audio.autostart";

  // Events that count as a user gesture for the browser's autoplay policy.
  // For touch input only the "up" side of the gesture grants activation,
  // so pointerdown alone is not enough.
  const GESTURE_EVENTS = ["pointerup", "touchend", "mousedown", "keydown", "click"];

  class AudioController {
    constructor(options) {
      this.audioWebsocketUrl = options.audioWebsocketUrl;
      this.state = "stopped";
      this.enabled = true;
      this.volume = 1.0;
      this._wired = false;
      this._pollId = null;
      this._gestureHandler = null;
    }

    initialize() {
      this._registerGlobalBridge();
      this._wireAudioElementEvents();
    }

    applyConfiguration(config) {
      const cfg = typeof config === "string" ? this._safeJsonParse(config) : config;
      if (!cfg || typeof cfg !== "object") {
        return;
      }

      this.audioWebsocketUrl = cfg.audioWebsocketUrl || this.audioWebsocketUrl;
      global.audioWebsocketUrl = this.audioWebsocketUrl;

      this.enabled = String(cfg.isAudioEnabled) !== "false";
      this.volume = Number(cfg.audioVolume ?? 1.0);

      try {
        if (typeof global.setAudioEnabled === "function") {
          global.setAudioEnabled(this.enabled);
        }
      } catch (_error) {
        // no-op
      }

      try {
        if (typeof global.setAudioVolume === "function") {
          global.setAudioVolume(this.volume);
        }
      } catch (_error) {
        // no-op
      }
    }

    isAudioEnabled() {
      return this.enabled;
    }

    getAudioState() {
      return this.state;
    }

    startFromGesture() {
      try {
        if (typeof global.primeAudioFromGesture === "function") {
          global.primeAudioFromGesture();
        }
      } catch (_error) {
        // no-op
      }

      try {
        if (typeof global.startAudioPlayback === "function") {
          global.startAudioPlayback();
        }
      } catch (_error) {
        // no-op
      }

      this._setState("playing");
      this._wireAudioElementEvents();
    }

    stop() {
      try {
        if (typeof global.stopAudioPlayback === "function") {
          global.stopAudioPlayback();
        }
      } catch (_error) {
        // no-op
      }
      this._setState("stopped");
    }

    toggle() {
      if (!this.enabled) {
        return;
      }
      if (this.state === "playing") {
        this._setAutostartPreference(false);
        this._detachGestureListener();
        this.stop();
      } else {
        this._setAutostartPreference(true);
        this.startFromGesture();
      }
    }

    // Start audio without waiting for the audio button.
    //
    // 1. Try to start immediately. Browsers that already trust this page
    //    (or that do not enforce an autoplay policy) will play right away.
    // 2. If the browser blocks it, the first touch or key press anywhere on
    //    the page is used as the unlocking gesture. The user is going to
    //    touch the Android display within seconds anyway, so audio appears
    //    to "just work".
    //
    // Respects the box-level "browser audio" switch and the user's last
    // on/off choice made with the audio button.
    autoStart() {
      if (!this.enabled) {
        return;
      }
      if (!this._getAutostartPreference()) {
        return;
      }
      if (this.state === "playing") {
        return;
      }

      this._attachGestureListener();

      try {
        if (typeof global.startAudioPlayback === "function") {
          global.startAudioPlayback();
        }
      } catch (_error) {
        // no-op; gesture listener remains as fallback
      }
    }

    _attachGestureListener() {
      if (this._gestureHandler) {
        return;
      }
      this._gestureHandler = () => {
        this._detachGestureListener();
        if (!this.enabled || !this._getAutostartPreference()) {
          return;
        }
        if (this.state !== "playing") {
          this.startFromGesture();
        } else {
          // Already playing (immediate start succeeded); still prime the
          // element from a real gesture so later resumes are permitted.
          try {
            if (typeof global.primeAudioFromGesture === "function") {
              global.primeAudioFromGesture();
            }
          } catch (_error) {
            // no-op
          }
        }
      };
      for (let index = 0; index < GESTURE_EVENTS.length; index += 1) {
        global.document.addEventListener(GESTURE_EVENTS[index], this._gestureHandler, {
          capture: true,
          passive: true,
        });
      }
    }

    _detachGestureListener() {
      if (!this._gestureHandler) {
        return;
      }
      for (let index = 0; index < GESTURE_EVENTS.length; index += 1) {
        global.document.removeEventListener(GESTURE_EVENTS[index], this._gestureHandler, {
          capture: true,
        });
      }
      this._gestureHandler = null;
    }

    _getAutostartPreference() {
      try {
        const raw = global.localStorage.getItem(AUTOSTART_PREF_KEY);
        return raw === null ? true : raw !== "0";
      } catch (_error) {
        return true;
      }
    }

    _setAutostartPreference(enabled) {
      try {
        global.localStorage.setItem(AUTOSTART_PREF_KEY, enabled ? "1" : "0");
      } catch (_error) {
        // no-op
      }
    }

    _registerGlobalBridge() {
      global.setupAudioConfig = (config) => {
        this.applyConfiguration(config);
      };
      global.startAudioFromGesture = () => {
        this.startFromGesture();
      };
      global.stopAudio = () => {
        this.stop();
      };
      global.getAudioState = () => this.state;
    }

    _wireAudioElementEvents() {
      if (this._wired) {
        return;
      }

      const wire = () => {
        if (this._wired) {
          return;
        }

        const el = global.__liveAudioEl || document.querySelector("audio");
        if (!el) {
          return;
        }

        const toStopped = () => this._setState("stopped");
        const toPlaying = () => this._setState("playing");

        el.addEventListener("play", toPlaying);
        el.addEventListener("playing", toPlaying);
        el.addEventListener("pause", toStopped);
        el.addEventListener("ended", toStopped);
        el.addEventListener("error", toStopped);
        el.addEventListener("emptied", toStopped);

        this._wired = true;
      };

      global.addEventListener("audio-el-created", wire);
      wire();

      if (!this._wired) {
        this._pollId = global.setInterval(() => {
          wire();
          if (this._wired && this._pollId !== null) {
            global.clearInterval(this._pollId);
            this._pollId = null;
          }
        }, 250);
      }
    }

    _setState(nextState) {
      if (this.state === nextState) {
        return;
      }
      this.state = nextState;
      try {
        global.dispatchEvent(
          new CustomEvent("audio-state", {
            detail: String(nextState),
          }),
        );
      } catch (_error) {
        // no-op
      }
    }

    _safeJsonParse(raw) {
      try {
        return JSON.parse(raw);
      } catch (_error) {
        return null;
      }
    }
  }

  TAHtml.AudioController = AudioController;
})(window);

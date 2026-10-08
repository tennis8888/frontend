(function (global) {
  "use strict";

  const TAHtml = global.TAHtml;

  document.addEventListener("DOMContentLoaded", () => {
    registerOfflineSupport();
    void bootstrap();
  });

  // Offline support. On a secure origin (bij.to/ta) a service worker keeps a
  // copy of every file of this page, so after one online visit the page opens
  // with no internet at all. Plain-http copies (the one served from the box)
  // and local development skip this; the browser only allows it on https.
  function registerOfflineSupport() {
    try {
      if (!("serviceWorker" in global.navigator) || !global.isSecureContext) {
        return;
      }
      const host = String(global.location.hostname || "");
      if (host === "localhost" || host === "127.0.0.1") {
        return;
      }
      const base = new URL("./", global.location.href).pathname;
      // Scope without the trailing slash also covers a bare "/ta" visit.
      const wideScope = base.length > 1 ? base.replace(/\/$/, "") : "/";
      global.navigator.serviceWorker
        .register("./sw.js", { scope: wideScope })
        .catch(() => global.navigator.serviceWorker.register("./sw.js"))
        .catch((error) => TAHtml.log("Service worker registration failed: " + String(error)));
      if (global.navigator.storage && typeof global.navigator.storage.persist === "function") {
        global.navigator.storage.persist().catch(() => {});
      }
    } catch (error) {
      TAHtml.log("Offline support unavailable: " + String(error));
    }
  }

  // Backup copy of this page served by the box itself (Termux, port 8090).
  const BOX_COPY_URL = "http://device.teslaandroid.com:8090/";
  const BOX_SEEN_KEY = "ta.box.seen";
  const FALLBACK_TRIED_KEY = "ta.fallback.tried";

  function rememberBoxSeen() {
    try {
      global.localStorage.setItem(BOX_SEEN_KEY, "1");
      global.sessionStorage.removeItem(FALLBACK_TRIED_KEY);
    } catch (_error) {
      // no-op
    }
  }

  function markFallbackTried() {
    try {
      global.sessionStorage.setItem(FALLBACK_TRIED_KEY, "1");
    } catch (_error) {
      // no-op
    }
  }

  // Only browsers that have reached the box before (the car) are sent to the
  // box copy, and only once per browsing session, so opening bij.to/ta away
  // from the car never bounces anywhere.
  function shouldFallBackToBoxCopy(flavor) {
    if (!flavor.isSecure || flavor.isDeviceOverridden) {
      return false;
    }
    try {
      return (
        global.localStorage.getItem(BOX_SEEN_KEY) === "1" &&
        global.sessionStorage.getItem(FALLBACK_TRIED_KEY) !== "1"
      );
    } catch (_error) {
      return false;
    }
  }

  // Self-healing for the black-screen case.
  // The box only sends display frames when the Android screen changes, so a
  // quiet stream is normal. What is not normal is the display connection
  // staying down while the box itself answers. In that case reload the page
  // (at most once a minute) so every connection and the renderer start fresh.
  const WATCHDOG_INTERVAL_MS = 3000;
  const SOCKET_DOWN_RELOAD_MS = 12000;
  const HIDDEN_LONG_MS = 30000;
  const RELOAD_GUARD_KEY = "ta.watchdog.lastReload";
  const RELOAD_MIN_GAP_MS = 60000;

  function startDisplayWatchdog(options) {
    const rendererManager = options.rendererManager;
    const apiClient = options.apiClient;
    const isArmed = options.isArmed;
    let socketDownSince = null;
    let hiddenSince = null;
    let checking = false;

    const socketOpen = () => {
      const socket = rendererManager.displaySocket;
      return Boolean(socket) && socket.readyState === 1;
    };

    const boxReachable = async () => {
      try {
        await apiClient.fetchHealthCheck();
        return true;
      } catch (_error) {
        return false;
      }
    };

    const reloadOnce = (reason) => {
      let last = 0;
      try {
        last = Number(global.sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      } catch (_error) {
        last = 0;
      }
      if (Date.now() - last < RELOAD_MIN_GAP_MS) {
        return;
      }
      try {
        global.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
      } catch (_error) {
        // no-op
      }
      TAHtml.log("Watchdog reload: " + reason);
      global.location.reload();
    };

    global.setInterval(async () => {
      if (global.document.hidden || checking || !isArmed()) {
        return;
      }
      if (socketOpen()) {
        socketDownSince = null;
        return;
      }
      if (socketDownSince === null) {
        socketDownSince = Date.now();
        return;
      }
      if (Date.now() - socketDownSince < SOCKET_DOWN_RELOAD_MS) {
        return;
      }
      checking = true;
      const reachable = await boxReachable();
      checking = false;
      if (reachable && !socketOpen()) {
        reloadOnce("display connection down while the box answers");
      }
    }, WATCHDOG_INTERVAL_MS);

    global.document.addEventListener("visibilitychange", async () => {
      if (global.document.hidden) {
        hiddenSince = Date.now();
        return;
      }
      const wasHiddenLong = hiddenSince !== null && Date.now() - hiddenSince > HIDDEN_LONG_MS;
      hiddenSince = null;
      if (!wasHiddenLong || !isArmed()) {
        return;
      }
      await TAHtml.utils.delay(2000);
      if (!socketOpen() && (await boxReachable())) {
        reloadOnce("back from background with the display down");
      }
    });
  }

  async function bootstrap() {
    const flavor = TAHtml.createFlavor();
    const apiClient = new TAHtml.ApiClient(flavor.apiBaseUrl);

    const elements = {
      displayRoot: document.getElementById("display-root"),
      displayLoading: document.getElementById("display-loading"),
      touchLayer: document.getElementById("touch-layer"),
      displayTypeDialog: document.getElementById("display-type-dialog"),
      displayTypeMainButton: document.getElementById("main-display-button"),
      displayTypeRearButton: document.getElementById("rear-display-button"),

      homeShell: document.getElementById("home-shell"),
      panelShell: document.getElementById("panel-shell"),
      appTitle: document.getElementById("app-title"),
      navButtons: Array.from(document.querySelectorAll(".bottom-nav-button")),
      connectivityBanner: document.getElementById("connectivity-banner"),
      connectivityBannerText: document.getElementById("connectivity-banner-text"),

      homeAudioButton: document.getElementById("home-audio-button"),
      homeUpdateButton: document.getElementById("home-update-button"),
      homeSettingsButton: document.getElementById("home-settings-button"),

      releaseVersions: document.getElementById("release-versions"),
      releaseDetails: document.getElementById("release-details"),

      settingsSidebar: document.getElementById("settings-sidebar"),
      settingsContent: document.getElementById("settings-content"),
      settingsBanner: document.getElementById("settings-banner"),
      settingsBannerText: document.getElementById("settings-banner-text"),
      settingsBannerAction: document.getElementById("settings-banner-action"),

      pageAbout: document.getElementById("page-about"),
      pageReleaseNotes: document.getElementById("page-release-notes"),
      pageDonations: document.getElementById("page-donations"),
      pageSettings: document.getElementById("page-settings"),

      appVersion: document.querySelectorAll("[data-app-version]"),
    };

    for (let index = 0; index < elements.appVersion.length; index += 1) {
      elements.appVersion[index].textContent = TAHtml.constants.APP_VERSION;
    }

    const audioController = new TAHtml.AudioController({
      audioWebsocketUrl: flavor.audioWebSocket,
    });
    audioController.initialize();

    let shellController = null;

    let hasDisplayEnteredNormalOnce = false;
    let resizeLoadingTimerId = null;
    let latestResizeMode = "initial";
    let lastDisplayFrameTimestamp = 0;
    const LOADING_VISIBILITY_DELAY_MS = 150;

    const setDisplayLoadingVisible = (visible) => {
      const shouldShow = Boolean(visible);
      if (elements.displayLoading) {
        elements.displayLoading.hidden = !shouldShow;
      }
      if (elements.displayRoot) {
        if (shouldShow) {
          elements.displayRoot.classList.add("is-loading");
        } else {
          elements.displayRoot.classList.remove("is-loading");
        }
      }
      if (elements.touchLayer) {
        elements.touchLayer.style.pointerEvents = shouldShow ? "none" : "auto";
      }
    };

    const rendererManager = new TAHtml.DisplayRendererManager({
      displayRoot: elements.displayRoot,
      onSocketOpen: () => {
        if (shellController) {
          shellController.requestConnectivityCheck("display_socket_open");
        }
      },
      onSocketClose: () => {
        if (shellController) {
          shellController.requestConnectivityCheck("display_socket_close");
        }
      },
      onSocketError: () => {
        if (shellController) {
          shellController.requestConnectivityCheck("display_socket_error");
        }
      },
      onFrameReceived: () => {
        lastDisplayFrameTimestamp = Date.now();
        if (resizeLoadingTimerId !== null) {
          global.clearTimeout(resizeLoadingTimerId);
          resizeLoadingTimerId = null;
        }
        setDisplayLoadingVisible(false);
      },
    });

    const displayController = new TAHtml.DisplayController({
      apiClient,
      rendererManager,
      flavor,
      dialog: elements.displayTypeDialog,
      dialogMainButton: elements.displayTypeMainButton,
      dialogRearButton: elements.displayTypeRearButton,
      onResizeModeChange: (mode) => {
        latestResizeMode = mode;

        if (mode === "normal") {
          hasDisplayEnteredNormalOnce = true;
        }

        const isLoadingMode = mode === "resize_cooldown" || mode === "resize_in_progress";

        if (!hasDisplayEnteredNormalOnce) {
          setDisplayLoadingVisible(false);
          return;
        }

        if (!isLoadingMode) {
          if (resizeLoadingTimerId !== null) {
            global.clearTimeout(resizeLoadingTimerId);
            resizeLoadingTimerId = null;
          }
          setDisplayLoadingVisible(false);
          return;
        }

        if (resizeLoadingTimerId === null) {
          resizeLoadingTimerId = global.setTimeout(() => {
            resizeLoadingTimerId = null;
            const stillLoading =
              latestResizeMode === "resize_cooldown" || latestResizeMode === "resize_in_progress";
            const staleFrame =
              lastDisplayFrameTimestamp === 0 ||
              Date.now() - lastDisplayFrameTimestamp > LOADING_VISIBILITY_DELAY_MS;
            if (hasDisplayEnteredNormalOnce && stillLoading && staleFrame) {
              setDisplayLoadingVisible(true);
            }
          }, LOADING_VISIBILITY_DELAY_MS);
        }
      },
    });

    let systemConfiguration = null;
    for (let attempt = 0; attempt < 2 && !systemConfiguration; attempt += 1) {
      try {
        systemConfiguration = await apiClient.fetchSystemConfiguration();
      } catch (error) {
        TAHtml.log("Unable to fetch system configuration during bootstrap: " + String(error));
        if (attempt === 0) {
          await TAHtml.utils.delay(2000);
        }
      }
    }

    if (systemConfiguration) {
      rememberBoxSeen();
    } else if (shouldFallBackToBoxCopy(flavor)) {
      // The secure page cannot reach the box (no box Wi-Fi yet, or the box's
      // certificate has expired). Hand over to the copy the box serves itself
      // over plain http, which needs no certificate and no internet.
      markFallbackTried();
      global.location.href = BOX_COPY_URL;
      return;
    }

    if (systemConfiguration) {
      audioController.applyConfiguration({
        audioWebsocketUrl: flavor.audioWebSocket,
        isAudioEnabled:
          TAHtml.utils.toInt(
            systemConfiguration["persist.tesla-android.browser_audio.is_enabled"],
            1,
          ) === 1,
        audioVolume:
          TAHtml.utils.toInt(
            systemConfiguration["persist.tesla-android.browser_audio.volume"],
            100,
          ) / 100,
      });
    }

    try {
      await displayController.initialize();
    } catch (error) {
      TAHtml.log("Unable to initialize display controller: " + String(error));
      return;
    }

    const gpsController = new TAHtml.GpsController({
      socketUrl: flavor.gpsWebSocket,
      isEnabled:
        systemConfiguration
          ? TAHtml.utils.toInt(systemConfiguration["persist.tesla-android.gps.is_active"], 1) === 1
          : true,
    });
    gpsController.initialize();

    const touchscreenController = new TAHtml.TouchscreenController({
      touchLayer: elements.touchLayer,
      socketUrl: flavor.touchscreenWebSocket,
      getTouchscreenSize: () => displayController.getTouchscreenSize(),
    });
    touchscreenController.initialize();
    displayController.setResizeSessionRefreshHandler(() => {
      touchscreenController.restartSocket();
    });

    const releaseNotesController = new TAHtml.ReleaseNotesController({
      versionsContainer: elements.releaseVersions,
      detailsContainer: elements.releaseDetails,
    });

    const homeController = new TAHtml.HomeController({
      apiClient,
      audioController,
      audioButton: elements.homeAudioButton,
      updateButton: elements.homeUpdateButton,
      settingsButton: elements.homeSettingsButton,
      onSettingsRequested: () => {
        if (shellController) {
          shellController.setPage("about");
        }
      },
    });

    const settingsController = new TAHtml.SettingsController({
      apiClient,
      displayController,
      gpsController,
      audioController,
      flavor,
      sidebar: elements.settingsSidebar,
      content: elements.settingsContent,
      banner: elements.settingsBanner,
      bannerText: elements.settingsBannerText,
      bannerAction: elements.settingsBannerAction,
      onSystemConfigurationChanged: (configuration) => {
        homeController.applySystemConfiguration(configuration);
        gpsController.setEnabled(
          TAHtml.utils.toInt(configuration["persist.tesla-android.gps.is_active"], 1) === 1,
        );
      },
    });
    await settingsController.initialize();

    shellController = new TAHtml.ShellController({
      apiClient,
      displayController,
      settingsController,
      releaseNotesController,
      homeShell: elements.homeShell,
      panelShell: elements.panelShell,
      panelViews: {
        about: elements.pageAbout,
        releaseNotes: elements.pageReleaseNotes,
        donations: elements.pageDonations,
        settings: elements.pageSettings,
      },
      appTitle: elements.appTitle,
      navButtons: elements.navButtons,
      connectivityBanner: elements.connectivityBanner,
      connectivityBannerText: elements.connectivityBannerText,
    });

    shellController.initialize();

    await homeController.initialize(systemConfiguration || {});

    // Start browser audio without requiring a press on the audio button.
    // Falls back to the first touch anywhere on the page if the browser's
    // autoplay policy blocks the immediate attempt.
    audioController.autoStart();

    startDisplayWatchdog({
      rendererManager,
      apiClient,
      isArmed: () => lastDisplayFrameTimestamp > 0,
    });
  }
})(window);

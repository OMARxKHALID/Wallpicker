// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import St from "gi://St";
import Clutter from "gi://Clutter";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as UnlockDialog from "resource:///org/gnome/shell/ui/unlockDialog.js";

import {
  getImagesAsync,
  setWallpaper,
  getCurrentWallpaper,
  flushStats,
  resetModule,
  initModuleAsync,
  initUtils,
  logDebug,
  logError,
  DEFAULT_WALL_DIR,
} from "./utils.js";

const APP_ICON = "emblem-photos-symbolic";
const SMALL_ICON_SIZE = 16;
const PREFS_FOCUS_TIMEOUT = 5000;
const SCHEMA_ID = "org.gnome.shell.extensions.wallpicker";

/**
 * WallpickerExtension:
 *
 * The Shell-side component of the Wallpicker extension.
 * Handles the top-bar interaction menu and coordinates the out-of-process
 * preferences window lifecycle.
 */
export default class WallpickerExtension extends Extension {
  /**
   * _loadSettings:
   *
   * Manually loads the GSettings schema from the extension's local directory.
   * This ensures the extension can access its own keys even before it's
   * globally installed in system paths.
   */
  _loadSettings() {
    const GioSSS = Gio.SettingsSchemaSource;
    const schemaDir = this.dir.get_child("schemas");
    const schemaSource = GioSSS.new_from_directory(
      schemaDir.get_path(),
      GioSSS.get_default(),
      false,
    );
    const schemaObj = schemaSource.lookup(SCHEMA_ID, true);
    if (!schemaObj) {
      throw new Error(
        `Schema ${SCHEMA_ID} not found in ${schemaDir.get_path()}`,
      );
    }
    return new Gio.Settings({ settings_schema: schemaObj });
  }

  enable() {
    if (this._button) return;

    this._signalIds = [];
    this._prefsWinSigId = null;
    this._prefsFocusTid = null;
    this._winActivateIdleId = null;
    this._paintOverlayIdleId = null;
    this._restoreCentering = null;

    this._extSettings = this._loadSettings();
    initUtils(this._extSettings);

    initModuleAsync().catch((e) => logError("Module init failed", e));

    this._button = new PanelMenu.Button(0.5, _("Wallpicker"), false);

    // Initialize the lock screen background synchronization system.
    this._setupLockScreenSync();

    const box = new St.BoxLayout({
      style_class: "panel-status-menu-box",
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    box.add_child(
      new St.Icon({
        icon_name: APP_ICON,
        style_class: "system-status-icon",
        icon_size: SMALL_ICON_SIZE,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );

    this._button.add_child(box);
    this._buildMenu();
    Main.panel.addToStatusArea(this.uuid, this._button);
  }

  disable() {
    // Teardown the lock screen sync to restore original system behavior.
    this._teardownLockScreenSync();

    if (this._syncSignalId) {
      this._extSettings?.disconnect(this._syncSignalId);
      this._syncSignalId = null;
    }
    this._extSettings = null;

    this._cancelWatch();
    for (const { obj, id } of this._signalIds ?? []) {
      obj.disconnect(id);
    }
    this._signalIds = null;
    this._button?.destroy();
    this._button = null;

    // Flush telemetry and clear cached state to ensure clean re-initialization.
    flushStats();
    resetModule();
  }

  _buildMenu() {
    const items = [
      {
        label: _("Pick Wallpaper"),
        icon: APP_ICON,
        action: () => this._openPrefs(),
      },
      {
        label: _("Shuffle Wallpaper"),
        icon: "media-playlist-shuffle-symbolic",
        action: () => {
          this._shuffleWallpaper().catch((e) =>
            logError("Shuffle failed", e),
          );
        },
      },
      { separator: true },
      {
        label: _("Open Wallpapers Folder"),
        icon: "folder-pictures-symbolic",
        action: () => this._openWallpapersFolder(),
      },
    ];

    for (const item of items) {
      if (item.separator) {
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        continue;
      }
      const mi = new PopupMenu.PopupImageMenuItem(item.label, item.icon);
      mi.set_style(`icon-size: ${SMALL_ICON_SIZE}px;`);
      this._signalIds.push({
        obj: mi,
        id: mi.connect("activate", item.action),
      });
      this._button.menu.addMenuItem(mi);
    }
  }

  /**
   * _openPrefs:
   *
   * Manages the launch of the preferences window with cross-platform focus
   * workarounds.
   *
   * Architecture:
   * - Wayland Focus: GNOME Shell prevents out-of-process windows from stealing
   *   focus. We circumvent this by hooking 'window-created' and calling
   *   activate() from the Shell process context.
   * - Centering: Temporarily overrides Mutter's 'center-new-windows' setting
   *   since direct window positioning is restricted on Wayland.
   */
  _openPrefs() {
    this._cancelWatch();

    const s = new Gio.Settings({ schema_id: "org.gnome.mutter" });
    const wasCentered = s.get_boolean("center-new-windows");
    if (!wasCentered) s.set_boolean("center-new-windows", true);

    this._restoreCentering = () => {
      if (!wasCentered) s.set_boolean("center-new-windows", false);
      this._restoreCentering = null;
    };

    this._prefsWinSigId = global.display.connect(
      "window-created",
      (_d, win) => {
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (!win.get_wm_class()?.toLowerCase().includes("wallpicker")) return;

        // Use idle callback to ensure the surface is fully mapped before activation.
        this._winActivateIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          this._winActivateIdleId = null;
          this._cancelWatch();
          try {
            win.activate(global.get_current_time());
          } catch (e) {
            logDebug(`Focus activation failed: ${e.message}`);
          }
          return GLib.SOURCE_REMOVE;
        });
      },
    );

    this._prefsFocusTid = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PREFS_FOCUS_TIMEOUT,
      () => {
        this._prefsFocusTid = null;
        this._cancelWatch();
        return GLib.SOURCE_REMOVE;
      },
    );

    this.openPreferences();
  }

  _cancelWatch() {
    this._restoreCentering?.();
    if (this._prefsWinSigId !== null) {
      global.display.disconnect(this._prefsWinSigId);
      this._prefsWinSigId = null;
    }
    if (this._prefsFocusTid !== null) {
      GLib.Source.remove(this._prefsFocusTid);
      this._prefsFocusTid = null;
    }
    if (this._winActivateIdleId !== null) {
      GLib.Source.remove(this._winActivateIdleId);
      this._winActivateIdleId = null;
    }
    if (this._paintOverlayIdleId !== null) {
      GLib.Source.remove(this._paintOverlayIdleId);
      this._paintOverlayIdleId = null;
    }
  }

  _shuffleWallpaper() {
    try {
      const settings = this._loadSettings();
      const dirs = settings.get_strv("wall-dirs");
      if (dirs.length === 0) dirs.push(DEFAULT_WALL_DIR);

      getImagesAsync(dirs, "A-Z", settings.get_int("max-images"), (images) => {
        if (!images.length) {
          Main.notify(_("Wallpicker"), _("No wallpapers found."));
          return;
        }
        setWallpaper(
          images[Math.floor(Math.random() * images.length)],
          settings.get_string("picture-mode"),
        ).catch((e) => logError("Shuffle setWallpaper failed", e));
      });
    } catch (e) {
      logError("Shuffle transition failed", e);
    }
  }

  async _openWallpapersFolder() {
    try {
      const settings = this._loadSettings();
      const dirs = settings.get_strv("wall-dirs");
      if (dirs.length === 0) dirs.push(DEFAULT_WALL_DIR);
      let folderPath = dirs[0] ?? null;

      const curr = getCurrentWallpaper();
      if (curr) {
        const dirname = Gio.File.new_for_path(curr).get_parent()?.get_path();
        if (dirname) {
          const isUnder = dirs.some(
            (d) => dirname === d || dirname.startsWith(`${d}/`),
          );
          if (isUnder) folderPath = dirname;
        }
      }

      if (!folderPath) {
        this._openPrefs();
        return;
      }

      const file = Gio.File.new_for_path(folderPath);
      const exists = await new Promise((resolve) => {
        file.query_info_async(
          "standard::name",
          Gio.FileQueryInfoFlags.NONE,
          GLib.PRIORITY_DEFAULT,
          null,
          (f, res) => {
            try {
              resolve(!!f.query_info_finish(res));
            } catch (_) {
              resolve(false);
            }
          },
        );
      });

      if (!exists) {
        Main.notify(_("Wallpicker"), `${_("Folder Not Found")}: ${folderPath}`);
        return;
      }

      Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
    } catch (e) {
      logError("Folder launch failed", e);
    }
  }

  /**
   * _setupLockScreenSync:
   *
   * Orchestrates the synchronization of the desktop wallpaper with the lock
   * screen background, including aggressive blur suppression.
   *
   * Architecture:
   * - Monkey-patching: GNOME's UnlockDialog._updateBackgroundEffects is
   *   patched to a no-op to prevent the shell from applying its own blur
   *   and dimming logic, which often resets on every screen-wake.
   * - Performance: We use a custom St.Widget overlay rather than modifying
   *   existing background actors to avoid layout thrashing during shell
   *   transitions.
   */
  _setupLockScreenSync() {
    this._bgSettings = new Gio.Settings({
      schema_id: "org.gnome.desktop.background",
    });
    this._extSettings = this._loadSettings();
    this._bgSignalId = null;
    this._origUpdateBackgroundEffects = null;

    const toggleSync = () => {
      const enabled = this._extSettings.get_boolean("sync-lockscreen");
      if (enabled) {
        this._startSync();
      } else {
        this._teardownLockScreenSync();
      }
    };

    if (!this._syncSignalId) {
      this._syncSignalId = this._extSettings.connect(
        "changed::sync-lockscreen",
        toggleSync,
      );
    }

    toggleSync();
  }

  _startSync() {
    if (this._bgSignalId) return;

    // Stop GNOME from applying its default blur/dimming logic by patching
    // the prototype method responsible for background effects.
    if (UnlockDialog?.UnlockDialog?.prototype?._updateBackgroundEffects) {
      if (!this._origUpdateBackgroundEffects) {
        this._origUpdateBackgroundEffects =
          UnlockDialog.UnlockDialog.prototype._updateBackgroundEffects;
      }

      UnlockDialog.UnlockDialog.prototype._updateBackgroundEffects = function (
        _monitorIndex,
      ) {
        // No-op: Prevents system blur from being applied to the background.
      };
    }

    const onBgChanged = () => this._applyWallpaperOverlay();
    this._bgSignalId = this._bgSettings.connect("changed", onBgChanged);

    // Apply immediately to handle existing dialogs or recent changes.
    this._applyWallpaperOverlay();
  }

  _teardownLockScreenSync() {
    // Restore original prototype behavior to re-enable system blur.
    if (this._origUpdateBackgroundEffects) {
      UnlockDialog.UnlockDialog.prototype._updateBackgroundEffects =
        this._origUpdateBackgroundEffects;
      this._origUpdateBackgroundEffects = null;
    }

    if (this._bgSignalId) {
      this._bgSettings?.disconnect(this._bgSignalId);
      this._bgSignalId = null;
    }

    const bg = Main.screenShield?._dialog?._backgroundGroup;
    if (bg?._wallpickerBg) {
      bg.remove_child(bg._wallpickerBg);
      bg._wallpickerBg = null;
    }
  }

  /**
   * _applyWallpaperOverlay:
   *
   * Injects an unblurred wallpaper layer into the active lock screen dialog.
   * This is called on desktop wallpaper changes and ensures the lock screen
   * visually matches the desktop environment.
   */
  _applyWallpaperOverlay() {
    const dialog = Main.screenShield?._dialog;
    if (!dialog?._backgroundGroup) return;

    const uri =
      this._bgSettings?.get_string("picture-uri-dark") ||
      this._bgSettings?.get_string("picture-uri");
    if (!uri) return;

    const mode = this._bgSettings?.get_string("picture-options") || "zoom";
    this._paintOverlay(dialog._backgroundGroup, uri, mode);
  }

  /**
   * _paintOverlay:
   *
   * Handles the actual creation and styling of the lock screen overlay widget.
   *
   * Performance Trade-off: Uses GLib.idle_add to defer the styling until the
   * shell's main loop is free, preventing frame drops during the lock animation.
   */
  _paintOverlay(bg, uri, mode) {
    if (this._paintOverlayIdleId) {
      GLib.Source.remove(this._paintOverlayIdleId);
    }
    this._paintOverlayIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._paintOverlayIdleId = null;
      try {
        if (!bg._wallpickerBg) {
          bg._wallpickerBg = new St.Widget({
            style_class: "wallpicker-lockscreen-bg",
            x_expand: true,
            y_expand: true,
          });
          bg.add_child(bg._wallpickerBg);
        }

        let cssSize = "cover";
        let cssRepeat = "no-repeat";
        switch (mode) {
          case "stretched":
            cssSize = "100% 100%";
            break;
          case "centered":
            cssSize = "auto";
            break;
          case "wallpaper":
            cssSize = "auto";
            cssRepeat = "repeat";
            break;
          case "zoom":
          default:
            cssSize = "cover";
            break;
        }

        bg._wallpickerBg.set_style(`
          background-image: url('${uri}');
          background-size: ${cssSize};
          background-repeat: ${cssRepeat};
          background-position: center;
        `);

        // Ensure the wallpaper is the bottom-most layer but above black.
        bg.set_child_above_sibling(bg._wallpickerBg, null);
      } catch (e) {
        logDebug(`Overlay paint failed: ${e.message}`);
      }
      return GLib.SOURCE_REMOVE;
    });
  }
}

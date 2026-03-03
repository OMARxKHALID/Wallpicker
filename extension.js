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

import {
  getImagesAsync,
  setWallpaper,
  getCurrentWallpaper,
  flushStats,
  resetModule,
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
 * This class handles the top bar menu and orchestrates the launching
 * of the out-of-process GTK preferences window with proper focus
 * and positioning on Wayland/X11.
 */
export default class WallpickerExtension extends Extension {
  _loadSettings() {
    const GioSSS = Gio.SettingsSchemaSource;
    const schemaDir = this.dir.get_child("schemas");
    const schemaSource = GioSSS.new_from_directory(
      schemaDir.get_path(),
      GioSSS.get_default(),
      false,
    );
    const schemaObj = schemaSource.lookup(SCHEMA_ID, true);
    if (!schemaObj)
      throw new Error(
        `Schema ${SCHEMA_ID} not found in ${schemaDir.get_path()}`,
      );
    return new Gio.Settings({ settings_schema: schemaObj });
  }

  enable() {
    if (this._button) return;

    this._signalIds = [];
    this._prefsWinSigId = null;
    this._prefsFocusTid = null;
    this._restoreCentering = null;

    this._button = new PanelMenu.Button(0.5, _("Wallpicker"), false);

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
        action: () => this._shuffleWallpaper(),
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

      // Inline styles are used for simple properties like icon size to avoid
      // walking internal widget trees that fluctuate across Shell versions.
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
   * Orchestrates the preferences window launch.
   *
   * Wayland Centering: Using 'org.gnome.mutter center-new-windows' ensures the
   * compositor centers our window, as script-side positioning is restricted.
   *
   * Wayland Focus: Hooks 'window-created' to catch the surface and call
   * win.activate() from inside the Shell process, bypassing focus-stealing
   * prevention logic.
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

        // Verify the window belongs to our preferences process via WM_CLASS.
        if (!win.get_wm_class()?.toLowerCase().includes("wallpicker")) return;

        // Deferring ensures the surface is fully mapped and centered before
        // focus is requested or configuration is reverted.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          this._cancelWatch();
          try {
            win.activate(global.get_current_time());
          } catch (e) {
            console.debug(`[wallpicker] Focus activation failed: ${e.message}`);
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
        );
      });
    } catch (e) {
      console.error(`[wallpicker] Shuffle transition failed: ${e.message}`);
    }
  }

  _openWallpapersFolder() {
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
      if (!file.query_exists(null)) {
        Main.notify(_("Wallpicker"), `${_("Folder Not Found")}: ${folderPath}`);
        return;
      }

      Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
    } catch (e) {
      console.error(`[wallpicker] Folder launch failed: ${e.message}`);
    }
  }

  disable() {
    this._cancelWatch();
    for (const { obj, id } of this._signalIds ?? []) obj.disconnect(id);
    this._signalIds = null;
    this._button?.destroy();
    this._button = null;

    // Statistics must be flushed synchronously to ensure data persistence
    // during extension deactivation or shell shutdown.
    flushStats();
    resetModule();
  }
}

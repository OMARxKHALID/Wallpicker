// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Folders, Display and Storage preference pages.
//
// Mixed into WallpickerPreferences by prefs.js. Every method here runs with
// `this` bound to that instance, exactly as if it were declared in the class.

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import {
  logDebug,
  setWallpaper,
  getCacheInfoAsync,
  clearCacheAsync,
  shortenPath,
  DEFAULT_WALL_DIR,
  PICTURE_MODES,
  PICTURE_MODE_LABELS,
  PICTURE_MODE_REVERSE,
} from "../utils.js";

// Extensions that blur or dim the lock screen and therefore hide a synced
// wallpaper. Keyed by UUID so the warning can name the actual culprit.
const BLUR_EXTENSIONS = {
  "blur-my-shell@aunetx": "Blur my Shell",
  "blyr@yozoon.dev.gmail.com": "Blyr",
  "lockscreen-extension@pratap.fastmail.fm": "Lock Screen Background",
};

export const pageMethods = {
  _conflictingBlurExtensions() {
    try {
      const shell = new Gio.Settings({ schema_id: "org.gnome.shell" });
      return shell
        .get_strv("enabled-extensions")
        .filter((uuid) => BLUR_EXTENSIONS[uuid])
        .map((uuid) => BLUR_EXTENSIONS[uuid]);
    } catch (e) {
      logDebug(`blur conflict check: ${e.message}`);
      return [];
    }
  },

  _buildFoldersPage() {
    const page = new Adw.PreferencesPage({
      title: "Folders",
      icon_name: "folder-pictures-symbolic",
    });
    this._foldersGroup = new Adw.PreferencesGroup({
      title: "Wallpaper Folders",
      description: "Images are pulled from all folders listed below.",
    });

    this._dirs = this._settings.get_strv("wall-dirs");
    if (this._dirs.length === 0) {
      this._dirs = [DEFAULT_WALL_DIR];
      this._settings.set_strv("wall-dirs", this._dirs);
    }
    this._folderRows = [];
    this._rebuildFolderRows();

    const addGroup = new Adw.PreferencesGroup();
    const addRow = new Adw.ActionRow({
      title: "Add Folder…",
      activatable: true,
    });
    addRow.add_prefix(
      new Gtk.Image({
        icon_name: "list-add-symbolic",
        pixel_size: 16,
        valign: Gtk.Align.CENTER,
      }),
    );
    addRow.connect("activated", () => this._onAddFolder());
    addGroup.add(addRow);

    page.add(this._foldersGroup);
    page.add(addGroup);
    return page;
  },

  _rebuildFolderRows() {
    for (const row of this._folderRows) this._foldersGroup.remove(row);
    this._folderRows = [];

    for (let i = 0; i < this._dirs.length; i++) {
      const dir = this._dirs[i];
      const short = shortenPath(dir);
      const row = new Adw.ActionRow({
        title: short,
        subtitle: short !== dir ? dir : "",
      });
      const btn = new Gtk.Button({
        icon_name: "user-trash-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["destructive-action", "flat"],
        tooltip_text: "Remove",
      });

      const idx = i;
      btn.connect("clicked", () => {
        this._dirs.splice(idx, 1);
        this._settings.set_strv("wall-dirs", this._dirs);
        this._rebuildFolderRows();
        this._loadImages();
      });

      row.add_suffix(btn);
      this._foldersGroup.add(row);
      this._folderRows.push(row);
    }
  },

  _onAddFolder() {
    const dlg = new Gtk.FileDialog({ title: "Select Wallpaper Folder" });
    dlg.select_folder(this._window, null, (d, res) => {
      try {
        const path = d.select_folder_finish(res)?.get_path();
        if (path && !this._dirs.includes(path)) {
          this._dirs.push(path);
          this._settings.set_strv("wall-dirs", this._dirs);
          this._rebuildFolderRows();
          this._loadImages();
        }
      } catch (_) {}
    });
  },

  _buildDisplayPage() {
    const page = new Adw.PreferencesPage({
      title: "Display",
      icon_name: "video-display-symbolic",
    });
    const gridGroup = new Adw.PreferencesGroup({ title: "Preferences" });

    const maxRow = new Adw.SpinRow({
      title: "Max Images",
      subtitle: "0 = show all (no limit)",
      numeric: true,
      adjustment: new Gtk.Adjustment({
        value: Number(this._settings.get_int("max-images")),
        lower: 0,
        upper: 2000,
        step_increment: 10,
        page_increment: 100,
      }),
    });

    maxRow.connect("changed", (editable) => {
      const text = editable.get_text();
      const filtered = text.replace(/[^\d]/g, "");
      if (text !== filtered) editable.set_text(filtered);
    });

    maxRow.connect("notify::value", (r) => {
      this._settings.set_int("max-images", Math.round(r.get_value()));
      if (this._limitTid) GLib.Source.remove(this._limitTid);
      this._limitTid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
        this._limitTid = null;
        this._loadImages();
        return GLib.SOURCE_REMOVE;
      });
    });
    gridGroup.add(maxRow);
    page.add(gridGroup);

    const modeGroup = new Adw.PreferencesGroup({ title: "Wallpaper Mode" });
    const currentLabel =
      PICTURE_MODE_REVERSE[this._settings.get_string("picture-mode")] ?? "Zoom";
    const modeRow = new Adw.ComboRow({
      title: "Display Mode",
      subtitle: "How the wallpaper fits the screen",
      model: new Gtk.StringList({ strings: PICTURE_MODE_LABELS }),
      selected: Math.max(PICTURE_MODE_LABELS.indexOf(currentLabel), 0),
    });
    modeRow.connect("notify::selected", (r) => {
      const label = PICTURE_MODE_LABELS[r.get_selected()];
      this._settings.set_string("picture-mode", PICTURE_MODES[label] ?? "zoom");
      if (this._current)
        setWallpaper(this._current, this._settings.get_string("picture-mode"));
    });
    modeGroup.add(modeRow);
    page.add(modeGroup);

    const conflicts = this._conflictingBlurExtensions();
    const lockscreenGroup = new Adw.PreferencesGroup({
      title: "Lock Screen",
      description: conflicts.length
        ? [
            "Sync desktop wallpaper to the lock screen.",
            `${conflicts.join(" and ")} ${conflicts.length > 1 ? "are" : "is"}`,
            "enabled and will blur the lock screen background, hiding the",
            "wallpaper. Turn off its lock screen blur to see this working.",
          ].join(" ")
        : "Sync desktop wallpaper to the lock screen.",
    });

    const syncRow = new Adw.SwitchRow({
      title: "Sync Wallpaper",
      subtitle: "Automatically match lock screen background to desktop",
    });
    this._settings.bind(
      "sync-lockscreen",
      syncRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    lockscreenGroup.add(syncRow);
    page.add(lockscreenGroup);

    const panelGroup = new Adw.PreferencesGroup({
      title: "Top Bar",
      description:
        "Only has a visible effect while something makes the top bar " +
        "transparent, such as a blur or transparency extension.",
    });
    const panelRow = new Adw.SwitchRow({
      title: "Adapt Text Colour",
      subtitle: "Light text over dark wallpapers, dark text over light ones",
    });
    this._settings.bind(
      "adaptive-panel-color",
      panelRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    panelGroup.add(panelRow);
    page.add(panelGroup);

    const shortcutsGroup = new Adw.PreferencesGroup({
      title: "Keyboard Shortcuts",
      description: "Available in the wallpaper grid",
    });
    const shortcuts = [
      { key: "M", desc: "Cycle Navigation" },
      { key: "S", desc: "Focus Search" },
      { key: "W", desc: "Jump to Active" },
      { key: "F", desc: "Toggle Favorite" },
      { key: "O", desc: "Open Folder" },
      { key: "D", desc: "Move File to Trash" },
    ];

    for (const s of shortcuts) {
      const row = new Adw.ActionRow({ title: s.desc });
      const kbd = new Gtk.Label({
        label: s.key,
        css_classes: ["dim-label"],
        valign: Gtk.Align.CENTER,
        margin_start: 8,
        margin_end: 8,
      });
      const kbdBox = new Gtk.Box({
        css_classes: ["card"],
        margin_top: 6,
        margin_bottom: 6,
      });
      kbdBox.append(kbd);
      row.add_suffix(kbdBox);
      shortcutsGroup.add(row);
    }
    page.add(shortcutsGroup);
    return page;
  },

  _buildStoragePage() {
    const page = new Adw.PreferencesPage({
      title: "Storage",
      icon_name: "drive-harddisk-symbolic",
    });
    this._storagePage = page;
    const cacheGroup = new Adw.PreferencesGroup({
      title: "Thumbnail Cache",
      description: "Frees disk space; slows next launch.",
    });
    this._cacheRow = new Adw.ActionRow({ title: "Calculating statistics…" });

    const spinner = new Gtk.Spinner({
      visible: false,
      valign: Gtk.Align.CENTER,
    });
    const clearBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.CENTER,
    });
    clearBox.append(spinner);
    clearBox.append(new Gtk.Label({ label: "Clear Cache" }));

    const clearBtn = new Gtk.Button({
      css_classes: ["destructive-action"],
      valign: Gtk.Align.CENTER,
    });
    clearBtn.set_child(clearBox);
    clearBtn.connect("clicked", () => {
      clearBtn.set_sensitive(false);
      spinner.set_visible(true);
      spinner.start();
      clearCacheAsync(this._settings.get_strv("wall-dirs"), () => {
        this._updateCacheLabel();
        clearBtn.set_sensitive(true);
        spinner.stop();
        spinner.set_visible(false);
      });
    });

    this._cacheRow.add_suffix(clearBtn);
    cacheGroup.add(this._cacheRow);
    page.add(cacheGroup);
    this._updateCacheLabel();
    return page;
  },

  _updateCacheLabel() {
    if (!this._window || !this._cacheRow) return;
    getCacheInfoAsync(this._settings.get_strv("wall-dirs"), ({ totalSize, count }) => {
      if (!this._window || !this._cacheRow) return;
      try {
        this._cacheRow.set_title(
          `${(totalSize / 1_048_576).toFixed(1)} MB used`,
        );
        this._cacheRow.set_subtitle(`${count} thumbnails cached`);
      } catch (_) {
        this._cacheRow.set_title("0.0 MB used");
      }
    });
  },
};

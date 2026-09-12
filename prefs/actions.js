// SPDX-License-Identifier: GPL-3.0-or-later
//
// Per-wallpaper actions: applying, shuffling, favourites, context menu, trash.
//
// Mixed into WallpickerPreferences by prefs.js. Every method here runs with
// `this` bound to that instance, exactly as if it were declared in the class.

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import {
  logError,
  isFavorite,
  toggleFavorite,
  composeSpannedAsync,
  setWallpaper,
} from "../utils.js";
import { SORT_MODES } from "./gallery.js";


export const actionMethods = {
  _monitors() {
    const out = [];
    const list = this._window?.get_display()?.get_monitors();
    if (!list) return out;
    for (let i = 0; i < list.get_n_items(); i++) {
      const m = list.get_item(i);
      const g = m.get_geometry();
      out.push({
        connector: m.get_connector() ?? `monitor-${i}`,
        label: m.get_connector() ?? `Monitor ${i + 1}`,
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
      });
    }
    return out;
  },

  _monitorAssignments() {
    try {
      return this._settings.get_value("monitor-wallpapers").deep_unpack();
    } catch (_) {
      return {};
    }
  },

  _saveMonitorAssignments(map) {
    this._settings.set_value(
      "monitor-wallpapers",
      new GLib.Variant("a{ss}", map),
    );
  },

  /**
   * Assigns one wallpaper to one monitor. GNOME stores a single background,
   * so every monitor's choice is painted into one wide image and set as a
   * spanned wallpaper.
   */
  async _applyToMonitor(child, connector) {
    const path = this._paths.get(child);
    if (!path) return;
    try {
      const assignments = this._monitorAssignments();
      assignments[connector] = path;
      const composed = await composeSpannedAsync(
        this._monitors(),
        assignments,
        this._current,
      );
      this._saveMonitorAssignments(assignments);
      await setWallpaper(composed, "spanned");
    } catch (e) {
      logError("per-monitor apply failed", e);
    }
  },

  _applyWallpaper(child) {
    const path = this._paths.get(child);
    if (!path) return;
    // A single wallpaper replaces any per-monitor arrangement.
    if (Object.keys(this._monitorAssignments()).length)
      this._saveMonitorAssignments({});
    setWallpaper(path, this._settings.get_string("picture-mode")).catch((e) =>
      logError("apply error", e),
    );

    if (this._activeChild) {
      this._activeChild.get_child()?.remove_css_class("active");
      this._starWidgets.get(this._activeChild)?.meta.set_visible(false);
    }

    this._activeChild = child;
    this._current = path;
    child.get_child()?.add_css_class("active");
    this._starWidgets.get(child)?.meta.set_visible(true);
  },

  _onShuffle() {
    const visible = [];
    let c = this._flowBox.get_first_child();
    while (c) {
      if (c.get_child_visible()) visible.push(c);
      c = c.get_next_sibling();
    }
    if (!visible.length) return;
    const choice = visible[Math.floor(Math.random() * visible.length)];
    this._applyWallpaper(choice);
    this._flowBox.select_child(choice);
    choice.grab_focus();
  },

  _toggleFavorite(child) {
    const path = this._paths.get(child);
    if (!path) return;
    this._starWidgets.get(child)?.star.set_visible(toggleFavorite(path));
    if (SORT_MODES[this._sortDrop.get_selected()] === "Starred")
      this._loadImages("Starred");
  },

  _showContextMenu(child) {
    if (this._ctxPopover) {
      this._ctxPopover.popdown();
      this._ctxPopover.unparent();
      this._ctxPopover = null;
    }
    const path = this._paths.get(child);
    if (!path) return;
    const isFav = isFavorite(path);

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      margin_top: 4,
      margin_bottom: 4,
      margin_start: 4,
      margin_end: 4,
    });

    const monitors = this._monitors();
    const items = [
      { label: "Set as Wallpaper", cb: () => this._applyWallpaper(child) },
      ...(monitors.length > 1
        ? monitors.map((m) => ({
            label: `Set on ${m.label}`,
            cb: () =>
              this._applyToMonitor(child, m.connector).catch((e) =>
                logError("per-monitor apply failed", e),
              ),
          }))
        : []),
      {
        label: isFav ? "Remove Favorite (F)" : "Add Favorite (F)",
        icon: isFav ? "starred-symbolic" : "non-starred-symbolic",
        cb: () => this._toggleFavorite(child),
      },
      {
        label: "Reveal in Files (O)",
        cb: () =>
          Gio.AppInfo.launch_default_for_uri(
            Gio.File.new_for_path(GLib.path_get_dirname(path)).get_uri(),
            null,
          ),
      },
      {
        label: "Move to Trash (D)",
        destructive: true,
        cb: () => this._confirmDelete(child, path),
      },
    ];

    for (const item of items) {
      const btn = new Gtk.Button({
        hexpand: true,
        halign: Gtk.Align.FILL,
        css_classes: ["flat"],
      });
      const label = item.icon
        ? new Adw.ButtonContent({ icon_name: item.icon, label: item.label })
        : new Gtk.Label({ label: item.label, xalign: 0 });
      label.set_margin_start(12);
      label.set_margin_end(12);
      label.set_margin_top(6);
      label.set_margin_bottom(6);
      label.set_halign(Gtk.Align.START);

      if (item.destructive) {
        btn.add_css_class("wp-delete-button");
        label.add_css_class("wp-delete-label");
      }

      btn.set_child(label);
      btn.connect("clicked", () => {
        this._ctxPopover?.popdown();
        item.cb();
      });
      box.append(btn);
    }

    this._ctxPopover = new Gtk.Popover({ child: box });
    this._ctxPopover.set_parent(child);
    this._ctxPopover.popup();
  },

  _confirmDelete(child, path) {
    const fname = GLib.path_get_basename(path);
    const dialog = new Adw.AlertDialog({
      heading: "Move Wallpaper to Trash?",
      body: `"${fname}" will be moved to the Trash.`,
    });
    dialog.add_response("cancel", "Cancel");
    dialog.add_response("delete", "Move to Trash");
    dialog.set_response_appearance(
      "delete",
      Adw.ResponseAppearance.DESTRUCTIVE,
    );

    dialog.connect("response", async (_d, response) => {
      if (response !== "delete") return;

      try {
        const file = Gio.File.new_for_path(path);
        await new Promise((resolve, reject) => {
          file.trash_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
              resolve(f.trash_finish(res));
            } catch (e) {
              reject(e);
            }
          });
        });

        if (isFavorite(path)) toggleFavorite(path);
        if (this._activeChild === child) {
          this._activeChild = null;
          this._current = "";
        }

        this._flowBox.remove(child);
        this._paths.delete(child);
        this._names.delete(child);
        this._starWidgets.delete(child);
        this._updateScrollbar();
        if (!this._flowBox.get_first_child()) this._showGridState("empty");
      } catch (e) {
        logError("Trash error", e);
      }
    });

    dialog.present(this._window);
  },
};

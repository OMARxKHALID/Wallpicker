// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { galleryMethods } from "./prefs/gallery.js";
import { actionMethods } from "./prefs/actions.js";
import { pageMethods } from "./prefs/pages.js";

import {
  initUtils,
  initModuleAsync,
  logDebug,
  logError,
  getCurrentWallpaper,
  flushStats,
} from "./utils.js";

const SORT_MODES = ["A-Z", "Starred", "Newest", "Most Used", "Recent"];

// Extensions that blur or dim the lock screen and therefore hide a synced
// wallpaper. Keyed by UUID so the warning can name the actual culprit.
const BLUR_EXTENSIONS = {
  "blur-my-shell@aunetx": "Blur my Shell",
  "blyr@yozoon.dev.gmail.com": "Blyr",
  "lockscreen-extension@pratap.fastmail.fm": "Lock Screen Background",
};
const DEFAULT_SORT_IDX = 3;

/**
 * The CSS provides high-performance transitions and hover effects using
 * standard GTK4 CSS selectors. Box-shadows and transforms are offloaded
 * to the GPU by the GSK renderer.
 */
const CARD_CSS = `
  .wp-card {
    border-radius: 12px;
    border: 2px solid transparent;
    padding: 2px;
    transition: all 250ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  }
  .wp-card:hover {
    border-color: @accent_bg_color;
    transform: scale(1.02);
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  }
  .wp-card.active {
    border: 2px solid @accent_bg_color;
    background-color: alpha(black, 0.3);
    box-shadow: 0 0 0 2px alpha(@accent_bg_color, 0.3);
  }
  flowboxchild {
    transition: all 200ms ease;
  }
  flowboxchild:focus, flowboxchild:active { outline: none; }
  flowboxchild:focus .wp-card {
    border: 2px dashed @accent_bg_color;
    transform: scale(1.02);
  }
  .wp-card .wp-name {
    font-size: 10px;
    font-weight: 800;
    padding: 8px 12px;
    color: white;
    background-color: alpha(black, 0.3);
    border-radius: 0 0 10px 10px;
    margin: 0 -2px -2px -2px;
  }
  .wp-star  { font-size: 16px; color: #f5c211; padding: 4px 6px; }
  .wp-meta  {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 6px;
    background-color: alpha(black, 0.3);
    color: white;
    font-weight: bold;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
  }
  .wp-empty-icon  { font-size: 64px; opacity: 0.3; margin-bottom: 16px; }
  .wp-empty-title { font-size: 18px; font-weight: 800; margin-bottom: 6px; }
  .wp-delete-label {
    color: @error_bg_color;
    font-weight: 600;
  }
  .wp-delete-button:hover {
    background-color: alpha(@error_bg_color, 0.15);
  }
  .hide-scrollbar scrollbar {
    opacity: 0;
    margin: 0;
    padding: 0;
  }
`;

/**
 * WallpickerPreferences:
 *
 * Implements a high-performance wallpaper gallery using GTK4.
 * This runs in a separate process from the Shell to ensure
 * main-thread responsiveness.
 */
export default class WallpickerPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CARD_CSS);
    Gtk.StyleContext.add_provider_for_display(
      window.get_display(),
      provider,
      Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    this._settings = this.getSettings();
    initUtils(this._settings);
    this._window = window;
    this._paths = new Map();
    this._names = new Map();
    this._starWidgets = new Map();
    this._activeChild = null;
    this._current = "";
    this._pending = [];
    this._loadIdleId = null;
    this._searchTid = null;
    this._limitTid = null;
    this._focusIdleId = null;
    this._queryCache = "";
    this._activeSigId = null;
    this._ctxPopover = null;

    window.set_default_size(720, 720);
    window.set_modal(true);

    this._pages = [
      this._buildWallpapersPage(),
      this._buildFoldersPage(),
      this._buildDisplayPage(),
      this._buildStoragePage(),
    ];
    this._pages.forEach((p) => window.add(p));

    // Recount the cache whenever the Storage page is opened; thumbnails are
    // written after the page was first built.
    window.connect("notify::visible-page", () => {
      if (this._window?.visible_page === this._storagePage)
        this._updateCacheLabel();
    });

    window.connect("close-request", () => {
      this._clearTimers();
      this._clearInitTimers();
      this._disconnectActiveSig();
      this._ctxPopover?.unparent();
      this._ctxPopover = null;
      flushStats();
      // Releasing the window is what tells pending async work to stop; every
      // deferred callback below checks for it before touching a widget.
      this._window = null;
      return false;
    });

    this._initIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._initIdleId = null;
      this._fixPageScroll(this._wallpapersPage);
      this._moveNavToBottom(window);
      return GLib.SOURCE_REMOVE;
    });

    /**
     * Handles initial focus alignment. Adw.PreferencesWindow
     * often resets focus internally on present, so we hook
     * 'is-active' to ensure our grid receives the focus token.
     */
    this._activeSigId = window.connect("notify::is-active", () => {
      if (!window.is_active()) return;
      this._disconnectActiveSig();
      this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._focusIdleId = null;
        this._focusGrid();
        return GLib.SOURCE_REMOVE;
      });
    });

    const winKeyCtrl = new Gtk.EventControllerKey();
    winKeyCtrl.connect("key-pressed", (_c, keyval) => {
      if (this._window.get_focus() === this._searchEntry) return false;

      if (
        keyval === Gdk.KEY_q ||
        keyval === Gdk.KEY_Q ||
        keyval === Gdk.KEY_Escape
      ) {
        this._window.close();
        return true;
      }
      if (keyval === Gdk.KEY_m || keyval === Gdk.KEY_M) {
        this._cyclePages();
        return true;
      }
      return false;
    });
    window.add_controller(winKeyCtrl);


    initModuleAsync()
      .then(() => {
        if (!this._window) return;
        this._current = getCurrentWallpaper();
        this._loadImages();
      })
      .catch((e) => logError("Prefs init failed", e));
  }

  _cyclePages() {
    if (!this._window || !this._pages) return;
    const current = this._window.visible_page;
    const idx = this._pages.indexOf(current);
    const nextIdx = (idx + 1) % this._pages.length;
    const nextPage = this._pages[nextIdx];

    this._window.visible_page = nextPage;

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (this._window) nextPage.grab_focus();
      return GLib.SOURCE_REMOVE;
    });
  }

  _focusGrid() {
    if (!this._window) return;
    const target =
      this._activeChild ?? this._flowBox.get_first_child() ?? this._flowBox;
    if (target instanceof Gtk.FlowBoxChild) this._flowBox.select_child(target);
    this._window.set_focus(target);
  }

  _disconnectActiveSig() {
    if (this._activeSigId !== null) {
      this._window?.disconnect(this._activeSigId);
      this._activeSigId = null;
    }
  }

  /**
   * Disables default vertical compression behaviors in Libadwaita
   * to ensure the FlowBox grid scales naturally.
   */
  _fixPageScroll(page) {
    function find(widget, type) {
      if (!widget) return null;
      if (widget instanceof type) return widget;
      let c = widget.get_first_child();
      while (c) {
        const r = find(c, type);
        if (r) return r;
        c = c.get_next_sibling();
      }
      return null;
    }
    const sw = find(page, Gtk.ScrolledWindow);
    if (sw) {
      sw.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER);
      sw.vexpand = true;
    }
    const cl = find(page, Adw.Clamp);
    if (cl) {
      cl.vexpand = true;
      cl.maximum_size = 850;
    }
  }

  /**
   * Translocates the navigation switcher from the header bar to
   * a revealed ViewSwitcherBar at the bottom.
   */
  _moveNavToBottom(window) {
    try {
      function find(widget, typeName) {
        if (!widget) return null;
        if (widget.constructor?.name === typeName) return widget;
        let c = widget.get_first_child();
        while (c) {
          const r = find(c, typeName);
          if (r) return r;
          c = c.get_next_sibling();
        }
        return null;
      }

      const topSwitcher = find(window, "AdwViewSwitcherTitle");
      if (topSwitcher) topSwitcher.set_visible(false);

      const bottomBar = find(window, "AdwViewSwitcherBar");
      if (bottomBar) bottomBar.set_reveal(true);
    } catch (e) {
      logDebug(`_moveNavToBottom: ${e.message}`);
    }
  }

  /** Load-scoped timers only. Called on every reload, so nothing that sets
   *  up the window may live here. */

  _clearTimers() {
    [this._loadIdleId, this._searchTid, this._limitTid].forEach((id) => {
      if (id) GLib.Source.remove(id);
    });
    this._loadIdleId = this._searchTid = this._limitTid = null;
  }

  _clearInitTimers() {
    for (const id of [this._initIdleId, this._focusIdleId]) {
      if (id) GLib.Source.remove(id);
    }
    this._initIdleId = this._focusIdleId = null;
  }
}

// The rest of the window lives under ./prefs/ so no single file carries all
// of it. These are plain prototype members, identical to declaring them in
// the class body above.
Object.assign(
  WallpickerPreferences.prototype,
  galleryMethods,
  actionMethods,
  pageMethods,
);

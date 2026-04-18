// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import GdkPixbuf from "gi://GdkPixbuf";
import Pango from "gi://Pango";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
  initUtils,
  initModuleAsync,
  logDebug,
  logError,
  loadFavorites,
  saveFavorites,
  getCurrentWallpaper,
  setWallpaper,
  getImagesAsync,
  getImageInfo,
  getThumbnailAsync,
  getCacheInfoAsync,
  clearCacheAsync,
  makeDisplayName,
  shortenPath,
  fuzzyMatch,
  flushStats,
  DEFAULT_WALL_DIR,
  THUMB_W,
  THUMB_H,
  SEARCH_DEBOUNCE_MS,
  PICTURE_MODES,
  PICTURE_MODE_LABELS,
  PICTURE_MODE_REVERSE,
} from "./utils.js";

const SCHEMA_ID = "org.gnome.shell.extensions.wallpicker";
const SORT_MODES = ["A-Z", "Starred", "Newest", "Most Used", "Recent"];
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
  /**
   * Loads settings bypassing the Shell's cached metadata.
   * This is required for robustness during developer installs.
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
    if (!schemaObj)
      throw new Error(
        `Schema ${SCHEMA_ID} not found in ${schemaDir.get_path()}`,
      );
    return new Gio.Settings({ settings_schema: schemaObj });
  }

  fillPreferencesWindow(window) {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CARD_CSS);
    Gtk.StyleContext.add_provider_for_display(
      window.get_display(),
      provider,
      Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    this._settings = this._loadSettings();
    initUtils(this._settings);
    this._isClosed = false;
    this._favorites = new Set();
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

    window.connect("close-request", () => {
      this._isClosed = true;
      this._clearTimers();
      this._disconnectActiveSig();
      flushStats();
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
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
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
        if (this._isClosed) return;
        this._favorites = loadFavorites();
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
      nextPage.grab_focus();
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

  _clearTimers() {
    [
      this._loadIdleId,
      this._searchTid,
      this._limitTid,
      this._initIdleId,
      this._sortIdleId,
    ].forEach((id) => {
      if (id) GLib.Source.remove(id);
    });
    this._loadIdleId = this._searchTid = this._limitTid = this._initIdleId = this._sortIdleId = null;
  }

  _buildWallpapersPage() {
    this._wallpapersPage = new Adw.PreferencesPage({
      title: "Wallpapers",
      icon_name: "emblem-photos-symbolic",
    });

    const controlsGroup = new Adw.PreferencesGroup();

    const controlsBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      halign: Gtk.Align.CENTER,
    });

    this._searchEntry = new Gtk.SearchEntry({
      width_request: 300,
      placeholder_text: "Filter wallpapers… (S)",
    });
    this._searchEntry.connect("search-changed", () => this._onSearchChanged());
    this._searchEntry.connect("activate", () => this._focusGrid());
    controlsBox.append(this._searchEntry);

    this._sortDrop = new Gtk.DropDown({
      model: new Gtk.StringList({ strings: SORT_MODES }),
      selected: DEFAULT_SORT_IDX,
      width_request: 140,
    });
    this._sortIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._sortIdleId = null;
      this._sortDrop.connect("notify::selected", () =>
        this._loadImages(SORT_MODES[this._sortDrop.get_selected()]),
      );
      return GLib.SOURCE_REMOVE;
    });
    controlsBox.append(this._sortDrop);

    const shuffleBtn = new Gtk.Button({
      icon_name: "media-playlist-shuffle-symbolic",
      tooltip_text: "Shuffle",
      valign: Gtk.Align.CENTER,
    });
    shuffleBtn.connect("clicked", () => this._onShuffle());
    controlsBox.append(shuffleBtn);

    controlsGroup.add(controlsBox);
    this._wallpapersPage.add(controlsGroup);

    this._flowBox = new Gtk.FlowBox({
      valign: Gtk.Align.START,
      halign: Gtk.Align.CENTER,
      max_children_per_line: 3,
      min_children_per_line: 3,
      homogeneous: true,
      selection_mode: Gtk.SelectionMode.SINGLE,
      activate_on_single_click: true,
      focusable: true,
    });
    this._flowBox.set_filter_func((child) => this._filterFunc(child));
    this._flowBox.connect("child-activated", (_fb, child) =>
      this._applyWallpaper(child),
    );
    this._flowBox.connect("keynav-failed", () => false);

    const keyCtrl = new Gtk.EventControllerKey();
    keyCtrl.connect("key-pressed", (_c, keyval) => {
      if (keyval === Gdk.KEY_s || keyval === Gdk.KEY_S) {
        this._searchEntry.grab_focus();
        return true;
      }
      if (keyval === Gdk.KEY_w || keyval === Gdk.KEY_W) {
        if (this._activeChild) {
          this._activeChild.grab_focus();
          return true;
        }
      }

      const focused = this._flowBox.get_focus_child();
      if (!focused) return false;

      if (keyval === Gdk.KEY_f || keyval === Gdk.KEY_F) {
        this._toggleFavorite(focused);
        return true;
      }
      if (keyval === Gdk.KEY_o || keyval === Gdk.KEY_O) {
        const path = this._paths.get(focused);
        if (path) {
          Gio.AppInfo.launch_default_for_uri(
            Gio.File.new_for_path(GLib.path_get_dirname(path)).get_uri(),
            null,
          );
        }
        return true;
      }
      if (keyval === Gdk.KEY_d || keyval === Gdk.KEY_D) {
        const path = this._paths.get(focused);
        if (path) this._confirmDelete(focused, path);
        return true;
      }
      return false;
    });
    this._flowBox.add_controller(keyCtrl);

    this._gridScroll = new Gtk.ScrolledWindow({
      vexpand: true,
      propagate_natural_height: true,
      vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
    });
    this._gridScroll.set_child(this._flowBox);
    this._flowBox.set_hadjustment(this._gridScroll.get_hadjustment());
    this._flowBox.set_vadjustment(this._gridScroll.get_vadjustment());
    const vp = this._gridScroll.get_child();
    if (vp instanceof Gtk.Viewport) vp.set_scroll_to_focus(true);

    this._emptyBox = this._makeEmptyBox(
      "🖼️",
      "No Wallpapers",
      "Select a folder to get started",
    );
    this._emptyTitle = this._emptyBox.emptyTitle;
    this._emptySub = this._emptyBox.emptySub;
    this._emptyBox.set_visible(false);
    this._noResultsBox = this._makeEmptyBox(
      "🔍",
      "No Matches",
      "Try a different search term",
    );
    this._noResultsBox.set_visible(false);

    const outerBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      vexpand: true,
    });
    outerBox.append(this._gridScroll);
    outerBox.append(this._emptyBox);
    outerBox.append(this._noResultsBox);

    const gridGroup = new Adw.PreferencesGroup();
    gridGroup.add(outerBox);
    this._wallpapersPage.add(gridGroup);

    return this._wallpapersPage;
  }

  _showGridState(state) {
    this._gridScroll.set_visible(state === "grid");
    this._emptyBox.set_visible(state === "empty");
    this._noResultsBox.set_visible(state === "no-results");
  }

  _makeEmptyBox(icon, title, sub) {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      valign: Gtk.Align.CENTER,
      halign: Gtk.Align.CENTER,
      vexpand: true,
      spacing: 4,
    });
    box.set_size_request(-1, 3 * 155);
    const il = new Gtk.Label({ label: icon });
    il.add_css_class("wp-empty-icon");
    const tl = new Gtk.Label({ label: title });
    tl.add_css_class("wp-empty-title");
    const sl = new Gtk.Label({ label: sub });
    sl.add_css_class("wp-empty-sub");
    box.append(il);
    box.append(tl);
    box.append(sl);
    box.emptyTitle = tl;
    box.emptySub = sl;
    return box;
  }

  _loadImages(sortMode) {
    this._clearTimers();

    let child;
    while ((child = this._flowBox.get_first_child()))
      this._flowBox.remove(child);
    this._paths.clear();
    this._names.clear();
    this._starWidgets.clear();
    this._activeChild = null;

    const dirs = this._settings.get_strv("wall-dirs");
    if (dirs.length === 0) dirs.push(DEFAULT_WALL_DIR);
    const maxImages = this._settings.get_int("max-images");
    const mode =
      sortMode ??
      SORT_MODES[this._sortDrop?.get_selected() ?? DEFAULT_SORT_IDX];

    getImagesAsync(dirs, mode, maxImages, (allPaths) => {
      if (this._current) {
        const idx = allPaths.indexOf(this._current);
        if (idx > 0) {
          allPaths.splice(idx, 1);
          allPaths.unshift(this._current);
        }
      }

      this._pending = allPaths;

      if (!allPaths.length) {
        if (!dirs.length) {
          this._emptyTitle.set_label("No Folders Added");
          this._emptySub.set_label(
            "Go to the Folders page to add wallpaper directories",
          );
        } else if (mode === "Starred") {
          this._emptyTitle.set_label("No Favorites Yet");
          this._emptySub.set_label("Star wallpapers to see them here");
        } else {
          this._emptyTitle.set_label("No Wallpapers Found");
          this._emptySub.set_label(`No images in selected folders`);
        }
        this._showGridState("empty");
        return;
      }

      this._showGridState("grid");
      this._gridScroll.add_css_class("hide-scrollbar");
      this._loadIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._loadNext().catch((e) =>
          logError("_loadNext error", e),
        );
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  /**
   * Batches image rendering using idle callbacks to maintain
   * 60FPS UI responsiveness during heavy loading.
   */
  async _loadNext() {
    const batchSize = 12;
    let activeMetaToLoad = null;

    for (let i = 0; i < batchSize; i++) {
      if (!this._pending.length) {
        this._loadIdleId = null;
        if (this._activeSigId === null) {
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusGrid();
            return GLib.SOURCE_REMOVE;
          });
        }
        break;
      }

      const path = this._pending.shift();
      try {
        const thumbPath = await getThumbnailAsync(path);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(thumbPath);
        const texture = Gdk.Texture.new_for_pixbuf(pixbuf);
        const fname = GLib.path_get_basename(path);
        const displayName = makeDisplayName(fname);
        const isFav = this._favorites.has(fname);

        const cardBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        cardBox.add_css_class("wp-card");

        const overlay = new Gtk.Overlay();
        const picture = Gtk.Picture.new_for_paintable(texture);
        picture.set_size_request(THUMB_W, THUMB_H);
        picture.set_content_fit(Gtk.ContentFit.COVER);
        overlay.set_child(picture);

        const star = new Gtk.Label({ label: "★" });
        star.add_css_class("wp-star");
        star.set_halign(Gtk.Align.START);
        star.set_valign(Gtk.Align.START);
        star.set_visible(isFav);
        overlay.add_overlay(star);

        const meta = new Gtk.Label({ label: "" });
        meta.add_css_class("wp-meta");
        meta.set_halign(Gtk.Align.END);
        meta.set_valign(Gtk.Align.END);
        meta.set_visible(false);
        overlay.add_overlay(meta);

        cardBox.append(overlay);

        const nameLabel = new Gtk.Label({ label: displayName });
        nameLabel.add_css_class("wp-name");
        nameLabel.set_ellipsize(Pango.EllipsizeMode.END);
        cardBox.append(nameLabel);

        const fbChild = new Gtk.FlowBoxChild({ focusable: true });
        fbChild.set_child(cardBox);
        fbChild.set_tooltip_text(displayName);

        let infoLoaded = false;
        const hoverCtrl = new Gtk.EventControllerMotion();
        hoverCtrl.connect("enter", async () => {
          if (infoLoaded) return;
          infoLoaded = true;
          const info = await getImageInfo(path);
          meta.set_label(info);
          fbChild.set_tooltip_text(isFav ? `★ ${info}` : info);
        });
        fbChild.add_controller(hoverCtrl);

        const gesture = new Gtk.GestureClick({ button: 3 });
        gesture.connect("pressed", () => this._showContextMenu(fbChild));
        fbChild.add_controller(gesture);

        this._paths.set(fbChild, path);
        this._names.set(fbChild, displayName.toLowerCase());
        this._starWidgets.set(fbChild, { star, meta });
        this._flowBox.append(fbChild);

        if (path === this._current) {
          this._activeChild = fbChild;
          cardBox.add_css_class("active");
          activeMetaToLoad = {
            meta,
            path,
            fbChild,
            isFav,
            setLoaded: () => {
              infoLoaded = true;
            },
          };
        }
      } catch (e) {
        logDebug(`_loadNext skip: ${e.message}`);
      }
    }

    if (activeMetaToLoad) {
      const { meta, path, fbChild, isFav, setLoaded } = activeMetaToLoad;
      const info = await getImageInfo(path);
      meta.set_label(info);
      meta.set_visible(true);
      fbChild.set_tooltip_text(isFav ? `★ ${info}` : info);
      setLoaded();
    }

    if (this._pending.length > 0) {
      this._loadIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._loadNext().catch((e) =>
          logError("_loadNext chain error", e),
        );
        return GLib.SOURCE_REMOVE;
      });
    } else {
      this._loadIdleId = null;
      this._updateScrollbar();
    }
  }

  _updateScrollbar() {
    let count = 0;
    let c = this._flowBox.get_first_child();
    while (c) {
      if (c.get_child_visible()) count++;
      c = c.get_next_sibling();
    }
    if (count > 12) this._gridScroll.remove_css_class("hide-scrollbar");
    else this._gridScroll.add_css_class("hide-scrollbar");
  }

  _applyWallpaper(child) {
    const path = this._paths.get(child);
    if (!path) return;
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
  }

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
  }

  _toggleFavorite(child) {
    const path = this._paths.get(child);
    if (!path) return;
    const fname = GLib.path_get_basename(path);
    const w = this._starWidgets.get(child);
    if (this._favorites.has(fname)) {
      this._favorites.delete(fname);
      w?.star.set_visible(false);
    } else {
      this._favorites.add(fname);
      w?.star.set_visible(true);
    }
    saveFavorites(this._favorites);
    if (SORT_MODES[this._sortDrop.get_selected()] === "Starred")
      this._loadImages("Starred");
  }

  _showContextMenu(child) {
    if (this._ctxPopover) {
      this._ctxPopover.unparent();
    }
    const path = this._paths.get(child);
    if (!path) return;
    const fname = GLib.path_get_basename(path);
    const isFav = this._favorites.has(fname);

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      margin_top: 4,
      margin_bottom: 4,
      margin_start: 4,
      margin_end: 4,
    });

    const items = [
      { label: "Set as Wallpaper", cb: () => this._applyWallpaper(child) },
      {
        label: isFav ? "★ Remove Favorite (F)" : "☆ Add Favorite (F)",
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
        label: "Delete (D)",
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
      const label = new Gtk.Label({
        label: item.label,
        xalign: 0,
        margin_start: 12,
        margin_end: 12,
        margin_top: 6,
        margin_bottom: 6,
      });

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
  }

  _confirmDelete(child, path) {
    const fname = GLib.path_get_basename(path);
    const dialog = new Adw.AlertDialog({
      heading: "Delete Wallpaper?",
      body: `"${fname}" will be permanently deleted.`,
    });
    dialog.add_response("cancel", "Cancel");
    dialog.add_response("delete", "Delete");
    dialog.set_response_appearance(
      "delete",
      Adw.ResponseAppearance.DESTRUCTIVE,
    );

    dialog.connect("response", async (_d, response) => {
      if (response !== "delete") return;

      try {
        const file = Gio.File.new_for_path(path);
        await new Promise((resolve, reject) => {
          file.delete_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
              resolve(f.delete_finish(res));
            } catch (e) {
              reject(e);
            }
          });
        });

        if (this._favorites.has(fname)) {
          this._favorites.delete(fname);
          saveFavorites(this._favorites);
        }
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
        logError("Delete error", e);
      }
    });

    dialog.present(this._window);
  }

  _onSearchChanged() {
    if (this._searchTid) {
      GLib.Source.remove(this._searchTid);
    }
    this._searchTid = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      SEARCH_DEBOUNCE_MS,
      () => {
        this._searchTid = null;
        this._queryCache = this._searchEntry.get_text().toLowerCase().trim();
        this._flowBox.invalidate_filter();

        if (!this._queryCache) {
          this._showGridState("grid");
          return GLib.SOURCE_REMOVE;
        }

        let hasVisible = false;
        let c = this._flowBox.get_first_child();
        while (c) {
          if (c.get_child_visible()) {
            hasVisible = true;
            break;
          }
          c = c.get_next_sibling();
        }
        this._showGridState(hasVisible ? "grid" : "no-results");
        this._updateScrollbar();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _filterFunc(child) {
    if (!this._queryCache) return true;
    return fuzzyMatch(this._queryCache, this._names.get(child) ?? "");
  }

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
  }

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
  }

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
  }

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

    const lockscreenGroup = new Adw.PreferencesGroup({
      title: "Lock Screen",
      description:
        "Sync desktop wallpaper to the lock screen. Note: If you want to see the wallpaper clearly, you must disable other extensions that blur the lock screen background, such as 'Blur My Shell'.",
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
      { key: "D", desc: "Delete File" },
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
  }

  _buildStoragePage() {
    const page = new Adw.PreferencesPage({
      title: "Storage",
      icon_name: "drive-harddisk-symbolic",
    });
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
      clearCacheAsync(() => {
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
  }

  _updateCacheLabel() {
    getCacheInfoAsync(({ totalSize, count }) => {
      try {
        this._cacheRow.set_title(
          `${(totalSize / 1_048_576).toFixed(1)} MB used`,
        );
        this._cacheRow.set_subtitle(`${count} thumbnails cached`);
      } catch (_) {
        this._cacheRow.set_title("0.0 MB used");
      }
    });
  }
}

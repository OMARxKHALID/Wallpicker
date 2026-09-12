// SPDX-License-Identifier: GPL-3.0-or-later
//
// Wallpaper grid: page construction, batched loading and scroll paging.
//
// Mixed into WallpickerPreferences by prefs.js. Every method here runs with
// `this` bound to that instance, exactly as if it were declared in the class.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import Pango from "gi://Pango";

import {
  logDebug,
  logError,
  isFavorite,
  getImagesAsync,
  getImageInfo,
  getThumbnailAsync,
  loadPixbufAsync,
  makeDisplayName,
  fuzzyMatch,
  DEFAULT_WALL_DIR,
  THUMB_W,
  THUMB_H,
  SEARCH_DEBOUNCE_MS,
} from "../utils.js";

export const SORT_MODES = ["A-Z", "Starred", "Newest", "Most Used", "Recent"];
export const DEFAULT_SORT_IDX = 3;

export const galleryMethods = {
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
    this._sortDrop.connect("notify::selected", () =>
      this._loadImages(SORT_MODES[this._sortDrop.get_selected()]),
    );
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
    // Loading pauses once the grid runs a screenful past the viewport and
    // resumes as the user approaches the end, so a large folder no longer
    // thumbnails every image before the window settles.
    this._gridScroll
      .get_vadjustment()
      .connect("value-changed", () => this._maybeResumeLoading());
    this._flowBox.set_hadjustment(this._gridScroll.get_hadjustment());
    this._flowBox.set_vadjustment(this._gridScroll.get_vadjustment());
    const vp = this._gridScroll.get_child();
    if (vp instanceof Gtk.Viewport) vp.set_scroll_to_focus(true);

    this._emptyBox = this._makeEmptyBox(
      "image-x-generic-symbolic",
      "No Wallpapers",
      "Select a folder to get started",
    );
    this._emptyTitle = this._emptyBox.emptyTitle;
    this._emptySub = this._emptyBox.emptySub;
    this._emptyBox.set_visible(false);
    this._noResultsBox = this._makeEmptyBox(
      "edit-find-symbolic",
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

  /** True once enough rows exist to fill the viewport with a screenful spare. */,

  _viewportSatisfied() {
    if (this._queryCache) return false;
    const adj = this._gridScroll.get_vadjustment();
    const page = adj.get_page_size();
    if (page <= 0) return false;
    return adj.get_upper() >= adj.get_value() + page * 2;
  },

  _maybeResumeLoading() {
    if (!this._window || this._loadIdleId || !this._pending?.length) return;
    if (this._viewportSatisfied()) return;
    this._loadIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._loadNext().catch((e) => logError("_loadNext resume error", e));
      return GLib.SOURCE_REMOVE;
    });
  },

  _showGridState(state) {
    this._gridScroll.set_visible(state === "grid");
    this._emptyBox.set_visible(state === "empty");
    this._noResultsBox.set_visible(state === "no-results");
  },

  _makeEmptyBox(icon, title, sub) {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      valign: Gtk.Align.CENTER,
      halign: Gtk.Align.CENTER,
      vexpand: true,
      spacing: 4,
    });
    box.set_size_request(-1, 3 * 155);
    const il = Gtk.Image.new_from_icon_name(icon);
    il.set_pixel_size(64);
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
  },

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
  },

  /**
   * Batches image rendering using idle callbacks to maintain
   * 60FPS UI responsiveness during heavy loading.
   */
  async _loadNext() {
    const batchSize = 12;
    let activeMetaToLoad = null;

    // Decode the batch concurrently. GdkPixbuf scales on worker threads, so
    // twelve in flight finish far sooner than twelve awaited one after another.
    const batch = this._pending.splice(0, batchSize);
    const decoded = await Promise.all(
      batch.map(async (p) => {
        try {
          const thumbPath = await getThumbnailAsync(p);
          return { path: p, pixbuf: await loadPixbufAsync(thumbPath) };
        } catch (e) {
          logDebug(`_loadNext skip: ${e.message}`);
          return null;
        }
      }),
    );
    if (!this._window) return;

    for (const entry of decoded) {
      if (!entry) continue;
      const { path, pixbuf } = entry;
      try {
        const texture = Gdk.Texture.new_for_pixbuf(pixbuf);
        const fname = GLib.path_get_basename(path);
        const displayName = makeDisplayName(fname);
        const isFav = isFavorite(path);

        const cardBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        cardBox.add_css_class("wp-card");

        const overlay = new Gtk.Overlay();
        const picture = Gtk.Picture.new_for_paintable(texture);
        picture.set_size_request(THUMB_W, THUMB_H);
        picture.set_content_fit(Gtk.ContentFit.COVER);
        overlay.set_child(picture);

        const star = Gtk.Image.new_from_icon_name("starred-symbolic");
        star.set_pixel_size(16);
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
          fbChild.set_tooltip_text(isFav ? `Favorite · ${info}` : info);
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
      fbChild.set_tooltip_text(isFav ? `Favorite · ${info}` : info);
      setLoaded();
    }

    if (this._pending.length > 0 && !this._viewportSatisfied()) {
      this._loadIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        this._loadNext().catch((e) =>
          logError("_loadNext chain error", e),
        );
        return GLib.SOURCE_REMOVE;
      });
    } else if (this._pending.length > 0) {
      // Paused. The scroll handler restarts this when the user nears the end.
      this._loadIdleId = null;
      this._updateScrollbar();
    } else {
      this._loadIdleId = null;
      this._updateScrollbar();
      // The cache figures were read before any of these thumbnails existed.
      this._updateCacheLabel();
      if (this._activeSigId === null) {
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          this._focusIdleId = null;
          this._focusGrid();
          return GLib.SOURCE_REMOVE;
        });
      }
    }
  },

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

  /** Monitor geometry in the layout GNOME uses, left to right. */,

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
        // A search has to look at the whole folder, not only the rows that
        // happen to have been loaded so far.
        if (this._queryCache) this._maybeResumeLoading();
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
  },

  _filterFunc(child) {
    if (!this._queryCache) return true;
    return fuzzyMatch(this._queryCache, this._names.get(child) ?? "");
  },
};

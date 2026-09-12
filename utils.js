// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";

const APP_NAME = "wallpicker";

const DATA_DIR = GLib.build_filenamev([
  GLib.get_user_data_dir(),
  APP_NAME,
]);
const STATS_FILE = GLib.build_filenamev([DATA_DIR, "stats.json"]);
const FAVORITES_FILE = GLib.build_filenamev([
  DATA_DIR,
  "favorites.json",
]);
// Freedesktop thumbnail managing standard: $XDG_CACHE_HOME/thumbnails/<size>,
// named by the MD5 of the file URI, directories 0700 and files 0600.
const XDG_THUMB_ROOT = GLib.build_filenamev([
  GLib.get_user_cache_dir(),
  "thumbnails",
]);
export const THUMB_LARGE_DIR = GLib.build_filenamev([XDG_THUMB_ROOT, "large"]);
const THUMB_NORMAL_DIR = GLib.build_filenamev([XDG_THUMB_ROOT, "normal"]);
const THUMB_LARGE_MAX = 256;
const THUMB_SOFTWARE = "Wallpicker";

// Thumbnails written before the move to the shared cache.
const LEGACY_THUMB_DIR = GLib.build_filenamev([
  GLib.get_user_cache_dir(),
  APP_NAME,
  "thumbnails",
]);

export const THUMB_W = 190;
export const THUMB_H = 103;
export const SEARCH_DEBOUNCE_MS = 150;

const IMAGE_EXTS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif",
];

export const DEFAULT_WALL_DIR = GLib.build_filenamev([
  GLib.get_home_dir(),
  "Pictures",
  "Wallpapers",
]);

export const PICTURE_MODES = {
  Zoom: "zoom",
  Stretch: "stretched",
  Center: "centered",
  Tile: "wallpaper",
  Span: "spanned",
};
export const PICTURE_MODE_LABELS = Object.keys(PICTURE_MODES);
export const PICTURE_MODE_REVERSE = Object.fromEntries(
  Object.entries(PICTURE_MODES).map(([k, v]) => [v, k]),
);

/**
 * Global state for debouncing writes and caching statistics.
 */
let _statsCache = {};
let _favsCache = new Set();
let _saveTid = null;
const _backgroundSources = new Set();

let _settings = null;

export function initUtils(settings) {
  _settings = settings;
}

function _getDebugEnabled() {
  try {
    return _settings?.get_boolean("debug-logging") ?? false;
  } catch (_) {
    return false;
  }
}

export function logDebug(msg) {
  if (_getDebugEnabled()) console.debug(`[${APP_NAME}] ${msg}`);
}

export function logError(msg, err) {
  console.error(`[${APP_NAME}] ${msg}: ${err?.message || err}`);
}

function addBackgroundSource(id) {
  _backgroundSources.add(id);
  return id;
}

function removeBackgroundSource(id) {
  _backgroundSources.delete(id);
}

/**
 * resetModule:
 *
 * Resets shared state between extension enable/disable cycles.
 * Ensures the session is clean for re-initialization.
 */
export function resetModule() {
  if (_saveTid !== null) {
    GLib.Source.remove(_saveTid);
    _saveTid = null;
  }
  for (const id of _backgroundSources) {
    GLib.Source.remove(id);
  }
  _backgroundSources.clear();
  _statsCache = {};
  _favsCache = new Set();
}

/**
 * saveFileAsync:
 *
 * Manages asynchronous file writing with directory creation.
 * Returns a Promise for caller-level error handling.
 */
async function saveFileAsync(path, contents) {
  const file = Gio.File.new_for_path(path);
  const parent = file.get_parent();

  try {
    if (parent) GLib.mkdir_with_parents(parent.get_path(), 0o755);

    return new Promise((resolve, reject) => {
      file.replace_contents_async(
        contents,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (f, res) => {
          try {
            f.replace_contents_finish(res);
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  } catch (e) {
    logError("saveFileAsync failed", e);
    throw e;
  }
}

/**
 * recordUse:
 *
 * Updates the usage statistics for a wallpaper.
 * Persists changes via debounced write.
 */
export function recordUse(path) {
  const stats = loadStats();
  const legacy = GLib.path_get_basename(path);
  // Adopt any pre-existing basename entry, then key by full path from now on.
  const entry = stats[path] ?? stats[legacy] ?? {
    count: 0,
    last_used: 0.0,
    res: null,
    size: null,
    mtime: 0,
  };
  entry.count += 1;
  entry.last_used = GLib.get_real_time() / 1_000_000;
  stats[path] = entry;
  if (stats[legacy] && legacy !== path) delete stats[legacy];

  _saveStats();
}

function _normaliseStats(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "object" && v !== null) {
      out[k] = {
        count: v.count ?? 0,
        last_used: v.last_used ?? 0.0,
        res: v.res ?? null,
        size: v.size ?? null,
        mtime: v.mtime ?? 0,
      };
    } else {
      out[k] = {
        count: Number(v) || 0,
        last_used: 0.0,
        res: null,
        size: null,
        mtime: 0,
      };
    }
  }
  return out;
}

export function loadStats() {
  return _statsCache;
}

/**
 * statsFor:
 *
 * Reads a stats entry for a wallpaper. Entries are keyed by absolute path;
 * the basename lookup is a fallback for data written before that change.
 */
export function statsFor(stats, path) {
  return stats[path] ?? stats[GLib.path_get_basename(path)];
}

export function isFavorite(path) {
  return _favsCache.has(path) || _favsCache.has(GLib.path_get_basename(path));
}

/**
 * toggleFavorite:
 *
 * Flips the favourite flag for a wallpaper and persists it.
 * Returns the new state.
 */
export function toggleFavorite(path) {
  const legacy = GLib.path_get_basename(path);
  const on = isFavorite(path);
  _favsCache.delete(path);
  _favsCache.delete(legacy);
  if (!on) _favsCache.add(path);
  saveFavorites(_favsCache);
  return !on;
}

async function _loadStatsAsync() {
  const file = Gio.File.new_for_path(STATS_FILE);
  try {
    const [bytes] = await new Promise((resolve, reject) => {
      file.load_contents_async(null, (f, res) => {
        try {
          resolve(f.load_contents_finish(res));
        } catch (e) {
          reject(e);
        }
      });
    });
    // Merge: entries recorded before the load finished must win.
    const loaded = _normaliseStats(JSON.parse(new TextDecoder().decode(bytes)));
    _statsCache = { ...loaded, ..._statsCache };
  } catch (e) {
    logDebug(`loadStatsAsync: ${e.message}`);
  }
}

function _saveStats() {
  if (_saveTid) return;

  _saveTid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    _saveTid = null;
    saveFileAsync(
      STATS_FILE,
      new TextEncoder().encode(JSON.stringify(_statsCache)),
    ).catch((e) => logError("_saveStats error", e));
    return GLib.SOURCE_REMOVE;
  });
}

/**
 * Writes pending usage statistics synchronously.
 *
 * This blocks the calling loop, which is normally worth avoiding. It runs
 * only from disable() and from the preferences window closing, where an
 * asynchronous write would not finish before the process or the extension
 * goes away and the pending counts would be lost.
 */
export function flushStats() {
  if (!_saveTid) return;
  GLib.Source.remove(_saveTid);
  _saveTid = null;

  try {
    const file = Gio.File.new_for_path(STATS_FILE);
    const parent = file.get_parent();
    if (parent) GLib.mkdir_with_parents(parent.get_path(), 0o755);

    file.replace_contents(
      new TextEncoder().encode(JSON.stringify(_statsCache)),
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null,
    );
  } catch (e) {
    logError("flushStats error", e);
  }
}

async function _loadFavoritesAsync() {
  const file = Gio.File.new_for_path(FAVORITES_FILE);
  try {
    const [bytes] = await new Promise((resolve, reject) => {
      file.load_contents_async(null, (f, res) => {
        try {
          resolve(f.load_contents_finish(res));
        } catch (e) {
          reject(e);
        }
      });
    });
    for (const f of JSON.parse(new TextDecoder().decode(bytes)))
      _favsCache.add(f);
  } catch (e) {
    logDebug(`loadFavoritesAsync: ${e.message}`);
  }
}

export async function initModuleAsync() {
  await Promise.all([_loadStatsAsync(), _loadFavoritesAsync()]);
}

function saveFavorites(favSet) {
  _favsCache = favSet;
  saveFileAsync(
    FAVORITES_FILE,
    new TextEncoder().encode(JSON.stringify([...favSet])),
  ).catch((e) => logError("saveFavorites error", e));
}

function _bgSettings() {
  return new Gio.Settings({ schema_id: "org.gnome.desktop.background" });
}

function _colorScheme() {
  try {
    return new Gio.Settings({
      schema_id: "org.gnome.desktop.interface",
    }).get_string("color-scheme");
  } catch (_) {
    return "default";
  }
}

export function getCurrentWallpaper() {
  try {
    const s = _bgSettings();
    const key =
      _colorScheme() === "prefer-dark" ? "picture-uri-dark" : "picture-uri";
    const uri = s.get_string(key) || s.get_string("picture-uri");
    if (!uri) return "";
    const [path] = GLib.filename_from_uri(uri);
    return path ?? "";
  } catch (e) {
    logDebug(`getCurrentWallpaper log: ${e.message}`);
    return "";
  }
}

/**
 * Updates GSettings with the new wallpaper URI.
 * Handles both light and dark variants for modern GNOME compatibility.
 */
export async function setWallpaper(path, mode = "zoom") {
  try {
    const file = Gio.File.new_for_path(path);
    const s = _bgSettings();
    const uri = file.get_uri();
    s.set_string("picture-uri", uri);
    s.set_string("picture-uri-dark", uri);
    s.set_string("picture-options", mode);
    recordUse(path);
  } catch (e) {
    logError("setWallpaper error", e);
  }
}

/**
 * Recursive asynchronous directory scanner for images.
 * Uses a work queue and idle callbacks to remain non-blocking.
 */
export function getImagesAsync(
  wallDirs,
  sortMode = "Most Used",
  maxImages = 0,
  callback,
) {
  const allFiles = [];
  const seen = new Set();
  const visitedDirs = new Set();
  // ponytail: depth cap instead of symlink resolution. Bounds symlink loops
  // (a/link -> a) which canonicalize_filename cannot detect. Raise if someone
  // reports a legitimately deeper wallpaper tree.
  const MAX_DEPTH = 8;
  const queue = wallDirs.map((path) => ({ path, depth: 0 }));

  function processNextDir() {
    if (queue.length === 0) {
      finalize();
      return;
    }

    const { path: dir, depth } = queue.shift();
    const realDir = GLib.canonicalize_filename(dir, null) ?? dir;

    if (visitedDirs.has(realDir)) {
      processNextDir();
      return;
    }
    visitedDirs.add(realDir);

    try {
      const d = Gio.File.new_for_path(dir);
      d.enumerate_children_async(
        "standard::name,standard::type,time::modified,id::file",
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
        (source, res) => {
          let iter;
          try {
            iter = source.enumerate_children_finish(res);
          } catch (e) {
            logDebug(`enumerate error: ${e.message}`);
            processNextDir();
            return;
          }

          function nextBatch() {
            iter.next_files_async(
              50,
              GLib.PRIORITY_DEFAULT,
              null,
              (it, res2) => {
                try {
                  const files = it.next_files_finish(res2);
                  if (files.length === 0) {
                    it.close(null);
                    processNextDir();
                    return;
                  }

                  for (const info of files) {
                    const name = info.get_name();
                    const fileType = info.get_file_type();

                    if (fileType === Gio.FileType.DIRECTORY) {
                      if (depth < MAX_DEPTH) {
                        queue.push({
                          path: GLib.build_filenamev([dir, name]),
                          depth: depth + 1,
                        });
                      }
                      continue;
                    }

                    if (!IMAGE_EXTS.some((e) => name.toLowerCase().endsWith(e)))
                      continue;
                    const path = GLib.build_filenamev([dir, name]);
                    const key = info.get_attribute_string("id::file") ?? path;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const mtime =
                      info.get_modification_date_time()?.to_unix() ?? 0;
                    allFiles.push({ path, name, mtime });
                  }

                  const id = addBackgroundSource(
                    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                      removeBackgroundSource(id);
                      nextBatch();
                      return GLib.SOURCE_REMOVE;
                    }),
                  );
                } catch (e) {
                  logDebug(`batch error: ${e.message}`);
                  processNextDir();
                }
              },
            );
          }
          nextBatch();
        },
      );
    } catch (e) {
      logDebug(`processNextDir error: ${e.message}`);
      processNextDir();
    }
  }

  function finalize() {
    const lower = (f) => f.name.toLowerCase();
    let filtered = allFiles;

    if (sortMode === "Starred") {
      filtered = allFiles.filter((f) => isFavorite(f.path));
      filtered.sort((a, b) => lower(a).localeCompare(lower(b)));
    } else if (sortMode === "Newest") {
      filtered.sort((a, b) => b.mtime - a.mtime);
    } else if (sortMode === "Most Used") {
      const stats = loadStats();
      filtered.sort(
        (a, b) =>
          (statsFor(stats, b.path)?.count ?? 0) -
          (statsFor(stats, a.path)?.count ?? 0),
      );
    } else if (sortMode === "Recent") {
      const stats = loadStats();
      filtered.sort(
        (a, b) =>
          (statsFor(stats, b.path)?.last_used ?? 0) -
          (statsFor(stats, a.path)?.last_used ?? 0),
      );
    } else {
      filtered.sort((a, b) => lower(a).localeCompare(lower(b)));
    }

    const result = filtered.map((f) => f.path);
    callback(maxImages > 0 ? result.slice(0, maxImages) : result);
  }

  processNextDir();
}

function closeStreamAsync(stream) {
  return new Promise((resolve) => {
    stream.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
      try {
        s.close_finish(r);
      } catch (_) {}
      resolve();
    });
  });
}

/**
 * Loads a pixbuf without blocking the caller's main loop.
 * Used by the preferences grid, which renders many thumbnails per frame.
 */
export async function loadPixbufAsync(path) {
  const stream = await new Promise((res, rej) => {
    Gio.File.new_for_path(path).read_async(
      GLib.PRIORITY_DEFAULT,
      null,
      (f, r) => {
        try {
          res(f.read_finish(r));
        } catch (e) {
          rej(e);
        }
      },
    );
  });
  try {
    return await new Promise((res, rej) => {
      GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (s, r) => {
        try {
          res(GdkPixbuf.Pixbuf.new_from_stream_finish(r));
        } catch (e) {
          rej(e);
        }
      });
    });
  } finally {
    await closeStreamAsync(stream);
  }
}

/**
 * thumbnailPathFor:
 *
 * Location of a file's thumbnail under the freedesktop standard: the MD5 of
 * the file's URI, inside the requested size directory.
 */
export function thumbnailPathFor(imagePath, dir = THUMB_LARGE_DIR) {
  const uri = Gio.File.new_for_path(imagePath).get_uri();
  const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1);
  return GLib.build_filenamev([dir, `${hash}.png`]);
}

function queryInfoAsync(file, attrs) {
  return new Promise((resolve) => {
    file.query_info_async(
      attrs,
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (f, res) => {
        try {
          resolve(f.query_info_finish(res));
        } catch (_) {
          resolve(null);
        }
      },
    );
  });
}

const mtimeOf = (info) => info?.get_modification_date_time()?.to_unix() ?? 0;

/**
 * Produces a thumbnail for an image, preferring one the desktop already made.
 *
 * Reads the shared freedesktop cache first, so anything Files has already
 * thumbnailed costs nothing. Anything missing is generated into that same
 * cache with the standard metadata, which means Files can reuse ours too.
 * Falls back to the original image if a thumbnail cannot be produced.
 */
export async function getThumbnailAsync(imagePath) {
  const origFile = Gio.File.new_for_path(imagePath);
  const uri = origFile.get_uri();
  const srcInfo = await queryInfoAsync(origFile, "time::modified");
  const srcMtime = mtimeOf(srcInfo);

  // A thumbnail is usable when it is no older than the image it depicts.
  for (const dir of [THUMB_LARGE_DIR, THUMB_NORMAL_DIR, LEGACY_THUMB_DIR]) {
    const candidate =
      dir === LEGACY_THUMB_DIR
        ? GLib.build_filenamev([
            dir,
            `${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, imagePath, -1)}.png`,
          ])
        : thumbnailPathFor(imagePath, dir);
    const info = await queryInfoAsync(
      Gio.File.new_for_path(candidate),
      "time::modified",
    );
    if (info && mtimeOf(info) >= srcMtime) return candidate;
  }

  const thumbPath = thumbnailPathFor(imagePath);
  const thumbFile = Gio.File.new_for_path(thumbPath);

  return new Promise((resolve) => {
    const id = addBackgroundSource(
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        (async () => {
          removeBackgroundSource(id);
          let tmpPath = null;
          try {
            GLib.mkdir_with_parents(THUMB_LARGE_DIR, 0o700);

            // Read the header first so small images are never scaled up past
            // their own resolution, which the standard forbids.
            const dims = await new Promise((res) => {
              GdkPixbuf.Pixbuf.get_file_info_async(imagePath, null, (_s, r) => {
                try {
                  res(GdkPixbuf.Pixbuf.get_file_info_finish(r));
                } catch (_) {
                  res(null);
                }
              });
            });
            let targetW = THUMB_LARGE_MAX;
            let targetH = THUMB_LARGE_MAX;
            if (dims && dims[1] > 0 && dims[2] > 0) {
              const ratio = Math.min(
                1,
                THUMB_LARGE_MAX / Math.max(dims[1], dims[2]),
              );
              targetW = Math.max(1, Math.round(dims[1] * ratio));
              targetH = Math.max(1, Math.round(dims[2] * ratio));
            }

            const inStream = await new Promise((res, rej) => {
              origFile.read_async(GLib.PRIORITY_DEFAULT, null, (f, r) => {
                try {
                  res(f.read_finish(r));
                } catch (e) {
                  rej(e);
                }
              });
            });

            let pixbuf;
            try {
              pixbuf = await new Promise((res, rej) => {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                  inStream,
                  targetW,
                  targetH,
                  true,
                  null,
                  (_s, r) => {
                    try {
                      res(GdkPixbuf.Pixbuf.new_from_stream_finish(r));
                    } catch (e) {
                      rej(e);
                    }
                  },
                );
              });
            } finally {
              await closeStreamAsync(inStream);
            }

            // Write beside the target then rename, so a reader never sees a
            // half-written thumbnail.
            tmpPath = `${thumbPath}.${GLib.get_monotonic_time()}.tmp`;
            const tmpFile = Gio.File.new_for_path(tmpPath);
            const outStream = await new Promise((res, rej) => {
              tmpFile.replace_async(
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                GLib.PRIORITY_DEFAULT,
                null,
                (f, r) => {
                  try {
                    res(f.replace_finish(r));
                  } catch (e) {
                    rej(e);
                  }
                },
              );
            });

            let success = false;
            try {
              success = await new Promise((res) => {
                pixbuf.save_to_streamv_async(
                  outStream,
                  "png",
                  ["tEXt::Thumb::URI", "tEXt::Thumb::MTime", "tEXt::Software"],
                  [uri, String(srcMtime), THUMB_SOFTWARE],
                  null,
                  (_p, r) => {
                    try {
                      res(GdkPixbuf.Pixbuf.save_to_stream_finish(r));
                    } catch (e) {
                      logDebug(`thumbnail save: ${e.message}`);
                      res(false);
                    }
                  },
                );
              });
            } finally {
              await closeStreamAsync(outStream);
            }

            if (!success) throw new Error("pixbuf save failed");
            GLib.chmod(tmpPath, 0o600);
            if (GLib.rename(tmpPath, thumbPath) !== 0)
              throw new Error("thumbnail rename failed");
            tmpPath = null;
            resolve(thumbPath);
          } catch (e) {
            logDebug(`getThumbnailAsync error: ${e.message}`);
            if (tmpPath) {
              try {
                Gio.File.new_for_path(tmpPath).delete(null);
              } catch (_) {}
            }
            resolve(imagePath);
          }
        })();
        return GLib.SOURCE_REMOVE;
      }),
    );
  });
}

/**
 * Average relative luminance of the strip of an image that sits behind the
 * top bar, on a 0 to 1 scale.
 *
 * Reads the cached 256 px thumbnail rather than the full wallpaper, so this
 * costs nothing once the thumbnail exists. The strip is taken from the top of
 * the image, which matches the visible area for every picture-option except
 * "centered".
 */
export async function panelLuminanceAsync(imagePath, topFraction = 0.1) {
  const pixbuf = await loadPixbufAsync(await getThumbnailAsync(imagePath));
  const pixels = pixbuf.get_pixels();
  const stride = pixbuf.get_rowstride();
  const channels = pixbuf.get_n_channels();
  const width = pixbuf.get_width();
  const rows = Math.max(1, Math.round(pixbuf.get_height() * topFraction));

  let total = 0;
  let count = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * stride + x * channels;
      // sRGB relative luminance weights.
      total +=
        0.2126 * pixels[o] + 0.7152 * pixels[o + 1] + 0.0722 * pixels[o + 2];
      count++;
    }
  }
  return count ? total / count / 255 : 0.5;
}

/**
 * Retrieves image metadata (resolution, file size).
 * Updates and caches results in stats for subsequent performance.
 */
export async function getImageInfo(path) {
  try {
    const stats = loadStats();
    let entry = statsFor(stats, path);

    const file = Gio.File.new_for_path(path);
    const info = await queryInfoAsync(file, "standard::size,time::modified");
    if (!info) return "Unknown";
    const mtime = mtimeOf(info);

    if (entry?.res && entry?.size && entry?.mtime === mtime)
      return `${entry.res} | ${entry.size}`;

    const size = info.get_size();
    const sizeStr =
      size > 1_048_576
        ? `${(size / 1_048_576).toFixed(1)} MB`
        : `${Math.round(size / 1024)} KB`;

    const pbInfo = await new Promise((resolve) => {
      GdkPixbuf.Pixbuf.get_file_info_async(path, null, (s, res) => {
        try {
          resolve(GdkPixbuf.Pixbuf.get_file_info_finish(res));
        } catch (_) {
          resolve(null);
        }
      });
    });

    const res = pbInfo ? `${pbInfo[1]}×${pbInfo[2]}` : "???";
    const result = `${res} | ${sizeStr}`;

    const resChanged =
      !entry ||
      entry.res !== res ||
      entry.size !== sizeStr ||
      entry.mtime !== mtime;

    if (resChanged) {
      if (!entry) {
        entry = stats[path] = { count: 0, last_used: 0 };
      }
      entry.res = res;
      entry.size = sizeStr;
      entry.mtime = mtime;
      _saveStats();
    }

    return result;
  } catch (e) {
    logDebug(`getImageInfo error: ${e.message}`);
    return "Unknown";
  }
}

/**
 * Enumerates the thumbnails belonging to the user's own wallpapers.
 *
 * The cache is shared with the rest of the desktop, so both the size report
 * and the clear operation are scoped to images in the configured folders.
 * Thumbnails other applications created for other files are never touched.
 */
function ownThumbnailsAsync(dirs, callback) {
  getImagesAsync(dirs, "A-Z", 0, async (paths) => {
    const found = [];
    for (const p of paths) {
      const legacyHash = GLib.compute_checksum_for_string(
        GLib.ChecksumType.MD5,
        p,
        -1,
      );
      const candidates = [
        thumbnailPathFor(p, THUMB_LARGE_DIR),
        thumbnailPathFor(p, THUMB_NORMAL_DIR),
        GLib.build_filenamev([LEGACY_THUMB_DIR, `${legacyHash}.png`]),
      ];
      for (const c of candidates) {
        const info = await queryInfoAsync(
          Gio.File.new_for_path(c),
          "standard::size",
        );
        if (info) found.push({ path: c, size: info.get_size() });
      }
    }
    callback(found);
  });
}

export function getCacheInfoAsync(dirs, callback) {
  ownThumbnailsAsync(dirs, (found) => {
    callback({
      totalSize: found.reduce((n, f) => n + f.size, 0),
      count: found.length,
    });
  });
}

export function clearCacheAsync(dirs, callback) {
  try {
    ownThumbnailsAsync(dirs, async (found) => {
      for (const f of found) {
        await new Promise((resolve) => {
          Gio.File.new_for_path(f.path).delete_async(
            GLib.PRIORITY_DEFAULT,
            null,
            (file, res) => {
              try {
                file.delete_finish(res);
              } catch (_) {}
              resolve();
            },
          );
        });
      }
      callback?.(true);
    });
  } catch (e) {
    logDebug(`clearCacheAsync: ${e.message}`);
    callback?.(false);
  }
}

/**
 * Paints one image per monitor onto a single canvas matching the desktop's
 * full bounding box, which GNOME then stretches across all outputs in
 * "spanned" mode. GNOME has no per-monitor wallpaper setting of its own, so
 * composing one wide image is the only way to get different wallpapers on
 * different screens without patching the Shell.
 *
 * monitors: [{ x, y, width, height, connector }]
 * assignments: { [connector]: imagePath }
 * Returns the path of the composed image.
 */
export async function composeSpannedAsync(monitors, assignments, fallback) {
  if (!monitors.length) throw new Error("no monitors");

  const right = Math.max(...monitors.map((m) => m.x + m.width));
  const bottom = Math.max(...monitors.map((m) => m.y + m.height));
  const canvas = GdkPixbuf.Pixbuf.new(
    GdkPixbuf.Colorspace.RGB,
    false,
    8,
    right,
    bottom,
  );
  canvas.fill(0x000000ff);

  for (const m of monitors) {
    const src = assignments[m.connector] ?? fallback;
    if (!src) continue;
    let pb;
    try {
      pb = await loadPixbufAsync(src);
    } catch (e) {
      logDebug(`composeSpanned skip ${m.connector}: ${e.message}`);
      continue;
    }
    // Cover the monitor, centred, preserving aspect ratio.
    const scale = Math.max(m.width / pb.get_width(), m.height / pb.get_height());
    const offsetX = m.x + (m.width - pb.get_width() * scale) / 2;
    const offsetY = m.y + (m.height - pb.get_height() * scale) / 2;
    pb.composite(
      canvas,
      m.x,
      m.y,
      m.width,
      m.height,
      offsetX,
      offsetY,
      scale,
      scale,
      GdkPixbuf.InterpType.BILINEAR,
      255,
    );
  }

  GLib.mkdir_with_parents(DATA_DIR, 0o755);
  const out = GLib.build_filenamev([DATA_DIR, "spanned.png"]);
  const tmp = `${out}.${GLib.get_monotonic_time()}.tmp`;
  canvas.savev(tmp, "png", [], []);
  if (GLib.rename(tmp, out) !== 0) throw new Error("spanned rename failed");
  return out;
}

export function makeDisplayName(fname, maxLen = 20) {
  let name = fname
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]/g, " ")
    .trim();
  if (name.length > maxLen) name = `${name.substring(0, maxLen).trimEnd()}…`;
  return name;
}

export function shortenPath(path) {
  const home = GLib.get_home_dir();
  if (path === home || path.startsWith(`${home}/`))
    return `~${path.substring(home.length)}`;
  return path;
}

export function fuzzyMatch(query, text) {
  if (!query) return true;
  if (!text) return false;
  let i = 0,
    j = 0;
  while (i < query.length && j < text.length) {
    if (query[i] === text[j]) i++;
    j++;
  }
  return i === query.length;
}

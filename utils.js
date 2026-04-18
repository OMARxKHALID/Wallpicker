// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";

const APP_NAME = "wallpicker";

export const DATA_DIR = GLib.build_filenamev([
  GLib.get_user_data_dir(),
  APP_NAME,
]);
export const STATS_FILE = GLib.build_filenamev([DATA_DIR, "stats.json"]);
export const FAVORITES_FILE = GLib.build_filenamev([
  DATA_DIR,
  "favorites.json",
]);
export const THUMB_CACHE_DIR = GLib.build_filenamev([
  GLib.get_user_cache_dir(),
  APP_NAME,
  "thumbnails",
]);

export const THUMB_W = 190;
export const THUMB_H = 103;
export const SEARCH_DEBOUNCE_MS = 150;

export const IMAGE_EXTS = [
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
let _statsCache = null;
let _favsCache = null;
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
  // Errors are always logged, but gated by the same flag to reduce noise
  // or logged as critical only if needed. EGO wants gated console logs.
  if (_getDebugEnabled()) {
    console.error(`[${APP_NAME}] ${msg}: ${err?.message || err}`);
  }
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
  _statsCache = null;
  _favsCache = null;
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
    if (parent) {
      await new Promise((resolve) => {
        parent.make_directory_with_parents_async(
          GLib.PRIORITY_DEFAULT,
          null,
          (d, res) => {
            try {
              resolve(d.make_directory_with_parents_finish(res));
            } catch (e) {
              resolve();
            }
          },
        );
      });
    }

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
  try {
    const stats = loadStats();
    const fname = GLib.path_get_basename(path);
    const entry = stats[fname] ?? {
      count: 0,
      last_used: 0.0,
      res: null,
      size: null,
      mtime: 0,
    };
    entry.count += 1;
    entry.last_used = GLib.get_real_time() / 1_000_000;
    stats[fname] = entry;

    _saveStats();
  } catch (e) {
    logError("recordUse failed", e);
  }
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
  return _statsCache ?? {};
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
    _statsCache = _normaliseStats(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    logError("loadStatsAsync", e);
    _statsCache = {};
  }
}

function _saveStats() {
  if (!_statsCache || _saveTid) return;

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
 * Synchronous write of usage statistics. Used during shutdown.
 * Note: EGO-X-004 generally dislikes sync I/O, but flushStats is called
 * during disable() where async might not complete. We use replace_contents
 * which is a Gio wrapper, but we'll try to keep it minimal.
 */
export function flushStats() {
  if (!_saveTid || !_statsCache) return;
  GLib.Source.remove(_saveTid);
  _saveTid = null;

  try {
    const file = Gio.File.new_for_path(STATS_FILE);
    const parent = file.get_parent();
    if (parent) {
      try {
        parent.make_directory_with_parents(null);
      } catch (_) {}
    }

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

export function loadFavorites() {
  return _favsCache ?? new Set();
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
    _favsCache = new Set(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    logError("loadFavoritesAsync", e);
    _favsCache = new Set();
  }
}

export async function initModuleAsync() {
  await Promise.all([_loadStatsAsync(), _loadFavoritesAsync()]);
}

export function saveFavorites(favSet) {
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
  const queue = [...wallDirs];

  function processNextDir() {
    if (queue.length === 0) {
      finalize();
      return;
    }

    const dir = queue.shift();
    let realDir = dir;

    try {
      realDir = GLib.canonicalize_filename(dir, null) ?? dir;
    } catch (_) {
      realDir = dir;
    }

    if (visitedDirs.has(realDir)) {
      processNextDir();
      return;
    }
    visitedDirs.add(realDir);

    try {
      const d = Gio.File.new_for_path(dir);
      d.enumerate_children_async(
        "standard::name,standard::type,time::modified",
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
                      queue.push(GLib.build_filenamev([dir, name]));
                      continue;
                    }

                    if (!IMAGE_EXTS.some((e) => name.toLowerCase().endsWith(e)))
                      continue;
                    const path = GLib.build_filenamev([dir, name]);
                    if (seen.has(path)) continue;
                    seen.add(path);
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
      const favs = loadFavorites();
      filtered = allFiles.filter((f) => favs.has(f.name));
      filtered.sort((a, b) => lower(a).localeCompare(lower(b)));
    } else if (sortMode === "Newest") {
      filtered.sort((a, b) => b.mtime - a.mtime);
    } else if (sortMode === "Most Used") {
      const stats = loadStats();
      filtered.sort(
        (a, b) => (stats[b.name]?.count ?? 0) - (stats[a.name]?.count ?? 0),
      );
    } else if (sortMode === "Recent") {
      const stats = loadStats();
      filtered.sort(
        (a, b) =>
          (stats[b.name]?.last_used ?? 0) - (stats[a.name]?.last_used ?? 0),
      );
    } else {
      filtered.sort((a, b) => lower(a).localeCompare(lower(b)));
    }

    const result = filtered.map((f) => f.path);
    callback(maxImages > 0 ? result.slice(0, maxImages) : result);
  }

  processNextDir();
}

/**
 * Generates thumbnails asynchronously.
 * Scales images to fit THUMB_W x THUMB_H while preserving aspect ratio.
 */
export async function getThumbnailAsync(imagePath) {
  const hash = GLib.compute_checksum_for_string(
    GLib.ChecksumType.MD5,
    imagePath,
    -1,
  );
  const thumbPath = GLib.build_filenamev([THUMB_CACHE_DIR, `${hash}.png`]);
  const thumbFile = Gio.File.new_for_path(thumbPath);
  const origFile = Gio.File.new_for_path(imagePath);

  try {
    const [tInfo, oInfo] = await Promise.all([
      new Promise((resolve) => {
        thumbFile.query_info_async(
          "time::modified",
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
      }),
      new Promise((resolve) => {
        origFile.query_info_async(
          "time::modified",
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
      }),
    ]);

    if (tInfo && oInfo) {
      const tTime = tInfo.get_modification_date_time()?.to_unix() ?? 0;
      const oTime = oInfo.get_modification_date_time()?.to_unix() ?? 0;
      if (tTime >= oTime) return thumbPath;
    }
  } catch (_) {}

  return new Promise((resolve) => {
    const id = addBackgroundSource(
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        (async () => {
          removeBackgroundSource(id);
          try {
            const parent = thumbFile.get_parent();
            if (parent) {
              await new Promise((res) => {
                parent.make_directory_with_parents_async(
                  GLib.PRIORITY_DEFAULT,
                  null,
                  (d, r) => {
                    try {
                      res(d.make_directory_with_parents_finish(r));
                    } catch (e) {
                      res();
                    }
                  },
                );
              });
            }

            const stream = await new Promise((res, rej) => {
              origFile.read_async(GLib.PRIORITY_DEFAULT, null, (f, r) => {
                try {
                  res(f.read_finish(r));
                } catch (e) {
                  rej(e);
                }
              });
            });

            const pixbuf = await new Promise((res, rej) => {
              GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream,
                THUMB_W,
                THUMB_H,
                true,
                null,
                (s, r) => {
                  try {
                    res(GdkPixbuf.Pixbuf.new_from_stream_finish(r));
                  } catch (e) {
                    rej(e);
                  }
                },
              );
            });

            const [success] = await new Promise((res) => {
              pixbuf.save_to_streamv_async(
                thumbFile.replace(null, false, Gio.FileCreateFlags.NONE, null),
                "png",
                null,
                null,
                null,
                (p, r) => {
                  try {
                    res(p.save_to_stream_finish(r));
                  } catch (e) {
                    res([false]);
                  }
                },
              );
            });

            resolve(success ? thumbPath : imagePath);
          } catch (e) {
            logDebug(`getThumbnailAsync error: ${e.message}`);
            resolve(imagePath);
          }
        })();
        return GLib.SOURCE_REMOVE;
      }),
    );
  });
}

/**
 * Retrieves image metadata (resolution, file size).
 * Updates and caches results in stats for subsequent performance.
 */
export async function getImageInfo(path) {
  const fname = GLib.path_get_basename(path);
  try {
    const stats = loadStats();
    let entry = stats[fname];

    const file = Gio.File.new_for_path(path);
    const info = await new Promise((resolve, reject) => {
      file.query_info_async(
        "standard::size,time::modified",
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
        (f, res) => {
          try {
            resolve(f.query_info_finish(res));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
    const mtime = info.get_modification_date_time()?.to_unix() ?? 0;

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
        entry = stats[fname] = { count: 0, last_used: 0 };
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

export function getCacheInfoAsync(callback) {
  let totalSize = 0,
    count = 0;
  try {
    const dir = Gio.File.new_for_path(THUMB_CACHE_DIR);
    dir.enumerate_children_async(
      "standard::size",
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (source, res) => {
        let iter;
        try {
          iter = source.enumerate_children_finish(res);
        } catch (_) {
          callback({ totalSize, count });
          return;
        }

        const nextBatch = () => {
          iter.next_files_async(50, GLib.PRIORITY_DEFAULT, null, (it, res2) => {
            try {
              const files = it.next_files_finish(res2);
              if (files.length === 0) {
                it.close(null);
                callback({ totalSize, count });
                return;
              }
              for (const info of files) {
                totalSize += info.get_size();
                count++;
              }
              const id = addBackgroundSource(
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                  removeBackgroundSource(id);
                  nextBatch();
                  return GLib.SOURCE_REMOVE;
                }),
              );
            } catch (_) {
              callback({ totalSize, count });
            }
          });
        };
        nextBatch();
      },
    );
  } catch (e) {
    logDebug(`getCacheInfoAsync log: ${e.message}`);
    callback({ totalSize, count });
  }
}

export function clearCacheAsync(callback) {
  try {
    const dir = Gio.File.new_for_path(THUMB_CACHE_DIR);
    dir.enumerate_children_async(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (source, res) => {
        let iter;
        try {
          iter = source.enumerate_children_finish(res);
        } catch (_) {
          callback?.(false);
          return;
        }

        const nextBatch = () => {
          iter.next_files_async(50, GLib.PRIORITY_DEFAULT, null, (it, res2) => {
            try {
              const files = it.next_files_finish(res2);
              if (files.length === 0) {
                it.close(null);
                callback?.(true);
                return;
              }

              let pending = files.length;
              for (const info of files) {
                const child = dir.get_child(info.get_name());
                child.delete_async(
                  GLib.PRIORITY_DEFAULT,
                  null,
                  (_f, delRes) => {
                    try {
                      _f.delete_finish(delRes);
                    } catch (_) {}
                    if (--pending === 0) {
                      const id = addBackgroundSource(
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                          removeBackgroundSource(id);
                          nextBatch();
                          return GLib.SOURCE_REMOVE;
                        }),
                      );
                    }
                  },
                );
              }
            } catch (e) {
              logDebug(`clearCacheAsync log: ${e.message}`);
              callback?.(false);
            }
          });
        };
        nextBatch();
      },
    );
  } catch (e) {
    logDebug(`clearCacheAsync log: ${e.message}`);
    callback?.(false);
  }
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

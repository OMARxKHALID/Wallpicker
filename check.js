// SPDX-License-Identifier: GPL-3.0-or-later
//
// Self-contained smoke check for utils.js. Run: gjs -m check.js
// Builds a throwaway wallpaper tree (including a symlink loop), then exercises
// scanning, thumbnailing and the prefs stylesheet. Exits non-zero on failure.

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GdkPixbuf from "gi://GdkPixbuf";
import Gtk from "gi://Gtk?version=4.0";
import Adw from "gi://Adw?version=1";

import {
  getImagesAsync,
  getThumbnailAsync,
  loadPixbufAsync,
  thumbnailPathFor,
  composeSpannedAsync,
  panelLuminanceAsync,
  isFavorite,
  toggleFavorite,
  statsFor,
  recordUse,
  loadStats,
  THUMB_LARGE_DIR,
} from "./utils.js";

let failures = 0;
const check = (name, ok, extra = "") => {
  print(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) failures++;
};

const makeImage = (path, w, h, rgba = 0xff0000ff) => {
  const pb = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, w, h);
  pb.fill(rgba);
  pb.savev(path, "png", [], []);
};

/** Deletes a tree without following symlinks, so the loop link is removed
 *  rather than walked into. */
const rmrf = (path) => {
  const file = Gio.File.new_for_path(path);
  let info;
  try {
    info = file.query_info(
      "standard::type",
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
  } catch (_) {
    return;
  }
  if (info.get_file_type() === Gio.FileType.DIRECTORY) {
    const en = file.enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    let child;
    while ((child = en.next_file(null)))
      rmrf(GLib.build_filenamev([path, child.get_name()]));
    en.close(null);
  }
  try {
    file.delete(null);
  } catch (_) {}
};

const makeFixture = () => {
  const root = GLib.build_filenamev([GLib.get_tmp_dir(), "wallpicker-check"]);
  // Later assertions add files to this tree, so start from a clean slate or
  // the image-count checks drift on every subsequent run.
  rmrf(root);
  GLib.mkdir_with_parents(GLib.build_filenamev([root, "sub"]), 0o755);
  makeImage(GLib.build_filenamev([root, "red.png"]), 64, 48);
  makeImage(GLib.build_filenamev([root, "blue.png"]), 32, 32, 0x0000ffff);
  makeImage(GLib.build_filenamev([root, "don't-touch.png"]), 20, 20);
  makeImage(GLib.build_filenamev([root, "sub", "deep.png"]), 16, 16);
  // A directory symlink pointing back at its own ancestor.
  const link = Gio.File.new_for_path(GLib.build_filenamev([root, "sub", "loop"]));
  try {
    link.make_symbolic_link(root, null);
  } catch (_) {}
  return root;
};

const countFds = () => {
  try {
    const d = GLib.Dir.open("/proc/self/fd", 0);
    let n = 0;
    while (d.read_name() !== null) n++;
    return n;
  } catch (_) {
    return 0;
  }
};

const run = async (walls) => {
  const paths = await new Promise((resolve) => {
    const tid = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
      resolve(null);
      return GLib.SOURCE_REMOVE;
    });
    getImagesAsync([walls], "A-Z", 0, (r) => {
      GLib.Source.remove(tid);
      resolve(r);
    });
  });

  check("scan terminates despite symlink loop", paths !== null);
  if (paths) {
    const names = new Set(paths.map((p) => GLib.path_get_basename(p)));
    check("finds top-level images", names.has("red.png") && names.has("blue.png"));
    check("recurses into subdirectory", names.has("deep.png"));
    check("handles apostrophe in filename", names.has("don't-touch.png"));
    check("symlinked duplicates collapse", paths.length === 4, `${paths.length} paths`);
  }

  const src = GLib.build_filenamev([walls, "red.png"]);
  const thumb = await getThumbnailAsync(src);
  check("thumbnail generated into the cache", thumb !== src, thumb);

  const pb = await loadPixbufAsync(thumb);
  check("loadPixbufAsync decodes", pb.get_width() > 0, `${pb.get_width()}x${pb.get_height()}`);

  const before = countFds();
  for (let i = 0; i < 40; i++) await getThumbnailAsync(src);
  const after = countFds();
  check("no fd leak over 40 thumbnail calls", after - before < 10, `${before} -> ${after}`);

  // --- shared freedesktop thumbnail cache ---
  const uri = Gio.File.new_for_path(src).get_uri();
  const expected = GLib.build_filenamev([
    THUMB_LARGE_DIR,
    `${GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1)}.png`,
  ]);
  check("thumbnail lands in the shared XDG cache", thumb === expected, thumb);
  check("thumbnail path matches md5 of the file URI", thumbnailPathFor(src) === expected);

  const tf = Gio.File.new_for_path(thumb);
  const mode =
    tf.query_info("unix::mode", Gio.FileQueryInfoFlags.NONE, null)
      .get_attribute_uint32("unix::mode") & 0o777;
  check("thumbnail permissions are 0600", mode === 0o600, `0${mode.toString(8)}`);

  const meta = GdkPixbuf.Pixbuf.new_from_file(thumb);
  check("Thumb::URI recorded", meta.get_option("tEXt::Thumb::URI") === uri);
  check(
    "Thumb::MTime recorded",
    meta.get_option("tEXt::Thumb::MTime") ===
      String(
        Gio.File.new_for_path(src)
          .query_info("time::modified", Gio.FileQueryInfoFlags.NONE, null)
          .get_modification_date_time()
          .to_unix(),
      ),
  );
  check(
    "thumbnail never exceeds 256 px",
    Math.max(meta.get_width(), meta.get_height()) <= 256,
    `${meta.get_width()}x${meta.get_height()}`,
  );

  // A thumbnail another application already wrote must be reused untouched.
  const other = GLib.build_filenamev([walls, "blue.png"]);
  const otherThumb = thumbnailPathFor(other);
  GLib.mkdir_with_parents(THUMB_LARGE_DIR, 0o700);
  const marker = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 7, 7);
  marker.fill(0x00ff00ff);
  marker.savev(otherThumb, "png", [], []);
  const reused = await getThumbnailAsync(other);
  const reusedPb = GdkPixbuf.Pixbuf.new_from_file(reused);
  check(
    "reuses a thumbnail written by another app",
    reused === otherThumb && reusedPb.get_width() === 7,
    `${reusedPb.get_width()}x${reusedPb.get_height()}`,
  );

  // --- favourites and stats keyed by full path ---
  const a = GLib.build_filenamev([walls, "red.png"]);
  const b = GLib.build_filenamev([walls, "sub", "red.png"]);
  GLib.mkdir_with_parents(GLib.path_get_dirname(b), 0o755);
  makeImage(b, 30, 30);
  toggleFavorite(a);
  check("favourite applies to the starred path", isFavorite(a));
  check("same filename elsewhere is not starred", !isFavorite(b), GLib.path_get_basename(b));
  toggleFavorite(a);
  check("favourite toggles back off", !isFavorite(a));

  recordUse(a);
  recordUse(a);
  recordUse(b);
  check(
    "use counts do not collide across folders",
    statsFor(loadStats(), a).count === 2 && statsFor(loadStats(), b).count === 1,
    `${statsFor(loadStats(), a).count} vs ${statsFor(loadStats(), b).count}`,
  );

  // --- per-monitor composition ---
  const monitors = [
    { connector: "DP-1", x: 0, y: 0, width: 800, height: 600 },
    { connector: "HDMI-1", x: 800, y: 0, width: 640, height: 480 },
  ];
  const composed = await composeSpannedAsync(monitors, { "DP-1": a, "HDMI-1": other }, a);
  const cpb = GdkPixbuf.Pixbuf.new_from_file(composed);
  check(
    "spanned canvas covers the whole layout",
    cpb.get_width() === 1440 && cpb.get_height() === 600,
    `${cpb.get_width()}x${cpb.get_height()}`,
  );
  const px = (x, y) => {
    const b2 = cpb.get_pixels();
    const o = y * cpb.get_rowstride() + x * cpb.get_n_channels();
    return [b2[o], b2[o + 1], b2[o + 2]];
  };
  check("left monitor gets its assigned wallpaper (red)", px(400, 300)[0] > 200 && px(400, 300)[2] < 60, String(px(400, 300)));
  check("right monitor gets a different one (blue)", px(1100, 240)[2] > 200 && px(1100, 240)[0] < 60, String(px(1100, 240)));
  check("area outside every monitor stays black", String(px(1400, 580)) === "0,0,0", String(px(1400, 580)));

  // --- adaptive top bar text ---
  const darkWall = GLib.build_filenamev([walls, "black.png"]);
  makeImage(darkWall, 40, 40, 0x000000ff);
  const lightWall = GLib.build_filenamev([walls, "white.png"]);
  makeImage(lightWall, 40, 40, 0xffffffff);
  const darkLum = await panelLuminanceAsync(darkWall);
  const lightLum = await panelLuminanceAsync(lightWall);
  check("dark wallpaper reads as low luminance", darkLum < 0.5, darkLum.toFixed(3));
  check("light wallpaper reads as high luminance", lightLum > 0.5, lightLum.toFixed(3));
  let cssError = null;
  const provider = new Gtk.CssProvider();
  provider.connect("parsing-error", (_p, _s, e) => {
    cssError = e.message;
  });
  provider.load_from_string(
    `.wp-card:hover { border-color: @accent_bg_color; }
     .wp-card.active { box-shadow: 0 0 0 2px alpha(@accent_bg_color, 0.3); }
     .wp-delete-label { color: @error_bg_color; }`,
  );
  check(
    "prefs stylesheet parses on this libadwaita",
    cssError === null,
    cssError ?? `libadwaita ${Adw.get_major_version()}.${Adw.get_minor_version()}`,
  );
};

Gtk.init();
Adw.init();
const loop = new GLib.MainLoop(null, false);
const walls = makeFixture();

GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
  run(walls)
    .catch((e) => {
      print(`FAIL  uncaught: ${e}`);
      failures++;
    })
    .finally(() => loop.quit());
  return GLib.SOURCE_REMOVE;
});

loop.run();
print(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
imports.system.exit(failures === 0 ? 0 : 1);

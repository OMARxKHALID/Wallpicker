#!/usr/bin/env bash
# Builds the zip for submission to extensions.gnome.org.
#
# gnome-extensions pack only bundles the files it is told about, so the dev
# harness (check.js) and the README screenshots under assets/ are excluded by
# construction rather than by an ignore list. It also runs glib-compile-schemas
# itself, so gschemas.compiled does not need to be tracked in git.
set -e

OUT_DIR="${1:-dist}"
mkdir -p "${OUT_DIR}"

gnome-extensions pack \
    --force \
    --out-dir="${OUT_DIR}" \
    --extra-source=utils.js \
    --extra-source=prefs \
    --extra-source=LICENSE \
    --schema=schemas/org.gnome.shell.extensions.wallpicker.gschema.xml \
    .

ZIP="${OUT_DIR}/wallpicker@omarxkhalid.github.io.shell-extension.zip"
echo
echo "Built ${ZIP}"
echo "Contents:"
unzip -l "${ZIP}" | tail -n +4 | head -n -2 | awk '{print "  " $4}'

# Wallpicker

A lightweight and elegant GNOME Shell Extension to easily pick and manage your wallpapers right from the top bar.

## Features
- **Quick Access:** Change your wallpaper instantly from an intuitive panel menu.
- **Multiple Folders:** Add multiple source directories to pull wallpapers from.
- **Dynamic Grid:** Beautiful, responsive UI to browse thumbnails of your images.
- **Favorites:** Star your most-used wallpapers to keep them at the top.
- **Shuffle:** Randomly pick a new wallpaper with one click.
- **Keyboard Friendly:** Use hotkeys like `S` to search, `F` to favorite, `W` to jump to active, and more.
- **Search:** Quickly fuzzy-search wallpapers by filename.

## Installation

### From GNOME Extensions (Recommended)
Wait for the official release on [extensions.gnome.org](https://extensions.gnome.org/).

### Manual Installation
1. Clone the repository into your local extensions directory:
   ```bash
   git clone https://github.com/OMARxKHALID/Wallpicker.git ~/.local/share/gnome-shell/extensions/wallpicker@omarxkhalid.github.io
   ```
2. Compile the GSChemas (Settings):
   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/wallpicker@omarxkhalid.github.io/schemas/
   ```
3. Restart GNOME Shell (Alt+F2, type `r`, and hit Enter) or log out and log back in (on Wayland).
4. Enable the extension using the **Extensions** app or via terminal:
   ```bash
   gnome-extensions enable wallpicker@omarxkhalid.github.io
   ```

## Compatibility
Supports GNOME Shell `46`, `47`, and `48`.

## License
This extension is licensed under the [GPL-3.0-or-later](LICENSE).

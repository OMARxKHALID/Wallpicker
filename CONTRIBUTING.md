# Wallpicker Contributing Rules

To ensure high-quality code and a smooth review process (especially for extensions.gnome.org), all contributors should follow these commenting guidelines:

## Commenting Philosophy

Future comments must prioritize **'Why'** over **'What'**.

- **Avoid Redundancy**: Do not describe obvious GTK/GJS syntax or explain _what_ a line does if it is self-evident.
- **Explain Architecture**: Describe high-level technical decisions and why a specific pattern was chosen.
- **Document Workarounds**: Exhaustively explain platform-specific workarounds (Wayland vs. X11 focus, Mutter positioning, etc.) to aid security and stability audits.
- **Performance Trade-offs**: Document the rationale behind asynchronous I/O, batch loading, and idle callback synchronization to ensure the Shell main loop remains responsive.

# Multiple windows

The desktop app can open more than one window. Each window has its own sidebar project filter and
can use its own theme, so you can keep one window per project or task side by side. All windows
share the same environments, threads, and settings. The web app and mobile app use a single window.

## Open a window

Choose **New Window** in the command palette or the app menu, or press **Cmd+Option+Shift+N** on
macOS or **Ctrl+Alt+Shift+N** on Windows and Linux. The new window starts with the current window's
project filter. Change the shortcut under **Settings → Keybindings** (`window.new`).

Closing the main window while others are open hides it instead, since the other windows connect
through it. On Windows and Linux it closes once the last other window does.

To keep to one window, turn off **Multiple windows** under **Settings → General → Windows**. New
Window, its shortcut, and opening saved windows are then unavailable; windows already open stay open
until you close them.

## Save a window

When you close a window you have not saved, T3 Code asks whether to save it. Enter a name and choose
**Save** to keep its project filter and theme, **Don't Save** to close it without keeping anything,
or **Cancel** (or Escape) to keep it open.

Reopen a saved window with **Open window: _name_** in the command palette, or from
**Settings → General → Windows**. If the window is already open, it comes to the front instead.

## Manage saved windows

**Settings → General → Windows** lists the main window with your saved windows below it. Rename a
window by editing its name in place, pick its theme, open or focus it, or delete it. **Add saved
window** creates one without opening it. Deleting a saved window that is open leaves it open as an
unsaved window. A window you have not saved yet can be saved from the same section.

A window with a project filter uses **Project colour** by default: its projects' icon colours tint
the top of its sidebar, and the rest of the window keeps the main window's theme. Projects whose
icon is an image or an emoji add no colour. Pick a theme for a saved window to use that theme
instead. Changing the theme from inside a window with its own theme changes only that window.
Light, dark, and system appearance stay shared by every window.

## Mini Mode

Choose **Enter Mini Mode** in the main window's command palette to turn the main window into a
compact panel. **Expand** returns to the full app, as does opening a search result or the full
settings. On macOS the panel has no close, minimise or zoom buttons.

The panel's tabs show your other open windows, the multiple windows switch, the list your Pull
requests page opens with, each provider's usage limits, and whether an update is ready. It opens on
**Usage**, which rereads the limits when the tab opens if they are more than five minutes old.

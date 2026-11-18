# Multiple windows

The desktop app can open more than one window. Each window has its own sidebar project filter and
can use its own theme, so you can keep one window per project or task side by side. All windows
share the same environments, threads, and settings. The web app and mobile app use a single window.

## Open a window

Choose **New Window** in the command palette or the app menu, or press **Cmd+Option+Shift+N** on
macOS or **Ctrl+Alt+Shift+N** on Windows and Linux. The new window starts with the current window's
project filter. Change the shortcut under **Settings → Keybindings** (`window.new`).

## Save a window

When you close a window you have not saved, T3 Code asks whether to save it. Enter a name and choose
**Save** to keep its project filter and theme, **Don't Save** to close it without keeping anything,
or **Cancel** (or Escape) to keep it open.

Reopen a saved window with **Open window: _name_** in the command palette, or from
**Settings → General → Windows**. If the window is already open, it comes to the front instead.

## Manage saved windows

**Settings → General → Windows** lists the main window and every saved window. From there you can
rename a window, open or focus it, or delete it. Deleting a saved window that is open leaves it
open as an unsaved window. A window you have not saved yet can be saved from the same section.

Each saved window can follow the main window's theme or use a theme of its own. Changing the theme
from inside a window with its own theme changes only that window. Light, dark, and system
appearance stay shared by every window.

## Mini Mode

Choose **Enter Mini Mode** in the main window's command palette to turn the main window into a
compact panel. It leads with your usage limits: how much of each provider's plan is left and when it
resets. The limits are reread when the panel opens or regains focus, and on **Refresh limits**. Below
them it lists your other open windows, so you can bring one to the front or open a new one. Choose
**Expand** to return to the full app.

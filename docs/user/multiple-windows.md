# Multiple windows

The desktop app can open more than one window. Each window has its own sidebar project filter and
can use its own theme, so you can keep one window per project or task side by side. All windows
share the same environments, threads, and settings. The web app and mobile app use a single window.

## Open a window

Choose **New Window** in the command palette or the app menu, or press **Cmd+Option+Shift+N** on
macOS or **Ctrl+Alt+Shift+N** on Windows and Linux. The new window starts with the current window's
project filter. Change the shortcut under **Settings → Keybindings** (`window.new`).

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

**Settings → General → Windows** lists the main window with your saved windows below it. From there
you can rename a window by editing its name in place, pick its theme, open or focus it, or delete it.
Each saved window's row fades in its theme's accent colour from the right edge, or its projects'
colours when it uses **Project colour**. The theme menu shows each theme's light and dark colours.
**Add saved window** creates one without opening it: type its name in the new row, then pick the
projects it shows and a theme. The project list is grouped as the sidebar groups projects, with a
group's projects indented under it. Deleting a saved window that is open leaves it open as an
unsaved window. A window you have not saved yet can be saved from the same section.

By default a window shows its projects' icon colours across the top of its sidebar, behind the T3
Code name and the Search row: one project's colour, or a left-to-right blend of several. The rest
of the window keeps its theme. Projects whose icon is an image or an emoji add no colour, and a
window that shows all projects, or only such projects, looks like the main window. Pick a theme for
a saved window to use that theme instead, without project colours. Changing the theme from inside
a window with its own theme changes only that window. Light, dark, and system appearance stay
shared by every window.

## Mini Mode

Choose **Enter Mini Mode** in the main window's command palette to turn the main window into a
compact panel. Its top bar offers **Search**, **New Window** (while multiple windows are on) and
**Expand**, which returns to the full app. Opening a search result or the full settings also
returns to the full app. On macOS the panel has no close, minimise or zoom buttons.

The tabs along the bottom each show one thing:

- **Windows**: your other open windows, each with its project filter, name, and what it is showing.
  Choose one to bring it to the front.
- **Settings**: the multiple windows switch, and a link to all settings.
- **Pull requests**: the list your Pull requests page opens with. Choosing one opens it in your
  browser.
- **Usage**: how much of each provider's plan is left and when it resets. The panel opens on this
  tab. The limits are reread when the tab opens or the window regains focus, and on **Refresh
  limits**.
- **Update**: the version you are running and whether an update is ready.

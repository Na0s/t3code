# Multiple windows

The desktop app can open more than one window, so you can keep different threads side by side. All
windows share the same environments, threads, and settings. The web app and mobile app use a single
window.

## Open a window

Choose **New Window** in the command palette or the app menu, or press **Cmd+Option+Shift+N** on
macOS or **Ctrl+Alt+Shift+N** on Windows and Linux. Change the shortcut under
**Settings → Keybindings** (`window.new`).

Closing the main window while others are open hides it instead, since the other windows connect
through it. On Windows and Linux it closes once the last other window does.

## T3_BOT window

Choose **Open T3_BOT** in the command palette or the Window menu, or press **Cmd+Option+Shift+B** on
macOS or **Ctrl+Alt+Shift+B** on Windows and Linux (`bot.open`). There is one T3_BOT window; opening
it again brings it forward. It remembers its position, its size, and whether it stays above other
apps' windows.

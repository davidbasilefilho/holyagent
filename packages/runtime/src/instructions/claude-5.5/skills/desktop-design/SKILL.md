---
name: desktop-design
description: "Use when building, reshaping or judging the visual design of a desktop app on Windows, macOS or GNOME. Holds the shared design core, rules shared by desktop platforms, a Windows, a macOS and a GNOME section, a refuse list and the capture checklist."
---

# Desktop design

Rules for desktop apps, judged on what renders. Apply the shared part and the section of each platform the app ships on; never carry one platform's conventions to another, and keep the native window chrome in every capture.

<!-- design-core -->

## Shared desktop rules

- Design to the window, not the screen, and reflow smoothly at every width. Symptom: clipped or stranded content when the window narrows.
- Everything the pointer can do, the keyboard can do. Tab order follows visual order, arrows move inside composite controls, and a custom focusable element shows a visible focus indicator. (behavior check)
- Shortcuts are discoverable in menus and tooltips.
- The app follows the system light or dark theme, accent color, text scale and high-contrast mode. A hard-coded color that breaks high contrast is a defect.
- Desktop is denser than mobile, but frequent or high-consequence targets get more room.
- Settings are few, have good defaults, apply immediately and do not duplicate system options.

## Windows

- Standard controls align to 40×40 epx and compact ones to 32×32 epx, on a 4 epx grid, with 8 epx between buttons.
- The title bar is 32 px high. Empty space drags the window, right-click shows the system menu, and double-click toggles maximize. (behavior check)
- Caption buttons sit at the right and stay fully visible, so the title truncates first. The bar dims when the window is inactive. Capture both.
- Direct manipulation comes first, then a command bar, and a menu bar for complex apps. Context menus hold secondary commands.
- Accelerators are Ctrl plus a letter and access keys are Alt plus a letter; F6 and Shift+F6 cycle the panes. (behavior check)
- Use the system font and its ramp, sentence case, semibold instead of bold, and no italics. The accent marks emphasis and state, sparingly.
- Mica is for windows and acrylic only for transient surfaces. Contrast themes are not dark mode and are captured on their own.

## macOS

- System window frames and controls, never custom chrome. Default control size is 28×28 pt with 20×20 pt as the minimum.
- Text is 13 pt by default with 10 pt as the minimum. There is no dynamic text size, so use the system font roles.
- The menu bar keeps the standard order: App, File, Edit, Format, View, the app's own menus, Window, Help. Unavailable items are dimmed, not hidden.
- Settings lives in the app menu and opens with Cmd+comma; the toolbar has no settings button. Standard shortcuts keep their meaning, and one is reused only when its standard action does not exist in the app. Full Keyboard Access works. (behavior check)
- Toolbars are customizable and monochrome over colorful content, with short titles that are never the app name.
- Sheets are modal; a long task gets a window. Glass belongs to the control layer, and content uses standard materials with vibrancy.

## GNOME

- The header bar puts main actions at the start, the title or view switcher in the center and menus at the end. Controls are few, flat icon buttons with tooltips, and drag space always remains.
- The primary menu sits at the end of the header bar and holds Preferences, Keyboard Shortcuts, Help and About, with no Quit or Close item.
- Shortcuts use Ctrl, and Shift+Ctrl reverses; never Alt (access keys) or Super (system). F10 opens the menu and Esc closes transient views. (behavior check)
- Design from the narrowest size up. Support at least 1024×600, and down to 360×294 for phone-capable apps. Content width is capped in large windows.
- Use the system font and text styles, with no italics, no all caps and no text over images.
- Default to light and follow the system preference; offer light, dark and system when an in-app choice exists, and never hard-code an accent the system provides.
- Settings use boxed lists with one control per row, two at most.

## Refuse list

Unless the brief asks for it:

- custom window chrome or caption buttons
- one platform's menu bar, shortcuts or settings placement on another
- a hamburger menu that holds the primary commands of a desktop app
- hard-coded colors that ignore the system theme and high contrast
- a mobile layout stretched across a wide window

## Capture checklist

Capture narrow, default and wide window widths, each in light, dark and high contrast, and, where the platform has a text scale, at 150% or 200%. Add a keyboard-only focus traversal, the open menus, an inactive window and a dialog or sheet. Show the native window chrome in every capture.

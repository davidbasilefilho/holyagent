---
name: mobile-design
description: "Use when building, reshaping or judging the visual design of a phone or tablet app on iOS, iPadOS or Android. Holds the shared design core, rules shared by both platforms, an iOS and iPadOS section, an Android section, a refuse list and the capture checklist."
---

# Mobile design

Rules for phone and tablet apps, judged on what renders. Apply the shared part and the section of each OS the app ships on; never carry one OS's conventions to the other.

<!-- design-core -->

## Shared mobile rules

- Adapt to the window size class, never the device, and name layout variants by class, not "tablet". Panes take the width they are given; extra width adds context and does not stretch content.
- System-bar and safe-area insets apply once per screen. Backgrounds draw edge to edge, and touch targets stay out of gesture areas. Symptom: content under a bar or doubled padding.
- Gestures supplement visible controls and never replace them.
- Refresh never clears existing content; skeletons are for the cold load only. Capture mid-refresh.
- Keyboard: "Next" moves through fields, and "Done" on the last dismisses the keyboard and keeps the text. (behavior check)
- After a refresh or rotation, focus and selection stay on the same item, not the same position. (behavior check)
- Haptics reach only the holder and sound reaches the room, so feedback scales with rarity. One action produces one feedback, never a doubled buzz or sound. (behavior check)
- Every interactive element has a label unique within its collection. A row reads as one announcement and exposes a multi-action row's actions by name. (behavior check)

## iOS and iPadOS

- Targets are 44×44 pt. 28×28 pt is the stated minimum for dense controls. Pad about 12 pt around bezeled and about 24 pt around unbezeled elements.
- Use the system text styles, 17 pt by default and 11 pt at least, with no light weights. Text scales to at least 200%, custom fonts included.
- At accessibility text sizes truncate as little as possible, allow as many lines as needed, stack rows vertically and scale meaningful icons with the text. Capture that size.
- Tab bars hold sections, never actions. Never hide or disable a tab, avoid a "More" overflow, and use single-word labels.
- A visible Back button stays, and the edge swipe is a shortcut. On iPad prefer the tab bar, which may become a sidebar of at most two levels.
- A sheet holds one scoped task at a time. Cancel goes leading and Done trailing, never Cancel, Done and Back together, and a swipe-dismiss that would lose changes asks first. (behavior check)
- Liquid Glass (iOS 26 and later): glass is the control and navigation layer, never the content layer, and custom glass is not stacked on glass. Use the regular variant by default and the clear variant only over rich media. Tint only the primary action's background, and strip custom bar backgrounds and borders. Corners are concentric: inner radius equals outer radius minus padding.
- iOS 27 guidance on scroll edges, sidebars, tab bars, menus, search and icons is not encoded here; judge those on a render of the target OS.
- Color is semantic. Every custom color has light, dark and increased-contrast variants.
- Aim for 7:1 on small text, and offer no in-app appearance switch. (preference)
- Common actions use system symbols matched to the text weight.
- Motion is purposeful, optional and cancelable; under Reduce Motion movement becomes a fade. Capture with the setting on.

## Android

- Window size classes in dp. Width: compact below 600, medium 600 to 839, expanded 840 to 1199, large 1200 to 1599, extra-large 1600 and up. Height: compact below 480, medium 480 to 899, expanded 900 and up. The layout is re-evaluated on every resize, fold or split-screen change. (behavior check)
- One primary navigation surface at a time. Compact uses a navigation bar. Medium uses a bar or a rail, by whether horizontal or vertical space matters more. Expanded and up use a rail. Prefer the expanded rail over a drawer, which Material 3 Expressive no longer recommends.
- Targets are at least 48×48 dp with 8 dp or more between them; pointer targets are at least 44 dp.
- Edge to edge is enforced from Android 15: content draws behind the system bars, bar icons keep contrast, interactive content is inset, and a scrim sits where content scrolls under a bar.
- Predictive back is on by default: the back swipe previews the destination and lands where the preview showed. Custom back behavior goes through the platform's back handling. (behavior check)
- Color and type use Material roles, never raw values. Type roles are Display, Headline, Title, Body and Label in large, medium and small; adjust line height and tracking before sizes. An "on" color sits on its paired fill, and container colors are fills, not text colors. Light and dark use the same roles. Contrast levels are standard, medium and high, and each is judged in light and dark.
- Choose components by behavior. Expressive motion is for a few moments and the rest stays calm (preference).

## Refuse list

Unless the brief asks for it:

- a card around every row, and a FAB for a minor action (preference)
- chips used as buttons
- a "Materialized" screen of radii and pastels (preference)
- iOS navigation patterns on Android, or Material navigation on iOS
- a hamburger drawer where an expanded rail fits
- a custom control where the system one exists (the ported-from-a-website test)

## Capture checklist

Capture each size class the brief targets (at least compact and one wider class). For each: light and dark, the largest standard and an accessibility text size, and reduced motion on. Add increased contrast on iOS, a refresh in progress, a sheet or back transition, and the keyboard open. Capture both OSes when the app ships on both.

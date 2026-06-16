---
name: ios-simulator
description: Interact with a running iOS simulator — capture screenshots and open deep links to navigate to specific screens. Use this skill whenever the user mentions the iOS simulator and wants to see, screenshot, capture, or verify what's on screen; navigate to a specific route or screen; test a deep link; check that a URL scheme works; or after any SwiftUI/UIKit/React Native UI change where visual confirmation would help. Also trigger proactively after deep-linking to verify the correct screen opened. Prefer this skill over asking the user to manually share a screenshot or navigate the app.
allowed-tools: Bash(ios-screenshot:*), Bash(ios-deeplink:*), Bash(xcrun simctl:*), Read
---

# iOS Simulator

Two commands: `ios-screenshot` captures the current screen; `ios-deeplink` navigates to any registered URL.

If `ios-screenshot` or `ios-deeplink` are not on your PATH, run them from this skill's own `bin/`
directory (relative to this SKILL.md):
- `bin/ios-screenshot`
- `bin/ios-deeplink`

## Screenshot

```bash
ios-screenshot
```

Saves to `./.screenshots/ios-sim-<timestamp>.png` and prints the absolute path. Pass that path to `Read` to view it inline:

```
Read("./.screenshots/ios-sim-2026-05-26T16-52-26.png")
```

**Options**
```bash
ios-screenshot --out /tmp/before.png          # explicit path
ios-screenshot --format jpeg                  # smaller file
ios-screenshot --device "iPhone 17 Pro Max"   # specific device
ios-screenshot --stdout > shot.png            # pipe to stdout
```

## Deep linking

```bash
ios-deeplink myapp://home
ios-deeplink "myapp://profile/42?tab=posts"
ios-deeplink myapp://onboarding/step/3 --device "iPhone 17 Pro Max"
```

Calls `xcrun simctl openurl` under the hood. Universal links (`https://`) also work when the app handles them.

**After deep linking, always take a screenshot to verify the right screen opened:**
```bash
ios-deeplink myapp://settings/notifications
ios-screenshot
# then Read the path
```

To discover what URL schemes the app registers, look for `CFBundleURLSchemes` in `Info.plist`, or grep the project:
```bash
grep -r "CFBundleURLSchemes\|openURL" . --include="*.plist" --include="*.swift" -l
```

## Listing booted devices

```bash
xcrun simctl list devices booted
```

## Failure modes

**"no iOS simulator is booted"** — boot one with `xcrun simctl boot "<name>"` or via Xcode → Open Developer Tool → Simulator. The error prints the current device list.

**Deep link does nothing / opens browser** — the URL scheme isn't registered in the app, or the app isn't in the foreground. Confirm `CFBundleURLSchemes` in the target's `Info.plist`.

**Wrong `--device`** — use the exact name or UDID from `xcrun simctl list devices`.

**Permission error writing `.screenshots/`** — pass `--out /tmp/foo.png` instead.

## Conventions

- Screenshots land in `./.screenshots/` (created automatically). Add it to `.gitignore` — these are throwaways.
- Filenames are ISO-8601 so before/after pairs sort chronologically.

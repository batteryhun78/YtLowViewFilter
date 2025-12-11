# YouTube View Filter

A customizable UserScript (for Violentmonkey/Tampermonkey) that cleans up your YouTube feed by filtering videos by views and other criteria. It includes a floating, draggable UI panel, a masthead gear for quick access, stats, and optional preview mode.

## Features

*   Filter by minimum views with a curved slider (0 → 1,000,000)
*   Hide Members‑only videos (multi‑language badge detection)
*   Hide Auto‑dubbed videos (title/metadata contains "auto‑dubbed")
*   Hide Live videos, optionally only when live viewers are below a threshold
    *   Separate slider and input for live viewers (0 → 1,000,000)
    *   Can hide all live videos or only those below your live threshold
*   Built‑in UI panel
    *   Draggable panel with collapsible sections
    *   Gear button (⚙️) added to the YouTube masthead to show/hide the panel
    *   Recheck Page button to reapply filters instantly
*   Preview mode: mark filtered items (highlight + label) instead of hiding them
*   Stats: counts per reason (Low, Members, Auto‑dubbed, Live) and a lifetime total
*   Lightweight layout fix to keep grid spacing consistent when items are hidden

## Installation

Option A — One‑click via raw URL (recommended)
1. Install **Violentmonkey** (recommended) or **Tampermonkey**.
2. Open this raw install/update URL in your browser and confirm the installation:
   https://raw.githubusercontent.com/IceCuBear/YtLowViewFilter/refs/heads/main/YtLowViewFilter.user.js

Option B — Manual
1. Install **Violentmonkey** or **Tampermonkey**.
2. Create a new userscript and paste the contents of `YtLowViewFilter.user.js`.
3. Save and enable the script.

## Usage

1. Open YouTube. The script runs automatically on `youtube.com` and `m.youtube.com`.
2. Click the **⚙️** icon in the top‑right YouTube header to open/close the panel.
3. Configure filters:
   - Enable Filtering: master on/off switch.
   - Filter by Views: set the minimum views using the number input or slider (0 → 1,000,000). Uses a curved slider for finer control at low values.
   - Hide Members‑only: hides items with “Members only” style badges (supports multiple languages).
   - Hide Auto‑dubbed: hides videos detected as auto‑dubbed.
   - Hide Live videos: hide all live videos, or enable “Only hide LIVE below viewers” and adjust the live viewers threshold.
   - Collapse/Expand: use ▾ / ▸ buttons to show or hide detailed controls.
   - Preview filtered: when enabled, items are highlighted and labeled instead of being removed.
4. Use “Recheck Page” to reapply filters immediately after changing options.
5. Check the stats section for per‑reason counts and the total lifetime hidden count.

## Configuration & Persistence

Settings are stored in `localStorage` and persist across sessions. Keys and defaults:

* `ytvf_enabled`: `true` by default
* `ytvf_threshold`: `100000` (minimum views)
* `ytvf_filter_views`: `true`
* `ytvf_filter_members`: `true`
* `ytvf_filter_live`: `false`
* `ytvf_filter_autodubbed`: `false`
* `ytvf_live_use_threshold`: `false` (when true, only hide live videos below `ytvf_live_min_watchers`)
* `ytvf_live_min_watchers`: `1000`
* `ytvf_collapse_main_threshold`: `false` (UI collapsed state)
* `ytvf_collapse_live_section`: `false` (UI collapsed state)
* `ytvf_preview`: `false` (preview mode)
* `ytvf_lifetime`: total lifetime hidden counter (number)

Ranges:
* View threshold slider: `0` → `1,000,000`
* Live viewer slider: `0` → `1,000,000`

## Notes

* The gear button is injected into the masthead’s `#buttons` area; the panel also closes when clicking outside it.
* A small CSS fix is injected to keep the grid layout stable when items are hidden.
* If YouTube’s layout changes, the “Recheck Page” button or a page refresh usually restores expected filtering.

## License

Licensed under the GNU AGPLv3.

You are free to use, modify, and share this software under the terms of the AGPLv3. If you run a modified version as a network service, the AGPL requires that you make your modified source code available to users interacting with that service. Contributions and pull requests are welcome.
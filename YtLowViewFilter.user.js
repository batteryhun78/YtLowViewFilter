// ==UserScript==
// @name         YouTube View Filter + UI
// @namespace    yt-view-filter-ui
// @version      3.6
// @description  Filter YouTube items by minimum views, Members‑only, Auto‑dubbed, and LIVE status. Includes a compact, draggable UI and stats.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @downloadURL  https://raw.githubusercontent.com/IceCuBear/YtLowViewFilter/refs/heads/main/YtLowViewFilter.user.js
// @updateURL    https://raw.githubusercontent.com/IceCuBear/YtLowViewFilter/refs/heads/main/YtLowViewFilter.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    ////////////////////////////////////////////////////////////////////////////
    // 1. State & Config
    // Holds user preferences and UI state. Persisted to localStorage.
    ////////////////////////////////////////////////////////////////////////////

    // Precompiled patterns (avoid re-allocations in tight loops)
    // - RE_SUFFIX: captures a number with optional decimal and a suffix (K/M/B/E)
    // - RE_HAS_DIGIT: quick check to skip non-metadata text nodes
    // - RE_SHORT_SUFFIX_IN_TEXT: lightweight hint that a views suffix is present
    // - RE_WATCHING_LINE: matches strings like "3,200 watching" or "1.2K watching now"
    // - RE_AUTO_DUBBED: matches "auto-dubbed" with normal or Unicode hyphen
    const RE_SUFFIX = /(\d+(?:[.,]\d+)?)\s*([KMEB])\b/i;
    const RE_HAS_DIGIT = /\d/;
    const RE_SHORT_SUFFIX_IN_TEXT = /\d\s*[KMEB]\b/i;
    const RE_WATCHING_LINE = /\b\d[\d.,]*\s*(watching|watching now)\b/i;
    const RE_AUTO_DUBBED = /auto[\-\u2010-\u2015]?dubbed/i;

    const state = {
        enabled: JSON.parse(localStorage.getItem("ytvf_enabled") || "true"),
        threshold: Number(localStorage.getItem("ytvf_threshold") || "100000"),
        lifetimeHidden: Number(localStorage.getItem("ytvf_lifetime") || "0"),
        uiVisible: false,
        // Feature toggles
        filterViews: JSON.parse(localStorage.getItem("ytvf_filter_views") || "true"),
        filterMembers: JSON.parse(localStorage.getItem("ytvf_filter_members") || "true"),
        filterLive: JSON.parse(localStorage.getItem("ytvf_filter_live") || "false"),
        filterAutoDubbed: JSON.parse(localStorage.getItem("ytvf_filter_autodubbed") || "false"),
        // LIVE-specific options
        liveUseThreshold: JSON.parse(localStorage.getItem("ytvf_live_use_threshold") || "false"),
        liveMinWatchers: Number(localStorage.getItem("ytvf_live_min_watchers") || "1000"),
        // Collapsible UI state
        mainThresholdCollapsed: JSON.parse(localStorage.getItem("ytvf_collapse_main_threshold") || "false"),
        liveSectionCollapsed: JSON.parse(localStorage.getItem("ytvf_collapse_live_section") || "false"),
        // Preview mode: show filtered items with highlight instead of hiding
        previewMode: JSON.parse(localStorage.getItem("ytvf_preview") || "false"),
    };

    /**
     * Persist current state to localStorage.
     */
    function saveState() {
        localStorage.setItem("ytvf_enabled", JSON.stringify(state.enabled));
        localStorage.setItem("ytvf_threshold", String(state.threshold));
        localStorage.setItem("ytvf_lifetime", String(state.lifetimeHidden));
        localStorage.setItem("ytvf_filter_views", JSON.stringify(state.filterViews));
        localStorage.setItem("ytvf_filter_members", JSON.stringify(state.filterMembers));
        localStorage.setItem("ytvf_filter_live", JSON.stringify(state.filterLive));
        localStorage.setItem("ytvf_filter_autodubbed", JSON.stringify(state.filterAutoDubbed));
        localStorage.setItem("ytvf_live_use_threshold", JSON.stringify(state.liveUseThreshold));
        localStorage.setItem("ytvf_live_min_watchers", String(state.liveMinWatchers));
        localStorage.setItem("ytvf_collapse_main_threshold", JSON.stringify(state.mainThresholdCollapsed));
        localStorage.setItem("ytvf_collapse_live_section", JSON.stringify(state.liveSectionCollapsed));
        localStorage.setItem("ytvf_preview", JSON.stringify(state.previewMode));
    }

    ////////////////////////////////////////////////////////////////////////////
    // 2. Parsing & Detection Utilities
    // Helper functions that extract signals from DOM nodes and text.
    ////////////////////////////////////////////////////////////////////////////

    /**
     * Parse a view-count text into a number.
     * Examples: "1,2K" -> 1200, "1.1M" -> 1100000, "985" -> 985
     * @param {string} text
     * @returns {number|null} Parsed numeric value or null if not recognized
     */
    function parseViews(text) {
        if (!text) return null;

        const match = text.match(RE_SUFFIX);

        if (match) {
            let numStr = match[1].replace(",", ".");
            const suffix = match[2].toUpperCase();
            let multiplier = 1;

            if (suffix === 'K' || suffix === 'E') multiplier = 1_000;
            if (suffix === 'M') multiplier = 1_000_000;
            if (suffix === 'B') multiplier = 1_000_000_000;

            return parseFloat(numStr) * multiplier;
        }

        const digits = text.replace(/\D/g, "");
        return digits ? parseInt(digits, 10) : null;
    }

    /**
     * Determine if a video is Members‑only by scanning common badge containers.
     * @param {Element} root Container element of a video item
     * @returns {boolean}
     */
    function isMembersOnly(root) {
        const badges = root.querySelectorAll(
            ".yt-badge-shape__text, .yt-core-attributed-string, span, .badge-shape"
        );
        for (const b of badges) {
            const t = (b.textContent || "").trim().toLowerCase();
            // Extend language list as needed
            if (t.includes("csak tagoknak") || t.includes("members only") ||
                t.includes("mitgliedern") || t.includes("miembros")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Strict detection of actual livestreams only.
     * Avoids generic title/aria matches to reduce false positives.
     * @param {Element} root
     * @returns {boolean}
     */
    function isLive(root) {
        // 1) Explicit LIVE badges on thumbnails
        if (root.querySelector('.yt-badge-shape--thumbnail-live')) return true;
        // 2) Avatar LIVE ring/badge — intentionally ignored to prevent false positives
        // if (root.querySelector('.yt-spec-avatar-shape__live-badge')) return true;

        // 3) Metadata pattern like "450 watching" (live-now counter)
        //    This avoids false positives from titles/descriptions containing the word "live".
        const meta = root.querySelectorAll(
            '.yt-content-metadata-view-model__metadata-text, .yt-core-attributed-string'
        );
        for (const m of meta) {
            const t = (m.textContent || '').trim();
            if (RE_WATCHING_LINE.test(t)) return true;
        }

        // Do not rely on generic 'live' text in titles or aria-labels.
        return false;
    }

    /**
     * Detect the Auto‑dubbed badge across typical metadata containers.
     * @param {Element} root
     * @returns {boolean}
     */
    function isAutoDubbed(root) {
        // Scan common text containers for the badge text
        const nodes = root.querySelectorAll(
            ".yt-badge-shape__text, .yt-core-attributed-string, .yt-content-metadata-view-model__metadata-text, span"
        );
        for (const n of nodes) {
            const t = (n.textContent || "").trim();
            // Match "auto‑dubbed" allowing ASCII or Unicode hyphen
            if (RE_AUTO_DUBBED.test(t)) return true;
        }
        return false;
    }

    /**
     * Extract live viewer count from metadata lines like "1.1K watching".
     * Returns null when not applicable or not detected.
     * @param {Element} root
     * @returns {number|null}
     */
    function getLiveWatchers(root) {
        const meta = root.querySelectorAll(
            '.yt-content-metadata-view-model__metadata-text, .yt-core-attributed-string'
        );
        for (const m of meta) {
            const t = (m.textContent || '').trim();
            if (/\bwatching( now)?\b/i.test(t)) {
                // Extract the numeric part before the word "watching"
                const numPartMatch = t.match(/(\d[\d.,]*\s*[KM]?)\s*watching/i);
                if (numPartMatch) {
                    const numPart = numPartMatch[1].replace(/\s/g, '');
                    // Reuse parseViews-like logic for K/M suffix
                    const mSuffix = numPart.match(/(\d+(?:[.,]\d+)?)\s*([KM])$/i);
                    if (mSuffix) {
                        let n = parseFloat(mSuffix[1].replace(',', '.'));
                        const s = mSuffix[2].toUpperCase();
                        if (s === 'K') n *= 1_000;
                        if (s === 'M') n *= 1_000_000;
                        return Math.floor(n);
                    }
                    // Fallback: strip non-digits
                    const digits = numPart.replace(/\D/g, '');
                    if (digits) return parseInt(digits, 10);
                }
            }
        }
        return null;
    }

    ////////////////////////////////////////////////////////////////////////////
    // 3. Filter Logic
    // Classify each visible item and hide/mark it when a rule matches.
    ////////////////////////////////////////////////////////////////////////////

    /**
     * Evaluate all candidate items on the page and apply filtering/marking.
     * Uses data attributes to avoid reprocessing unchanged items.
     */
    function filterAll() {
        if (!state.enabled) return;

        const items = document.querySelectorAll(
            [
                "ytd-rich-item-renderer",
                "ytd-video-renderer",
                "ytd-grid-video-renderer",
                "ytd-compact-video-renderer",
                "yt-lockup-view-model"
            ].join(",")
        );

        let hasNewStats = false;

        for (const item of items) {
            if (item.dataset.ytvfChecked === "1") continue;

            let viewText = "";

            // Gather candidates from both legacy and new metadata containers in a single pass
            const metaNodes = item.querySelectorAll(
                "#metadata-line span, span.ytd-video-meta-block, .yt-content-metadata-view-model__metadata-text, .yt-core-attributed-string"
            );
            for (const n of metaNodes) {
                const t = n.textContent || "";
                if (
                    RE_HAS_DIGIT.test(t) &&
                    (t.includes("megtekintés") || t.includes("views") || t.includes("Aufrufe") || RE_SHORT_SUFFIX_IN_TEXT.test(t))
                ) {
                    viewText = t;
                    break;
                }
            }

            // Compute signals lazily based on active toggles to reduce DOM scans
            const members = state.filterMembers ? isMembersOnly(item) : false;
            const autoDub = state.filterAutoDubbed ? isAutoDubbed(item) : false;
            // We need LIVE detection both when filtering LIVEs and when skipping view-threshold on LIVEs
            const needLiveCheck = state.filterLive || state.filterViews;
            const live = needLiveCheck ? isLive(item) : false;
            const liveWatchers = live && state.filterLive && state.liveUseThreshold ? getLiveWatchers(item) : null;
            // Only parse views if we might need it (non-LIVE items and views filter enabled)
            const views = state.filterViews && !live ? parseViews(viewText) : null;
            let reason = null;

            // 1) Members-only has highest priority
            if (state.filterMembers && members) {
                reason = "mem";
            }
            // 2) Auto-dubbed (optional on/off)
            else if (state.filterAutoDubbed && autoDub) {
                reason = "dub";
            }
            // 3) LIVE items are handled here exclusively so they are never hidden by the views rule
            else if (live) {
                if (state.filterLive) {
                    if (!state.liveUseThreshold) {
                        reason = "live"; // hide all LIVE items
                    } else {
                        // Hide LIVE if watchers are below threshold (or unknown)
                        if (liveWatchers === null || liveWatchers < state.liveMinWatchers) {
                            reason = "live";
                        }
                    }
                }
                // If filterLive is OFF, do not apply the generic views filter to LIVE items.
            }
            // 4) Non‑LIVE items can be hidden by the views threshold
            else if (state.filterViews && views !== null && views < state.threshold) {
                reason = "low";
            }

            if (reason) {
                // Mark item as filtered
                item.dataset.ytvfHidden = reason;

                if (state.previewMode) {
                    // In preview mode, do not hide — highlight instead
                    item.classList.remove("ytvf-hidden");
                    item.style.display = "";
                    item.classList.add("ytvf-marked");
                } else {
                    // Default behavior: hide
                    item.classList.remove("ytvf-marked");
                    item.classList.add("ytvf-hidden");
                }

                if (!item.dataset.ytvfCounted) {
                    state.lifetimeHidden++;
                    item.dataset.ytvfCounted = "1";
                    hasNewStats = true;
                }
            } else {
                // If no longer matches filtering, ensure it's visible and unmarked
                item.classList.remove("ytvf-marked");
                item.classList.remove("ytvf-hidden");
                item.style.display = "";
                delete item.dataset.ytvfHidden;
            }

            item.dataset.ytvfChecked = "1";
        }

        if (hasNewStats) saveState();
        updateStatsUI();
    }

    ////////////////////////////////////////////////////////////////////////////
    // 4. Observer
    // Watches for dynamic content changes and re-applies filtering.
    ////////////////////////////////////////////////////////////////////////////

    let debounceTimer;
    const observer = new MutationObserver(() => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            filterAll();
            createCog();
        }, 200);
    });

    /**
     * Start observing the primary container for feed changes.
     */
    function startObserver() {
        const target = document.querySelector("ytd-page-manager") || document.body;
        observer.observe(target, {childList: true, subtree: true});
    }

    ////////////////////////////////////////////////////////////////////////////
    // 5. UI & Stats
    ////////////////////////////////////////////////////////////////////////////

    /**
     * Update counters in the stats section when the panel is visible.
     * Lightweight when the panel is hidden.
     */
    function updateStatsUI() {
        // Skip heavy counting when the UI panel is hidden
        if (!state.uiVisible) return;
        const elLow = document.getElementById("ytvf-stats-low");
        const elMem = document.getElementById("ytvf-stats-mem");
        const elDub = document.getElementById("ytvf-stats-dub");
        const elLive = document.getElementById("ytvf-stats-live");
        const elLife = document.getElementById("ytvf-stats-lifetime");

        if (!elLow) return;

        const lowCount = document.querySelectorAll('[data-ytvf-hidden="low"]').length;
        const memCount = document.querySelectorAll('[data-ytvf-hidden="mem"]').length;
        const dubCount = document.querySelectorAll('[data-ytvf-hidden="dub"]').length;
        const liveCount = document.querySelectorAll('[data-ytvf-hidden="live"]').length;

        elLow.textContent = lowCount;
        elMem.textContent = memCount;
        if (elDub) elDub.textContent = dubCount;
        if (elLive) elLive.textContent = liveCount;
        elLife.textContent = state.lifetimeHidden.toLocaleString();
    }

    /**
     * Build and inject the control panel and wire up all interactions.
     */
    function createUI() {
        if (document.getElementById("ytvf-panel")) return;

        // Curved slider helpers: 0..1000 -> 0..1,000,000 (cubic)
        const toThreshold = (s) => Math.floor(Math.pow(s, 3) / 1000);
        const toSlider = (t) => Math.pow(t * 1000, 1 / 3);

        const panel = document.createElement("div");
        panel.id = "ytvf-panel";
        panel.style = `
                position: fixed; top: 70px; right: 80px; width: 280px;
                background: #0f0f0fee; border: 1px solid #333; border-radius: 12px;
                z-index: 999999; color: white; font-family: Roboto, sans-serif; display: none;
                box-shadow: 0 10px 25px rgba(0,0,0,0.6); backdrop-filter: blur(4px);
            `;

        panel.innerHTML = `
                <div id="ytvf-header" style="
                    padding: 12px; background: #1f1f1f; border-radius: 12px 12px 0 0;
                    display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #333; cursor: move;">
                    <span style="font-weight:bold;">Filter Settings</span>
                    <button id="ytvf-close" style="background:none; border:none; color:#aaa; font-size:20px; cursor:pointer;">×</button>
                </div>

                <div style="padding: 15px;">
                    <label style="display:flex; align-items:center; gap: 10px; cursor: pointer; margin-bottom: 15px;">
                        <input id="ytvf-enabled" type="checkbox" ${state.enabled ? "checked" : ""} style="transform:scale(1.2);">
                        <span>Enable Filtering</span>
                    </label>


                    <div style="margin-bottom: 12px;">
                        <div style="display:flex; align-items:center; justify-content:space-between; margin: 6px 0;">
                            <label style="display:flex; align-items:center; gap: 10px; cursor: pointer;">
                                <input id="ytvf-filter-views" type="checkbox" ${state.filterViews ? "checked" : ""} style="transform:scale(1.1);">
                                <span>Filter by Views</span>
                            </label>
                            <button id="ytvf-views-collapse" title="Collapse/Expand"
                                style="background:#1f1f1f; border:1px solid #333; color:#aaa; padding:0 6px; height:22px; border-radius:4px; cursor:pointer;">${JSON.parse(localStorage.getItem("ytvf_collapse_main_threshold") || "false") ? "▸" : "▾"}</button>
                        </div>
                        
                        <div id="ytvf-views-threshold-wrap" style="margin-left: 26px; margin-top: 4px; display:${state.filterViews && !JSON.parse(localStorage.getItem("ytvf_collapse_main_threshold") || "false") ? "block" : "none"};">
                            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                                <span style="font-size:12px;color:#aaa;">Min viewers</span>
                                <input id="ytvf-input" type="number" value="${state.threshold}" min="0"
                                       style="background:#222; color:#fff; border:1px solid #444; width:100px; border-radius:4px; padding:2px 5px; text-align:right;">
                            </div>
                            <div id="ytvf-slider-wrapper" style="padding: 2px 0 0 0;">
                                <input id="ytvf-slider" type="range" min="0" max="1000" step="1"
                                       style="width:100%; cursor: pointer; accent-color: #3ea6ff; display: block;">
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:10px; color:#aaa; margin-top:2px;">
                                <span>0</span><span>1M</span>
                            </div>
                        </div>
                        <label style="display:flex; align-items:center; gap: 10px; cursor: pointer; margin: 6px 0;">
                            <input id="ytvf-filter-members" type="checkbox" ${state.filterMembers ? "checked" : ""} style="transform:scale(1.1);">
                            <span>Hide Members-only</span>
                        </label>
                        <label style="display:flex; align-items:center; gap: 10px; cursor: pointer; margin: 6px 0;">
                            <input id="ytvf-filter-dub" type="checkbox" ${state.filterAutoDubbed ? "checked" : ""} style="transform:scale(1.1);">
                            <span>Hide Auto-dubbed</span>
                        </label>
                        <div style="display:flex; align-items:center; justify-content:space-between; margin: 6px 0;">
                            <label style="display:flex; align-items:center; gap: 10px; cursor: pointer;">
                                <input id="ytvf-filter-live" type="checkbox" ${state.filterLive ? "checked" : ""} style="transform:scale(1.1);">
                                <span>Hide Live videos</span>
                            </label>
                            <button id="ytvf-live-collapse" title="Collapse/Expand"
                                style="background:#1f1f1f; border:1px solid #333; color:#aaa; padding:0 6px; height:22px; border-radius:4px; cursor:pointer;">${JSON.parse(localStorage.getItem("ytvf_collapse_live_section") || "false") ? "▸" : "▾"}</button>
                        </div>
                        <div id="ytvf-live-threshold-wrap" style="margin-left: 26px; margin-top: 4px; display:${state.filterLive && !JSON.parse(localStorage.getItem("ytvf_collapse_live_section") || "false") ? "flex" : "none"}; flex-direction:column;">
                            <label style="display:flex; align-items:center; gap: 10px; cursor: pointer; margin-bottom:6px;">
                                <input id="ytvf-live-use-threshold" type="checkbox" ${state.liveUseThreshold ? "checked" : ""} style="transform:scale(1.05);">
                                <span>Only hide LIVE below viewers</span>
                            </label>
                            <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                                <span style="font-size:12px;color:#aaa;">Min viewers</span>
                                <input id="ytvf-live-min" type="number" value="${state.liveMinWatchers}" min="0"
                                       style="background:#222; color:#fff; border:1px solid #444; width:100px; border-radius:4px; padding:2px 5px; text-align:right;">
                            </div>
                            <div id="ytvf-live-slider-wrapper" style="padding: 2px 0 0 0;">
                                <input id="ytvf-live-slider" type="range" min="0" max="1000" step="1"
                                       style="width:100%; cursor: pointer; accent-color: #3ea6ff; display: block;">
                            </div>
                            <div style="display:flex; justify-content:space-between; font-size:10px; color:#aaa; margin-top:2px;">
                                <span>0</span><span>1M</span>
                            </div>
                        </div>
                        <label style="display:flex; align-items:center; gap: 10px; cursor: pointer; margin: 12px 0 0 0; padding-top:8px; border-top:1px solid #333;">
                            <input id="ytvf-preview" type="checkbox" ${state.previewMode ? "checked" : ""} style="transform:scale(1.1);">
                            <span>Preview filtered (highlight instead of hide)</span>
                        </label>
                    </div>

                    <div style="background: #222; padding: 10px; border-radius: 8px; font-size: 12px; color: #ccc; border: 1px solid #333;">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 4px;">
                            <span>Hidden (Low):</span> <span id="ytvf-stats-low" style="color:#fff; font-weight:bold;">0</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                            <span>Hidden (Members):</span> <span id="ytvf-stats-mem" style="color:#fff; font-weight:bold;">0</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                            <span>Hidden (Auto-dubbed):</span> <span id="ytvf-stats-dub" style="color:#fff; font-weight:bold;">0</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; margin-bottom: 8px;">
                            <span>Hidden (Live):</span> <span id="ytvf-stats-live" style="color:#fff; font-weight:bold;">0</span>
                        </div>
                        <div style="border-top: 1px solid #444; padding-top: 6px; margin-top: 6px; display:flex; justify-content:space-between;">
                            <span>Total Lifetime:</span> <span id="ytvf-stats-lifetime" style="color:#3ea6ff; font-weight:bold;">${state.lifetimeHidden}</span>
                        </div>
                    </div>

                    <button id="ytvf-recheck" style="
                        width:100%; margin-top:15px; padding:8px; background:#333; color:white;
                        border:1px solid #444; border-radius:6px; cursor:pointer;">
                        Recheck Page
                    </button>
                </div>
            `;

        document.body.appendChild(panel);

        document.getElementById("ytvf-close").onclick = () => {
            panel.style.display = "none";
            state.uiVisible = false;
        };

        // Dragging
        const header = document.getElementById("ytvf-header");
        let offsetX = 0, offsetY = 0, dragging = false;
        header.onmousedown = (e) => {
            dragging = true;
            offsetX = e.clientX - panel.offsetLeft;
            offsetY = e.clientY - panel.offsetTop;
            e.preventDefault();
        };
        document.onmousemove = (e) => {
            if (!dragging) return;
            panel.style.left = (e.clientX - offsetX) + "px";
            panel.style.top = (e.clientY - offsetY) + "px";
        };
        document.onmouseup = () => dragging = false;

        document.getElementById("ytvf-enabled").onchange = (e) => {
            state.enabled = e.target.checked;
            saveState();
            resetAndRun();
        };

        const chkViews = document.getElementById("ytvf-filter-views");
        const chkMembers = document.getElementById("ytvf-filter-members");
        const chkLive = document.getElementById("ytvf-filter-live");
        const chkDub = document.getElementById("ytvf-filter-dub");
        const chkPreview = document.getElementById("ytvf-preview");
        const liveUseTh = document.getElementById("ytvf-live-use-threshold");
        const liveMin = document.getElementById("ytvf-live-min");
        const liveWrap = document.getElementById("ytvf-live-threshold-wrap");
        const liveSlider = document.getElementById("ytvf-live-slider");
        const liveSliderWrapper = document.getElementById("ytvf-live-slider-wrapper");
        const liveCollapse = document.getElementById("ytvf-live-collapse");
        const viewsCollapse = document.getElementById("ytvf-views-collapse");
        const viewsWrap = document.getElementById("ytvf-views-threshold-wrap");
        if (chkViews) chkViews.onchange = (e) => {
            state.filterViews = e.target.checked;
            if (state.filterViews) {
                // Auto-expand when enabling
                state.mainThresholdCollapsed = false;
                if (viewsWrap) viewsWrap.style.display = "block";
                if (viewsCollapse) viewsCollapse.textContent = "▾";
            } else {
                if (viewsWrap) viewsWrap.style.display = "none";
            }
            saveState();
            resetAndRun();
        };
        if (chkMembers) chkMembers.onchange = (e) => {
            state.filterMembers = e.target.checked;
            saveState();
            resetAndRun();
        };
        if (chkDub) chkDub.onchange = (e) => {
            state.filterAutoDubbed = e.target.checked;
            saveState();
            resetAndRun();
        };
        if (chkLive) chkLive.onchange = (e) => {
            state.filterLive = e.target.checked;
            // When enabling, auto-expand; when disabling, keep collapsed state but hide content
            if (state.filterLive) {
                state.liveSectionCollapsed = false;
                if (liveWrap) liveWrap.style.display = "flex";
                if (liveCollapse) liveCollapse.textContent = "▾";
            } else {
                if (liveWrap) liveWrap.style.display = "none";
            }
            saveState();
            resetAndRun();
        };
        if (chkPreview) chkPreview.onchange = (e) => {
            state.previewMode = e.target.checked;
            saveState();
            resetAndRun();
        };

        // Collapsible: Views (main threshold) section
        if (viewsCollapse && viewsWrap) {
            viewsCollapse.onclick = (e) => {
                e.stopPropagation();
                state.mainThresholdCollapsed = !state.mainThresholdCollapsed;
                viewsWrap.style.display = (state.filterViews && !state.mainThresholdCollapsed) ? "block" : "none";
                viewsCollapse.textContent = state.mainThresholdCollapsed ? "▸" : "▾";
                saveState();
            };
        }

        // Collapsible: LIVE section
        if (liveCollapse && liveWrap) {
            liveCollapse.onclick = (e) => {
                e.stopPropagation();
                state.liveSectionCollapsed = !state.liveSectionCollapsed;
                liveWrap.style.display = (state.filterLive && !state.liveSectionCollapsed) ? "flex" : "none";
                liveCollapse.textContent = state.liveSectionCollapsed ? "▸" : "▾";
                saveState();
            };
        }

        // LIVE threshold controls
        if (liveUseTh) liveUseTh.onchange = (e) => {
            state.liveUseThreshold = e.target.checked;
            if (liveMin) liveMin.disabled = !state.liveUseThreshold;
            if (liveSlider) liveSlider.disabled = !state.liveUseThreshold;
            saveState();
            resetAndRun();
        };
        if (liveMin) {
            liveMin.disabled = !state.liveUseThreshold;
            liveMin.onchange = (e) => {
                let v = parseInt(e.target.value, 10);
                if (isNaN(v) || v < 0) v = 0;
                state.liveMinWatchers = v;
                if (liveSlider) liveSlider.value = toSlider(v);
                saveState();
                resetAndRun();
            };
        }
        if (liveSlider && liveSliderWrapper) {
            // Initialize from state
            liveSlider.value = toSlider(state.liveMinWatchers);
            liveSlider.disabled = !state.liveUseThreshold;
            ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach(evt => {
                liveSliderWrapper.addEventListener(evt, (e) => e.stopPropagation());
            });
            liveSlider.oninput = (e) => {
                const val = toThreshold(Number(e.target.value));
                state.liveMinWatchers = val;
                if (liveMin) liveMin.value = val;
                saveState();
            };
            liveSlider.onchange = () => {
                resetAndRun();
            };
        }

        const slider = document.getElementById("ytvf-slider");
        const input = document.getElementById("ytvf-input");
        const sliderWrapper = document.getElementById("ytvf-slider-wrapper");

        // Initialize slider from state
        slider.value = toSlider(state.threshold);

        ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend'].forEach(evt => {
            sliderWrapper.addEventListener(evt, (e) => e.stopPropagation());
        });

        slider.oninput = (e) => {
            const val = toThreshold(Number(e.target.value));
            state.threshold = val;
            input.value = val;
            saveState();
        };

        slider.onchange = () => {
            resetAndRun();
        };

        input.onchange = (e) => {
            let val = parseInt(e.target.value, 10);
            if (isNaN(val)) val = 0;
            state.threshold = val;
            slider.value = toSlider(val);
            saveState();
            resetAndRun();
        };

        document.getElementById("ytvf-recheck").onclick = () => {
            resetAndRun();
        };
    }

    /**
     * Clear per-item processing flags and re-run filtering to reflect the current state.
     */
    function resetAndRun() {
        document.querySelectorAll("[data-ytvf-checked]").forEach(el => {
            delete el.dataset.ytvfChecked;
            delete el.dataset.ytvfHidden;
            el.style.display = "";
            el.classList.remove("ytvf-marked");
        });
        filterAll();
    }

    /**
     * Inject a tiny layout fix so the rich grid remains compact when items are hidden.
     */
    function injectLayoutFix() {
        if (document.getElementById("ytvf-layout-fix")) return;
        const style = document.createElement("style");
        style.id = "ytvf-layout-fix";
        style.textContent = `
                ytd-rich-grid-row {
                    display: contents !important;
                }
            `;
        document.head.appendChild(style);
    }

    /**
     * Styles used to visually mark filtered items in Preview mode.
     */
    function injectPreviewStyles() {
        if (document.getElementById("ytvf-preview-styles")) return;
        const style = document.createElement("style");
        style.id = "ytvf-preview-styles";
        style.textContent = `
            .ytvf-marked {
                position: relative !important;
                filter: grayscale(0.3) saturate(0.7);
                opacity: 0.6;
                outline: 2px dashed rgba(255, 99, 132, 0.8);
                outline-offset: -2px;
            }
            .ytvf-marked::after {
                content: attr(data-ytvf-hidden) ' filtered';
                position: absolute;
                top: 6px;
                left: 6px;
                padding: 2px 6px;
                font-size: 11px;
                font-weight: 600;
                color: #fff;
                background: rgba(255, 99, 132, 0.85);
                border-radius: 4px;
                pointer-events: none;
                z-index: 2;
            }
        `;
        document.head.appendChild(style);
    }

    // Inject a small stylesheet for hiding items via class (avoids repeated inline style writes)
    function injectHiddenStyles() {
        if (document.getElementById("ytvf-hidden-styles")) return;
        const style = document.createElement("style");
        style.id = "ytvf-hidden-styles";
        style.textContent = `
            .ytvf-hidden { display: none !important; }
        `;
        document.head.appendChild(style);
    }

    /**
     * Create the masthead gear button (⚙️) to toggle the panel.
     */
    function createCog() {
        if (document.getElementById("ytvf-cog")) return;
        const mastheadButtons = document.querySelector("ytd-masthead #buttons");
        if (!mastheadButtons) return;

        const cog = document.createElement("div");
        cog.id = "ytvf-cog";
        cog.style = "display: flex; align-items: center; margin-right: 8px; cursor: pointer;";
        cog.innerHTML = `<button style="background:none;border:none;color:white;padding:8px;border-radius:50%;cursor:pointer;"><span style="font-size:22px;">⚙️</span></button>`;

        cog.onclick = () => {
            const panel = document.getElementById("ytvf-panel");
            if (panel) {
                panel.style.display = panel.style.display === "none" || panel.style.display === "" ? "block" : "none";
                state.uiVisible = panel.style.display === "block";
                updateStatsUI();
            }
        };
        mastheadButtons.insertBefore(cog, mastheadButtons.firstChild);
    }

    // Close the panel when clicking outside of it (and not on the cog)
    let outsideCloseAttached = false;

    /**
     * Close the panel on outside clicks while ignoring interactions with the cog.
     */
    function attachOutsideClose() {
        if (outsideCloseAttached) return;
        outsideCloseAttached = true;
        document.addEventListener('click', (e) => {
            const panel = document.getElementById('ytvf-panel');
            const cog = document.getElementById('ytvf-cog');
            if (!panel) return;
            if (panel.style.display !== 'block') return;
            const target = e.target;
            const insidePanel = target && (target.closest ? target.closest('#ytvf-panel') : null);
            const onCog = target && (target.closest ? target.closest('#ytvf-cog') : null);
            if (!insidePanel && !onCog) {
                panel.style.display = 'none';
                state.uiVisible = false;
            }
        }, true);
    }

    /**
     * Bootstrap: inject styles, build UI, start observers, and run the initial pass.
     */
    function init() {
        injectLayoutFix();
        injectHiddenStyles();
        injectPreviewStyles();
        createUI();
        createCog();
        attachOutsideClose();
        startObserver();
        filterAll();
        window.addEventListener("yt-navigate-finish", () => {
            setTimeout(() => {
                createCog();
                resetAndRun();
            }, 500);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
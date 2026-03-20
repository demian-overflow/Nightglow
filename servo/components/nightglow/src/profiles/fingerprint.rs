/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Full browser fingerprint definition.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A complete set of browser fingerprint attributes.
///
/// Every field that can be observed by a remote website is represented here,
/// allowing NightGlow to spoof a coherent, internally-consistent identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserProfile {
    /// Unique identifier for this profile (not exposed to sites).
    pub id: Uuid,

    /// Human-readable label (e.g. "win11-chrome-us-east").
    pub label: String,

    // ── Navigator / UA ────────────────────────────────────────────────────────
    pub user_agent: String,
    pub platform: String,
    pub app_version: String,
    pub product: String,
    pub vendor: String,
    pub vendor_sub: String,
    pub product_sub: String,

    // ── Accept-Language / locale ──────────────────────────────────────────────
    /// Primary language tag, e.g. "en-US".
    pub language: String,
    /// Full Accept-Language header value, e.g. "en-US,en;q=0.9".
    pub accept_language: String,

    // ── Timezone ──────────────────────────────────────────────────────────────
    /// IANA timezone, e.g. "America/New_York".
    pub timezone: String,
    /// Offset from UTC in minutes (negative = west), e.g. -300 for EST.
    pub timezone_offset: i32,

    // ── Screen / display ──────────────────────────────────────────────────────
    pub screen_width: u32,
    pub screen_height: u32,
    pub screen_avail_width: u32,
    pub screen_avail_height: u32,
    pub color_depth: u8,
    pub pixel_depth: u8,
    pub device_pixel_ratio: f64,

    // ── Window / viewport ─────────────────────────────────────────────────────
    pub inner_width: u32,
    pub inner_height: u32,
    pub outer_width: u32,
    pub outer_height: u32,

    // ── Hardware concurrency / memory ─────────────────────────────────────────
    pub hardware_concurrency: u8,
    /// Approximate device RAM in GiB as returned by `navigator.deviceMemory`.
    pub device_memory: f32,

    // ── Plugins ───────────────────────────────────────────────────────────────
    pub plugins: Vec<PluginInfo>,

    // ── Fonts (available system fonts detected via canvas probing) ────────────
    pub fonts: Vec<String>,

    // ── Canvas fingerprint seed ───────────────────────────────────────────────
    /// A deterministic noise seed injected into canvas pixel data so every
    /// profile produces a unique but stable canvas hash.
    pub canvas_noise_seed: u64,

    // ── WebGL ─────────────────────────────────────────────────────────────────
    pub webgl_vendor: String,
    pub webgl_renderer: String,
    /// Unmasked vendor (WEBGL_debug_renderer_info).
    pub webgl_unmasked_vendor: String,
    /// Unmasked renderer (WEBGL_debug_renderer_info).
    pub webgl_unmasked_renderer: String,

    // ── Audio context fingerprint ─────────────────────────────────────────────
    /// Deterministic noise offset for AudioContext sample data.
    pub audio_noise_seed: u64,

    // ── Network ───────────────────────────────────────────────────────────────
    /// Proxy URL (SOCKS5 / HTTP). `None` means direct connection.
    pub proxy: Option<String>,
    /// Spoofed public IP reported in X-Forwarded-For (informational only).
    pub spoofed_ip: Option<String>,

    // ── Misc ──────────────────────────────────────────────────────────────────
    pub do_not_track: Option<bool>,
    pub cookie_enabled: bool,
    pub java_enabled: bool,
    pub pdf_viewer_enabled: bool,
    /// Whether `navigator.webdriver` is hidden.
    pub hide_webdriver: bool,
    /// Touch support level: 0 = no touch, >0 = max touch points.
    pub max_touch_points: u8,
}

/// Minimal description of a browser plugin entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub name: String,
    pub description: String,
    pub filename: String,
    pub mime_types: Vec<String>,
}

impl BrowserProfile {
    /// Create a plausible Chrome 124 / Windows 11 / US-East profile.
    ///
    /// Useful for quick tests and as a generation baseline.
    pub fn chrome_win11_us() -> Self {
        Self {
            id: Uuid::new_v4(),
            label: "chrome124-win11-us-east".into(),
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36".into(),
            platform: "Win32".into(),
            app_version: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36".into(),
            product: "Gecko".into(),
            vendor: "Google Inc.".into(),
            vendor_sub: "".into(),
            product_sub: "20030107".into(),
            language: "en-US".into(),
            accept_language: "en-US,en;q=0.9".into(),
            timezone: "America/New_York".into(),
            timezone_offset: -300,
            screen_width: 1920,
            screen_height: 1080,
            screen_avail_width: 1920,
            screen_avail_height: 1040,
            color_depth: 24,
            pixel_depth: 24,
            device_pixel_ratio: 1.0,
            inner_width: 1280,
            inner_height: 720,
            outer_width: 1920,
            outer_height: 1080,
            hardware_concurrency: 8,
            device_memory: 8.0,
            plugins: vec![
                PluginInfo {
                    name: "PDF Viewer".into(),
                    description: "Portable Document Format".into(),
                    filename: "internal-pdf-viewer".into(),
                    mime_types: vec!["application/pdf".into(), "text/pdf".into()],
                },
            ],
            fonts: vec![
                "Arial".into(), "Calibri".into(), "Cambria".into(),
                "Comic Sans MS".into(), "Consolas".into(), "Courier New".into(),
                "Georgia".into(), "Impact".into(), "Segoe UI".into(),
                "Times New Roman".into(), "Trebuchet MS".into(), "Verdana".into(),
            ],
            canvas_noise_seed: rand::random(),
            webgl_vendor: "Google Inc. (NVIDIA)".into(),
            webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)".into(),
            webgl_unmasked_vendor: "NVIDIA Corporation".into(),
            webgl_unmasked_renderer: "NVIDIA GeForce RTX 3070".into(),
            audio_noise_seed: rand::random(),
            proxy: None,
            spoofed_ip: None,
            do_not_track: Some(false),
            cookie_enabled: true,
            java_enabled: false,
            pdf_viewer_enabled: true,
            hide_webdriver: true,
            max_touch_points: 0,
        }
    }
}

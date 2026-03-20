/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! NightGlow — cloud-first stealth browser engine.
//!
//! Provides browser-profile management (fingerprint spoofing), a cooperative
//! acquire/release pool that prevents two concurrent sessions from sharing the
//! same fingerprint, a resource-tree builder that tracks analytics/tracking
//! requests a target site makes, and OpenTelemetry instrumentation.

pub mod profiles;
pub mod resource_tree;
pub mod telemetry;

pub use profiles::{BrowserProfile, ProfilePool};
pub use resource_tree::ResourceTree;
pub use telemetry::Telemetry;

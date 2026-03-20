/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Browser profile management.
//!
//! A [`BrowserProfile`] captures every observable fingerprint dimension.
//! The [`ProfilePool`] stores a collection of profiles and hands them out
//! via an acquire/release protocol so no two sessions ever share the same
//! fingerprint concurrently.

pub mod fingerprint;
pub mod pool;

pub use fingerprint::BrowserProfile;
pub use pool::ProfilePool;

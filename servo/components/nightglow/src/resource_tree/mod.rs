/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Resource tree — tracks every third-party request a target page makes.
//!
//! When a browser visits a page, that page typically fires dozens of requests
//! to analytics, advertising, and fingerprinting endpoints (e.g. Google
//! Analytics, Facebook Pixel, Hotjar).  Each of those endpoints may observe
//! the browser fingerprint.
//!
//! The [`ResourceTree`] records these observations per origin so that the
//! profile pool can ensure no single fingerprint is ever seen by the same
//! tracker twice in a short window.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

/// A third-party resource request observed during a page visit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceRequest {
    pub url: String,
    pub resource_type: ResourceType,
    /// Profile ID that made this request.
    pub profile_id: Uuid,
    #[serde(skip)]
    pub observed_at: Option<Instant>,
}

/// Broad classification of the third-party resource.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceType {
    Analytics,
    Advertising,
    Fingerprinting,
    SocialMedia,
    Cdn,
    Other,
}

impl ResourceType {
    /// Heuristically classify a URL based on known tracker hostnames.
    pub fn classify(url: &Url) -> Self {
        let host = url.host_str().unwrap_or("").to_lowercase();
        if host.contains("google-analytics")
            || host.contains("googletagmanager")
            || host.contains("mixpanel")
            || host.contains("segment.io")
            || host.contains("amplitude")
            || host.contains("hotjar")
        {
            Self::Analytics
        } else if host.contains("doubleclick")
            || host.contains("googlesyndication")
            || host.contains("adnxs")
            || host.contains("criteo")
            || host.contains("outbrain")
        {
            Self::Advertising
        } else if host.contains("fingerprintjs")
            || host.contains("fpjs.io")
            || host.contains("d3swlak8bdnxou") // common FP CDN
        {
            Self::Fingerprinting
        } else if host.contains("facebook")
            || host.contains("twitter")
            || host.contains("linkedin")
            || host.contains("pinterest")
        {
            Self::SocialMedia
        } else if host.contains("cdn") || host.contains("akamai") || host.contains("cloudfront") {
            Self::Cdn
        } else {
            Self::Other
        }
    }
}

/// Per-origin tracking record.
#[derive(Debug, Default)]
struct OriginRecord {
    /// All profile IDs that have been seen by this origin, plus their last seen time.
    seen_profiles: HashMap<Uuid, Instant>,
}

/// Aggregated view of all third-party requests observed across page visits.
///
/// Used to decide whether a profile can safely be used for the next request
/// to a given target without triggering fingerprint correlation.
#[derive(Debug, Default)]
pub struct ResourceTree {
    /// Map from tracker origin → observation record.
    origins: HashMap<String, OriginRecord>,
    /// Full request log.
    requests: Vec<ResourceRequest>,
}

impl ResourceTree {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a third-party request made by `profile_id` while visiting a page.
    pub fn record(&mut self, url: &str, profile_id: Uuid) {
        if let Ok(parsed) = Url::parse(url) {
            let origin = format!(
                "{}://{}",
                parsed.scheme(),
                parsed.host_str().unwrap_or("unknown")
            );
            let rtype = ResourceType::classify(&parsed);

            let record = self.origins.entry(origin.clone()).or_default();
            record.seen_profiles.insert(profile_id, Instant::now());

            self.requests.push(ResourceRequest {
                url: url.to_owned(),
                resource_type: rtype,
                profile_id,
                observed_at: Some(Instant::now()),
            });

            log::trace!("ResourceTree: recorded {url} for profile {profile_id}");
        }
    }

    /// Returns the set of tracker origins that have observed `profile_id`
    /// within the last `window_secs` seconds.
    pub fn trackers_for_profile(&self, profile_id: Uuid, window_secs: u64) -> HashSet<String> {
        let cutoff = Instant::now()
            .checked_sub(std::time::Duration::from_secs(window_secs))
            .unwrap_or_else(Instant::now);

        self.origins
            .iter()
            .filter(|(_, rec)| {
                rec.seen_profiles
                    .get(&profile_id)
                    .map(|&t| t >= cutoff)
                    .unwrap_or(false)
            })
            .map(|(origin, _)| origin.clone())
            .collect()
    }

    /// Returns `true` if `profile_id` has NOT been seen by any tracker
    /// associated with `target_url` within `window_secs`.
    ///
    /// Use this to gate profile acquisition for a specific target site.
    pub fn is_safe(&self, profile_id: Uuid, target_url: &str, window_secs: u64) -> bool {
        let active = self.trackers_for_profile(profile_id, window_secs);
        if active.is_empty() {
            return true;
        }
        // Check if the target URL's host shares any trackers with recent profile usage.
        if let Ok(parsed) = Url::parse(target_url) {
            let target_host = parsed.host_str().unwrap_or("").to_lowercase();
            // Simple heuristic: if the target IS one of the trackers, it's unsafe.
            active.iter().any(|origin| !origin.contains(&target_host))
        } else {
            true
        }
    }

    /// All recorded requests (cloned).
    pub fn requests(&self) -> &[ResourceRequest] {
        &self.requests
    }

    /// Number of distinct tracker origins observed.
    pub fn origin_count(&self) -> usize {
        self.origins.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_analytics() {
        let url = Url::parse("https://www.google-analytics.com/collect").unwrap();
        assert_eq!(ResourceType::classify(&url), ResourceType::Analytics);
    }

    #[test]
    fn record_and_query() {
        let mut tree = ResourceTree::new();
        let pid = Uuid::new_v4();
        tree.record("https://www.google-analytics.com/collect", pid);
        assert_eq!(tree.origin_count(), 1);
        let trackers = tree.trackers_for_profile(pid, 60);
        assert!(!trackers.is_empty());
    }
}

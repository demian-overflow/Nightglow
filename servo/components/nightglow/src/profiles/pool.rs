/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Profile pool with cooperative acquire/release.
//!
//! [`ProfilePool`] holds a set of [`BrowserProfile`]s and tracks which ones
//! are currently in use.  [`acquire`] blocks until a profile is available,
//! ensuring no two sessions ever share the same fingerprint concurrently.

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::sync::Notify;
use uuid::Uuid;

use super::fingerprint::BrowserProfile;

/// Thread-safe pool of browser profiles.
#[derive(Clone)]
pub struct ProfilePool {
    inner: Arc<PoolInner>,
}

struct PoolInner {
    profiles: Vec<BrowserProfile>,
    in_use: Mutex<HashSet<Uuid>>,
    notify: Notify,
}

/// RAII guard returned by [`ProfilePool::acquire`].
///
/// Releases the profile back to the pool when dropped.
pub struct AcquiredProfile {
    pool: Arc<PoolInner>,
    pub profile: BrowserProfile,
}

impl Drop for AcquiredProfile {
    fn drop(&mut self) {
        self.pool.in_use.lock().remove(&self.profile.id);
        self.pool.notify.notify_waiters();
        log::debug!("Released profile {}", self.profile.id);
    }
}

impl ProfilePool {
    /// Create a pool from an existing list of profiles.
    pub fn new(profiles: Vec<BrowserProfile>) -> Self {
        Self {
            inner: Arc::new(PoolInner {
                profiles,
                in_use: Mutex::new(HashSet::new()),
                notify: Notify::new(),
            }),
        }
    }

    /// Build a pool with `n` auto-generated Chrome/Win11 profiles.
    pub fn with_generated(n: usize) -> Self {
        let profiles = (0..n)
            .map(|i| {
                let mut p = BrowserProfile::chrome_win11_us();
                p.label = format!("auto-{i:03}");
                p
            })
            .collect();
        Self::new(profiles)
    }

    /// Add a profile to the pool.
    pub fn add(&mut self, profile: BrowserProfile) {
        Arc::get_mut(&mut self.inner)
            .expect("cannot add profiles to a shared pool")
            .profiles
            .push(profile);
    }

    /// Total number of profiles in the pool.
    pub fn len(&self) -> usize {
        self.inner.profiles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.profiles.is_empty()
    }

    /// Number of profiles currently in use.
    pub fn in_use_count(&self) -> usize {
        self.inner.in_use.lock().len()
    }

    /// Number of profiles available right now.
    pub fn available_count(&self) -> usize {
        self.len() - self.in_use_count()
    }

    /// Acquire an available profile.
    ///
    /// Returns immediately if one is free; otherwise waits until a profile
    /// is released.  Profiles are selected in order of their index so the
    /// pool is deterministic under low load.
    pub async fn acquire(&self) -> AcquiredProfile {
        loop {
            {
                let mut in_use = self.inner.in_use.lock();
                if let Some(profile) = self
                    .inner
                    .profiles
                    .iter()
                    .find(|p| !in_use.contains(&p.id))
                {
                    in_use.insert(profile.id);
                    log::debug!("Acquired profile {}", profile.id);
                    return AcquiredProfile {
                        pool: Arc::clone(&self.inner),
                        profile: profile.clone(),
                    };
                }
            }
            // All profiles are busy — wait for a release notification.
            self.inner.notify.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_and_release() {
        let pool = ProfilePool::with_generated(2);
        assert_eq!(pool.available_count(), 2);

        let a = pool.acquire().await;
        assert_eq!(pool.available_count(), 1);

        let b = pool.acquire().await;
        assert_eq!(pool.available_count(), 0);

        // Different profiles were handed out.
        assert_ne!(a.profile.id, b.profile.id);

        drop(a);
        assert_eq!(pool.available_count(), 1);
    }

    #[tokio::test]
    async fn acquire_waits_for_release() {
        use tokio::time::{timeout, Duration};

        let pool = ProfilePool::with_generated(1);
        let guard = pool.acquire().await;

        let pool2 = pool.clone();
        let waiter = tokio::spawn(async move { pool2.acquire().await });

        // Release after a short delay.
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(guard);

        let acquired = timeout(Duration::from_secs(1), waiter)
            .await
            .expect("timed out")
            .expect("task panicked");
        drop(acquired);
    }
}

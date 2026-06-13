# UniFi Topology v1.0.2

## Summary

This release fixes UniFi OS release-note links and improves release-link performance.

UniFi OS release notes are hardware-family specific. The same UniFi OS version can have different Community UI release pages for Dream Machines, Cloud Gateways, Cloud Keys, Express, Dream Wall, Enterprise Network Video Recorders, and other UniFi OS device families.

For Dream Machine-class gateways such as the UDM Beast, UniFi Topology now resolves the UniFi OS version bubble to the correct Dream Machines release page instead of sending the user to a generic Community UI search page.

## Changes

- Fixed UniFi OS version bubble links so they resolve to the correct hardware-family-specific release page.
- Added support for UniFi OS release families including Dream Machines, Cloud Gateways, Cloud Keys, Express, Dream Wall, Enterprise Network Video Recorders, and NAS-style UniFi OS devices.
- Added headless Chromium release lookup fallback to discover the correct UniFi Community release URL when the standard release service does not return a direct result.
- Added persistent local release URL caching with `data/releaseUrlCache.json`.
- Improved release-link click speed after the first successful lookup.
- Prevented older UniFi OS release UUIDs from being reused after a version change by including the version and hardware-family slug in the cache key.
- Failed release lookups are not cached, allowing the app to retry later if UniFi Community indexing is delayed.
- Left UniFi authentication/session behavior unchanged.

## Notes

The first lookup for a new UniFi OS version may take several seconds because the app may need to launch Chromium, search UniFi Community, and extract the correct UUID-backed release URL.

After the URL is cached, future clicks should redirect almost instantly.

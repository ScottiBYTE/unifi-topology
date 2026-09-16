# UniFi Topology v1.1.1

## Summary

This patch release expands UniFi gateway discovery for self-hosted UniFi OS Server, UniFi Network controller, and integrated Cloud Gateway environments.

A UXG-Lite managed by a self-hosted UniFi OS Server was reported by the UniFi API with device type `uxg` and model code `UXG`. Earlier releases recognized only the legacy `ugw` and integrated `udm` device types. This caused the topology to display **Gateway not found** even though the gateway was adopted and online.

Version 1.1.1 replaces that narrow check with gateway-type, model-family, and capability-based detection.

## Changes

- Added support for the `uxg` API device type used by independent gateways such as the UXG-Lite.
- Added recognized API types for current UniFi gateway families.
- Added model-family detection for:
  - Dream Machine (`UDM`)
  - Dream Router (`UDR`)
  - Dream Wall (`UDW`)
  - Cloud Gateway (`UCG`)
  - Independent UniFi Gateway (`UXG`)
  - Enterprise Fortress Gateway (`EFG`)
  - UniFi Express (`UX`)
- Added fallback detection using WAN and gateway system-statistics fields.
- Updated gateway model formatting for unfamiliar API device types.
- Preserved existing `ugw` and `udm` detection.
- Left authentication, topology construction, and configuration behavior unchanged.

## Compatibility

The updated detection supports integrated UniFi Cloud Gateways and independently managed gateways connected to a self-hosted UniFi OS Server or UniFi Network controller.

Gateway discovery no longer requires a separate code entry for every individual gateway SKU. New models within known gateway families can be recognized from their family prefix. Gateway-specific API capabilities provide an additional fallback.

## Configuration

No configuration changes are required. Existing `data/config.json` files continue to work without modification.

## Reported issue resolved

The reported device returned:

    Name: UXG Lite
    Type: uxg
    Model code: UXG
    Status: Online

Earlier releases returned:

    "gatewayCount": 0

Version 1.1.1 returns:

    "gatewayCount": 1

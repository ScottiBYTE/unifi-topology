# ScottiBYTE UniFi Topology

ScottiBYTE UniFi Topology is a self-hosted web utility for visualizing a UniFi network as an interactive topology map.

It maps the WAN, gateway, switches, access points, port groups, ports, wired clients, wireless clients, SSIDs, and optional Incus service inventory.

## Features

- UniFi gateway, switch, AP, port, and client topology mapping
- Physical topology view
- Client-expanded topology view
- Optional Incus service overlay using Blast Radius inventory
- Light and dark mode
- GitHub and PayPal donate links
- UniFi OS and Network version badges with release-note links
- HTML export for offline documentation
- Summary and legend panels

## Version

Current release: **v1.0.0**

## Requirements

- Node.js 20 or newer, or Docker
- UniFi Network controller access
- A local `data/config.json` file based on `config.example.json`

## Configuration

Copy the example config:

```bash
cp config.example.json data/config.json

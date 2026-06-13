const express = require("express");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const https = require("https");

let puppeteer = null;
try {
  puppeteer = require("puppeteer-core");
} catch {
  puppeteer = null;
}


const app = express();

const CONFIG_PATH = path.join(__dirname, "data", "config.json");
const RELEASE_URL_CACHE_FILE = path.join(__dirname, "data", "releaseUrlCache.json");

let unifiSession = {
  cookieHeader: null,
  createdAt: 0,
  lastLoginStatus: null,
  lastLoginMessage: null
};

const SESSION_MAX_AGE_MS = 20 * 60 * 1000;

const HEADLESS_RELEASE_CACHE_MS = 12 * 60 * 60 * 1000;
let headlessReleaseCache = {};


function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config file: ${CONFIG_PATH}`);
    console.error("Copy config.example.json to data/config.json and edit it.");
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read config file: ${err.message}`);
    process.exit(1);
  }
}

const config = loadConfig();
const PORT = config.port || process.env.PORT || 3051;

function makeUnifiClient() {
  const unifi = config.unifi || {};
  const baseURL = (unifi.gatewayHost || "").replace(/\/+$/, "");

  if (!baseURL) {
    throw new Error("Missing unifi.gatewayHost in data/config.json");
  }

  const httpsAgent = new https.Agent({
    rejectUnauthorized: !unifi.insecureSSL
  });

  return axios.create({
    baseURL,
    httpsAgent,
    timeout: 15000,
    validateStatus: () => true,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  });
}

function sessionIsValid() {
  if (!unifiSession.cookieHeader) return false;
  return Date.now() - unifiSession.createdAt < SESSION_MAX_AGE_MS;
}

function clearUnifiSession() {
  unifiSession = {
    cookieHeader: null,
    createdAt: 0,
    lastLoginStatus: null,
    lastLoginMessage: null
  };
}

async function loginUnifi(force = false) {
  const unifi = config.unifi || {};
  const client = makeUnifiClient();

  if (!force && sessionIsValid()) {
    return {
      ok: true,
      reused: true,
      status: unifiSession.lastLoginStatus || 200,
      statusText: "Cached Session",
      cookieHeader: unifiSession.cookieHeader,
      hasCookies: true,
      client
    };
  }

  if (!unifi.username || !unifi.password) {
    throw new Error("Missing UniFi username or password in data/config.json");
  }

  const loginPayload = {
    username: unifi.username,
    password: unifi.password,
    remember: false
  };

  const loginResponse = await client.post("/api/auth/login", loginPayload);
  const cookies = loginResponse.headers["set-cookie"] || [];
  const cookieHeader = cookies.map(cookie => cookie.split(";")[0]).join("; ");

  if (loginResponse.status === 429) {
    unifiSession.lastLoginStatus = 429;
    unifiSession.lastLoginMessage = "UniFi login rate limited. Wait a few minutes before retrying.";
    return {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      message: unifiSession.lastLoginMessage,
      hasCookies: cookies.length > 0
    };
  }

  if (loginResponse.status < 200 || loginResponse.status >= 300) {
    unifiSession.lastLoginStatus = loginResponse.status;
    unifiSession.lastLoginMessage = `Login failed: ${loginResponse.status} ${loginResponse.statusText}`;
    return {
      ok: false,
      status: loginResponse.status,
      statusText: loginResponse.statusText,
      message: "Login request failed",
      hasCookies: cookies.length > 0
    };
  }

  if (!cookieHeader) {
    unifiSession.lastLoginStatus = loginResponse.status;
    unifiSession.lastLoginMessage = "Login succeeded but no session cookie was returned.";
    return {
      ok: false,
      status: loginResponse.status,
      statusText: loginResponse.statusText,
      message: unifiSession.lastLoginMessage,
      hasCookies: false
    };
  }

  unifiSession.cookieHeader = cookieHeader;
  unifiSession.createdAt = Date.now();
  unifiSession.lastLoginStatus = loginResponse.status;
  unifiSession.lastLoginMessage = "Login succeeded";

  return {
    ok: true,
    reused: false,
    status: loginResponse.status,
    statusText: loginResponse.statusText,
    cookieHeader,
    hasCookies: true,
    client
  };
}

async function unifiGet(pathname) {
  let login = await loginUnifi(false);

  if (!login.ok) {
    throw new Error(`UniFi login failed: ${login.status} ${login.statusText}`);
  }

  let response = await login.client.get(pathname, {
    headers: {
      Cookie: login.cookieHeader
    }
  });

  if (response.status === 401 || response.status === 403) {
    clearUnifiSession();
    login = await loginUnifi(true);

    if (!login.ok) {
      throw new Error(`UniFi re-login failed: ${login.status} ${login.statusText}`);
    }

    response = await login.client.get(pathname, {
      headers: {
        Cookie: login.cookieHeader
      }
    });
  }

  return response;
}

async function getUnifiDevices() {
  const site = config.unifi?.site || "default";
  const response = await unifiGet(`/proxy/network/api/s/${site}/stat/device`);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to retrieve UniFi devices: ${response.status} ${response.statusText}`);
  }

  return response.data?.data || [];
}

async function getUnifiClients() {
  const site = config.unifi?.site || "default";
  const response = await unifiGet(`/proxy/network/api/s/${site}/stat/sta`);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to retrieve UniFi clients: ${response.status} ${response.statusText}`);
  }

  return response.data?.data || [];
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}


function firstNonEmptyText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;

    const text = String(value).trim();
    if (text) return text;
  }

  return "";
}

function extractSwitchPorts(device) {
  const table = Array.isArray(device.port_table) ? device.port_table : [];
  const overrides = Array.isArray(device.port_overrides) ? device.port_overrides : [];

  const overrideByPort = new Map();

  for (const override of overrides) {
    const portNumber = firstNonEmptyText(
      override.port_idx,
      override.port,
      override.port_number,
      override.ifindex,
      override.num_port
    );

    if (portNumber) overrideByPort.set(String(portNumber), override);
  }

  return table
    .map(port => {
      const portNumber = firstNonEmptyText(
        port.port_idx,
        port.port,
        port.port_number,
        port.ifindex,
        port.num_port
      );

      if (!portNumber) return null;

      const override = overrideByPort.get(String(portNumber)) || {};

      const configuredName = firstNonEmptyText(
        override.name,
        override.portconf_name,
        override.port_name,
        override.label,
        override.port_label,
        port.name,
        port.portconf_name,
        port.port_name,
        port.label,
        port.port_label
      );

      const lldpName = firstNonEmptyText(
        port.lldp?.chassis_name,
        port.lldp?.system_name,
        port.lldp?.name,
        port.lldp_table?.[0]?.chassis_name,
        port.lldp_table?.[0]?.system_name,
        port.lldp_table?.[0]?.name,
        port.remote_system_name,
        port.remote_name,
        port.neighbor_name,
        port.connected_device_name,
        port.connected_device?.name
      );

      const connectedName = firstNonEmptyText(
        port.up_name,
        port.downlink_table?.[0]?.name,
        port.downlink_table?.[0]?.device_name,
        port.uplink_device_name,
        port.uplink?.device_name
      );

      const displayName = firstNonEmptyText(configuredName, lldpName, connectedName);

      return {
        port: Number.isFinite(Number(portNumber)) ? Number(portNumber) : String(portNumber),
        name: displayName || null,
        configuredName: configuredName || null,
        lldpName: lldpName || null,
        connectedName: connectedName || null,
        up: Boolean(port.up),
        enabled: port.enable !== false,
        speed: firstNonEmpty(port.speed, port.speed_caps, port.op_mode),
        poeMode: firstNonEmpty(port.poe_mode, port.poe_caps),
        media: firstNonEmpty(port.media, port.media_type),
        isUplink: Boolean(port.is_uplink || port.uplink || port.upstream)
      };
    })
    .filter(Boolean);
}


function normalizeMac(mac) {
  return String(mac || "").trim().toLowerCase();
}

function deviceName(device) {
  return firstNonEmpty(device.name, device.hostname, device.display_name, device.model, "Unnamed Device");
}

function clientName(client) {
  return firstNonEmpty(client.name, client.hostname, client.display_name, client.dns_name, client.mac, "Unnamed Client");
}

function deviceIp(device) {
  return firstNonEmpty(device.ip, device.gateway_ip, device.connect_request_ip);
}

function clientIp(client) {
  return firstNonEmpty(client.ip, client.fixed_ip);
}

function rawDeviceModel(device) {
  return firstNonEmpty(device.model, device.model_name, device.model_in_lts, "Unknown Model");
}

function friendlyModelName(modelCode, deviceType = null) {
  const code = String(modelCode || "").trim();
  const normalized = code.toLowerCase();

  const gatewayModelMap = {
    "udm": "Dream Machine",
    "udm-base": "Dream Machine",
    "udmpro": "Dream Machine Pro",
    "udm-pro": "Dream Machine Pro",
    "udmse": "Dream Machine Special Edition",
    "udm-se": "Dream Machine Special Edition",
    "udmpromax": "Dream Machine Pro Max",
    "udm-pro-max": "Dream Machine Pro Max",
    "udm-beast": "Dream Machine Beast",
    "udmbeast": "Dream Machine Beast",
    "udmea4c": "Dream Machine Beast",
    "udr": "Dream Router",
    "udr7": "Dream Router 7",
    "udr-7": "Dream Router 7",
    "udw": "Dream Wall",
    "udw-pro": "Dream Wall Pro",
    "ux": "UniFi Express",
    "ux7": "UniFi Express 7",
    "ux-7": "UniFi Express 7",
    "ucg": "Cloud Gateway",
    "ucg-ultra": "Cloud Gateway Ultra",
    "ucgultra": "Cloud Gateway Ultra",
    "ucg-max": "Cloud Gateway Max",
    "ucgmax": "Cloud Gateway Max",
    "ucg-fiber": "Cloud Gateway Fiber",
    "ucgfiber": "Cloud Gateway Fiber",
    "uxg": "UniFi Gateway",
    "uxg-lite": "Gateway Lite",
    "uxglite": "Gateway Lite",
    "uxg-max": "Gateway Max",
    "uxgmax": "Gateway Max",
    "uxg-fiber": "Gateway Fiber",
    "uxgfiber": "Gateway Fiber",
    "uxg-pro": "Gateway Pro",
    "uxgpro": "Gateway Pro",
    "uxg-enterprise": "Gateway Enterprise",
    "uxgenterprise": "Gateway Enterprise",
    "efg": "Enterprise Fortress Gateway",
    "efg-enterprise": "Enterprise Fortress Gateway"
  };

  const generalModelMap = {
    "us8p60": "UniFi Switch 8 PoE 60W",
    "us48pro": "UniFi Switch Pro 48",
    "us624p": "UniFi Switch 24 PoE",
    "us68p": "UniFi Switch 8 PoE",
    "uswed77": "UniFi Switch Enterprise / 10G Class",
    "u6ent": "UniFi U6 Enterprise",
    "ualr6v2": "UniFi Access Point",
    "up1": "UniFi SmartPower Plug"
  };

  let friendly = null;

  if (deviceType === "ugw" || deviceType === "udm") {
    friendly = gatewayModelMap[normalized];
  }

  if (!friendly) {
    friendly = gatewayModelMap[normalized] || generalModelMap[normalized];
  }

  if (friendly) return `${friendly} (${code})`;
  if (deviceType === "ugw" || deviceType === "udm") return `UniFi Gateway (${code || "Unknown Model"})`;

  return code || "Unknown Model";
}

function deviceModel(device) {
  return friendlyModelName(rawDeviceModel(device), device.type);
}

function displayDeviceModel(device) {
  const friendly = friendlyModelName(rawDeviceModel(device), device.type);

  // Hide raw model codes from the user-facing UI when we have a friendly name.
  return String(friendly || "")
    .replace(/\s*\([A-Z0-9_-]+\)\s*$/i, "")
    .trim() || friendly;
}


function deviceModelCode(device) {
  return rawDeviceModel(device);
}

function deviceStatus(device) {
  if (device.state === 1) return "Online";
  if (device.state === 0) return "Offline";
  return "Unknown";
}

function isGateway(device) {
  return device.type === "ugw" || device.type === "udm";
}

function isSwitch(device) {
  return device.type === "usw";
}

function isSmartPowerDevice(device) {
  return device.model === "UP1";
}

function isAccessPoint(device) {
  return device.type === "uap" && !isSmartPowerDevice(device);
}

function textHasUbiquitiVendor(text) {
  const normalized = String(text || "").toLowerCase();
  return normalized.includes("ubiquiti") || normalized.includes("ui.com") || normalized.includes("ubnt");
}

function isLikelyUnifiHardwareClient(client) {
  const vendorFields = [client.manufacturer, client.oui, client.dev_vendor, client.dev_family];

  if (vendorFields.some(textHasUbiquitiVendor)) return true;

  const modelFields = [client.model, client.os_name, client.dev_cat]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    modelFields.includes("unifi") ||
    modelFields.includes("ubiquiti") ||
    modelFields.includes("protect") ||
    modelFields.includes("talk") ||
    modelFields.includes("ai key") ||
    modelFields.includes("superlink") ||
    modelFields.includes("super link")
  );
}

function summarizeNetworkDevice(device) {
  return {
    id: device._id || device.mac || null,
    name: deviceName(device),
    type: device.type || null,
    model: displayDeviceModel(device),
    modelCode: deviceModelCode(device),
    mac: device.mac || null,
    ip: deviceIp(device),
    version: device.version || null,
    status: deviceStatus(device),
    adopted: device.adopted ?? null,
    uplinkDeviceName: device.uplink?.device_name || null,
    uplinkDeviceMac: normalizeMac(device.uplink?.uplink_mac || device.uplink?.mac),
    uplinkPort: firstNonEmpty(device.uplink?.uplink_port, device.uplink?.port_idx),
    portCount: Array.isArray(device.port_table) ? device.port_table.length : null,
    ports: extractSwitchPorts(device)
  };
}


function summarizeGateway(device) {
  return {
    id: device._id || device.mac || null,
    name: deviceName(device),
    model: displayDeviceModel(device),
    modelCode: deviceModelCode(device),
    mac: device.mac || null,
    ip: deviceIp(device),
    wanIp: firstNonEmpty(device.wan1?.ip, device.wan2?.ip, device.wan_ip, device.ip),
    primaryLanGateway: config.unifi?.primaryLanGateway || null,
    version: device.version || null,
    status: deviceStatus(device)
  };
}

function meaningfulClientModel(client) {
  const candidates = [
    client.model,
    client.os_name,
    client.dev_family
  ];

  for (const value of candidates) {
    if (value === null || value === undefined || value === "") continue;

    const text = String(value).trim();

    // UniFi sometimes reports numeric category codes such as 1 or 42.
    // Those are not useful as user-facing model names.
    if (/^\d+$/.test(text)) continue;

    return text;
  }

  return null;
}

function summarizeClient(client) {
  return {
    id: client._id || client.mac || null,
    name: clientName(client),
    mac: client.mac || null,
    ip: clientIp(client),
    connectionType: client.is_wired ? "wired" : "wireless",
    wired: !!client.is_wired,
    wireless: !client.is_wired,
    network: firstNonEmpty(client.network, client.network_name),
    ssid: firstNonEmpty(client.essid, client.ssid),
    apMac: normalizeMac(client.ap_mac),
    swMac: normalizeMac(client.sw_mac),
    switchMac: normalizeMac(client.sw_mac),
    switchPort: firstNonEmpty(client.sw_port, client.port_idx),
    vlan: client.vlan || null,
    signal: client.signal || null,
    uptime: client.uptime || null,
    lastSeen: client.last_seen || null,
    manufacturer: firstNonEmpty(client.manufacturer, client.oui, client.dev_vendor),
    model: meaningfulClientModel(client),
    clientCategoryCode: client.dev_cat || null
  };
}

function summarizeClientDiscovery(client) {
  return {
    name: client.name || null,
    hostname: client.hostname || null,
    displayName: client.display_name || null,
    dnsName: client.dns_name || null,
    ip: client.ip || client.fixed_ip || null,
    mac: client.mac || null,
    manufacturer: client.manufacturer || null,
    oui: client.oui || null,
    model: client.model || null,
    osName: client.os_name || null,
    devCat: client.dev_cat || null,
    devFamily: client.dev_family || null,
    devVendor: client.dev_vendor || null,
    isWired: !!client.is_wired,
    switchMac: client.sw_mac || null,
    switchPort: client.sw_port || client.port_idx || null,
    apMac: client.ap_mac || null,
    ssid: client.essid || client.ssid || null,
    network: client.network || client.network_name || null,
    vlan: client.vlan || null
  };
}

function makeEmptyDeviceNode(device, kind) {
  return {
    ...device,
    kind,
    childSwitches: [],
    accessPoints: [],
    smartDevices: [],
    wiredClients: [],
    wirelessBySsid: {}
  };
}

function addWirelessToAp(apNode, client) {
  const ssid = client.ssid || "Unknown SSID";
  if (!apNode.wirelessBySsid[ssid]) apNode.wirelessBySsid[ssid] = [];
  apNode.wirelessBySsid[ssid].push(client);
}

function sortByPortThenName(a, b) {
  const pa = Number(a.uplinkPort || a.switchPort || 99999);
  const pb = Number(b.uplinkPort || b.switchPort || 99999);
  if (pa !== pb) return pa - pb;
  return String(a.name || "").localeCompare(String(b.name || ""));
}

function sortClientByPortThenName(a, b) {
  const pa = Number(a.switchPort || 99999);
  const pb = Number(b.switchPort || 99999);
  if (pa !== pb) return pa - pb;
  return String(a.name || "").localeCompare(String(b.name || ""));
}

function buildPhysicalTopology(gateway, switches, accessPoints, smartDevices, wiredClients, wirelessClients) {
  const switchNodesByMac = new Map();
  const apNodesByMac = new Map();

  for (const sw of switches) {
    switchNodesByMac.set(normalizeMac(sw.mac), makeEmptyDeviceNode(sw, "switch"));
  }

  for (const ap of accessPoints) {
    apNodesByMac.set(normalizeMac(ap.mac), makeEmptyDeviceNode(ap, "accessPoint"));
  }

  const rootSwitches = [];

  for (const sw of switches) {
    const node = switchNodesByMac.get(normalizeMac(sw.mac));
    const parentMac = normalizeMac(sw.uplinkDeviceMac);

    if (parentMac && switchNodesByMac.has(parentMac)) {
      switchNodesByMac.get(parentMac).childSwitches.push(node);
    } else {
      rootSwitches.push(node);
    }
  }

  for (const ap of accessPoints) {
    const node = apNodesByMac.get(normalizeMac(ap.mac));
    const parentMac = normalizeMac(ap.uplinkDeviceMac);

    if (parentMac && switchNodesByMac.has(parentMac)) {
      switchNodesByMac.get(parentMac).accessPoints.push(node);
    }
  }

  for (const smart of smartDevices) {
    const parentMac = normalizeMac(smart.uplinkDeviceMac);

    if (parentMac && switchNodesByMac.has(parentMac)) {
      switchNodesByMac.get(parentMac).smartDevices.push(smart);
    }
  }

  for (const client of wiredClients) {
    const parentMac = normalizeMac(client.switchMac);

    if (parentMac && switchNodesByMac.has(parentMac)) {
      switchNodesByMac.get(parentMac).wiredClients.push(client);
    }
  }

  for (const client of wirelessClients) {
    const apMac = normalizeMac(client.apMac);

    if (apMac && apNodesByMac.has(apMac)) {
      addWirelessToAp(apNodesByMac.get(apMac), client);
    }
  }

  const normalizeNode = node => {
    node.childSwitches.sort(sortByPortThenName);
    node.accessPoints.sort(sortByPortThenName);
    node.smartDevices.sort(sortByPortThenName);
    node.wiredClients.sort(sortClientByPortThenName);

    for (const child of node.childSwitches) normalizeNode(child);

    for (const ap of node.accessPoints) {
      const sorted = {};
      for (const ssid of Object.keys(ap.wirelessBySsid).sort()) {
        sorted[ssid] = ap.wirelessBySsid[ssid].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
      }
      ap.wirelessBySsid = sorted;
    }

    return node;
  };

  rootSwitches.sort(sortByPortThenName).forEach(normalizeNode);

  const assignedApMacs = new Set();
  for (const root of rootSwitches) {
    const walk = node => {
      for (const ap of node.accessPoints) assignedApMacs.add(normalizeMac(ap.mac));
      for (const child of node.childSwitches) walk(child);
    };
    walk(root);
  }

  const orphanAccessPoints = Array.from(apNodesByMac.values())
    .filter(ap => !assignedApMacs.has(normalizeMac(ap.mac)))
    .sort(sortByPortThenName);

  return {
    gateway,
    rootSwitches,
    orphanAccessPoints
  };
}




function releaseVersionDash(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .replace(/\./g, "-");
}

function getGatewayModelText(context = {}) {
  return [
    context.gatewayModel,
    context.gatewayModelCode,
    context.gatewayName
  ].filter(Boolean).join(" ").toLowerCase();
}

function unifiOsReleaseFamily(version, context = {}) {
  const vDash = releaseVersionDash(version);
  const modelText = getGatewayModelText(context);
  const v = String(version || "").trim();

  if (!vDash) return null;

  // UniFi OS release notes are hardware-family specific.
  // The same UniFi OS version can have different UUIDs for different gateway families.
  if (modelText.includes("dream wall") || modelText.includes("udw")) {
    return {
      slug: `UniFi-OS-Dream-Wall-${vDash}`,
      title: `UniFi OS - Dream Wall ${v}`
    };
  }

  if (
    modelText.includes("unvr") ||
    modelText.includes("network video recorder") ||
    modelText.includes("enterprise network video")
  ) {
    return {
      slug: `UniFi-OS-Enterprise-Network-Video-Recorders-${vDash}`,
      title: `UniFi OS - Enterprise Network Video Recorders ${v}`
    };
  }

  if (
    modelText.includes("nas") ||
    modelText.includes("network attached storage")
  ) {
    return {
      slug: `UniFi-OS-Network-Attached-Storage-${vDash}`,
      title: `UniFi OS - Network Attached Storage ${v}`
    };
  }

  if (
    modelText.includes("uck") ||
    modelText.includes("cloud key")
  ) {
    return {
      slug: `UniFi-OS-Cloud-Keys-${vDash}`,
      title: `UniFi OS - Cloud Keys ${v}`
    };
  }

  if (
    modelText.includes("ucg") ||
    modelText.includes("uxg") ||
    modelText.includes("cloud gateway")
  ) {
    return {
      slug: `UniFi-OS-Cloud-Gateways-${vDash}`,
      title: `UniFi OS - Cloud Gateways ${v}`
    };
  }

  if (
    modelText.includes("ux") ||
    modelText.includes("express")
  ) {
    return {
      slug: `UniFi-OS-Express-${vDash}`,
      title: `UniFi OS - Express ${v}`
    };
  }

  if (
    modelText.includes("udm") ||
    modelText.includes("dream") ||
    modelText.includes("udmea") ||
    modelText.includes("udmea4c")
  ) {
    return {
      slug: `UniFi-OS-Dream-Machines-${vDash}`,
      title: `UniFi OS - Dream Machines ${v}`
    };
  }

  // Scott's gateway is Dream Machine-class, so this fallback is preferable
  // to resolving to the wrong UniFi OS family.
  return {
    slug: `UniFi-OS-Dream-Machines-${vDash}`,
    title: `UniFi OS - Dream Machines ${v}`
  };
}

function releaseSvcPaths(appName, version, context = {}) {
  const v = String(version || "").trim();
  if (!v || v === "-" || v.toLowerCase() === "n/a" || v.toLowerCase() === "unknown") return [];

  const encoded = encodeURIComponent(v);

  // community.svc.ui.com no longer works reliably for UniFi OS family lookups.
  // Keep it only for app release lookups.
  const map = {
    network: ["network"],
    protect: ["protect"],
    talk: ["talk"],
    access: ["access"]
  };

  return (map[appName] || [])
    .map(slug => `https://community.svc.ui.com/releases/${slug}/${encoded}`);
}

function unifiOsReleaseTitleSlugs(version, context = {}) {
  const family = unifiOsReleaseFamily(version, context);
  return family ? [family.slug] : [];
}

function browserReleaseTitleSlug(appName, version, context = {}) {
  const vDash = releaseVersionDash(version);
  if (!vDash) return "";

  if (appName === "unifiOS") {
    return unifiOsReleaseTitleSlugs(version, context)[0] || "";
  }

  const map = {
    network: `UniFi-Network-Application-${vDash}`,
    protect: `UniFi-Protect-Application-${vDash}`,
    talk: `UniFi-Talk-Application-${vDash}`,
    access: `UniFi-Access-Application-${vDash}`
  };

  return map[appName] || "";
}

function withTimeout(promise, ms, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

function chromiumExecutablePath() {
  const candidates = [
    process.env.CHROMIUM_EXECUTABLE,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return candidates[0] || "/usr/bin/chromium";
}

function normalizeReleaseText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalReleaseUrl(rawHref, slug) {
  if (!rawHref || !slug) return null;

  let url;
  try {
    url = new URL(rawHref, "https://community.ui.com");
  } catch {
    return null;
  }

  if (url.hash && url.hash.includes("comment")) return null;

  const uuidMatch = url.pathname.match(/\/releases\/(?:[^/]+\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!uuidMatch) return null;

  return `https://community.ui.com/releases/${slug}/${uuidMatch[1]}`;
}

async function resolveReleaseUrlWithHeadlessBrowser(appName, version, context = {}) {
  if (!puppeteer) return null;

  const cacheKey = `${appName}:${String(version || "").trim()}:${getGatewayModelText(context)}`;
  const cached = headlessReleaseCache[cacheKey];

  if (cached && Date.now() - cached.ts < HEADLESS_RELEASE_CACHE_MS) {
    return cached.url;
  }

  let targets = [];

  if (appName === "unifiOS") {
    const family = unifiOsReleaseFamily(version, context);
    if (!family) return null;
    targets = [family];
  } else {
    const slug = browserReleaseTitleSlug(appName, version, context);
    if (!slug) return null;

    const titleMap = {
      network: `UniFi Network Application ${String(version).trim()}`,
      protect: `UniFi Protect Application ${String(version).trim()}`,
      talk: `UniFi Talk Application ${String(version).trim()}`,
      access: `UniFi Access Application ${String(version).trim()}`
    };

    targets = [{
      slug,
      title: titleMap[appName] || slug.replace(/-/g, " ")
    }];
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      executablePath: chromiumExecutablePath(),
      headless: true,
      pipe: true,
      dumpio: false,
      protocolTimeout: 60000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-crash-reporter",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-default-apps",
        "--no-first-run",
        "--no-zygote",
        "--single-process"
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    );

    for (const target of targets) {
      const expectedNormalized = normalizeReleaseText(target.title);

      await page.goto("https://community.ui.com/releases", {
        waitUntil: "networkidle2",
        timeout: 45000
      });

      await new Promise(resolve => setTimeout(resolve, 4000));

      await page.focus("input[type='search']");
      await page.keyboard.down("Control");
      await page.keyboard.press("A");
      await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(target.title, { delay: 35 });

      await new Promise(resolve => setTimeout(resolve, 12000));

      const href = await page.evaluate(expectedNormalized => {
        const normalize = value => String(value || "")
          .toLowerCase()
          .replace(/&/g, " and ")
          .replace(/[^a-z0-9]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        const uuidRelease = href =>
          /\/releases\/(?:[^/]+\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(href || "").split("#")[0]);

        const candidates = Array.from(document.querySelectorAll("a[href*='/releases/']"))
          .map(a => {
            const card = a.closest("article, li, section, div");
            const ownText = [
              a.innerText,
              a.textContent,
              a.getAttribute("aria-label"),
              a.getAttribute("title")
            ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

            const cardText = card
              ? String(card.innerText || "").replace(/\s+/g, " ").trim()
              : "";

            return {
              href: String(a.href || "").split("#")[0],
              normalizedOwnText: normalize(ownText),
              normalizedCardText: normalize(cardText)
            };
          })
          .filter(item =>
            item.href &&
            !item.href.includes("#comment") &&
            uuidRelease(item.href)
          );

        let exact = candidates.find(item =>
          item.normalizedOwnText === expectedNormalized ||
          item.normalizedOwnText.startsWith(`${expectedNormalized} `) ||
          item.normalizedCardText === expectedNormalized ||
          item.normalizedCardText.startsWith(`${expectedNormalized} `)
        );

        if (exact) return exact.href;

        exact = candidates.find(item =>
          item.normalizedCardText.includes(expectedNormalized)
        );

        return exact ? exact.href : null;
      }, expectedNormalized);

      const cleanUrl = canonicalReleaseUrl(href, target.slug);

      if (cleanUrl) {
        console.log(`Resolved ${appName} ${version} release URL: ${cleanUrl}`);

        headlessReleaseCache[cacheKey] = {
          ts: Date.now(),
          url: cleanUrl
        };

        return cleanUrl;
      }
    }

    return null;
  } catch (err) {
    console.warn(`Headless release lookup failed for ${appName} ${version}: ${err.message}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore browser shutdown errors.
      }
    }
  }
}

function loadReleaseUrlCache() {
  try {
    if (!fs.existsSync(RELEASE_URL_CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(RELEASE_URL_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveReleaseUrlCache(cache) {
  try {
    fs.writeFileSync(RELEASE_URL_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write failures.
  }
}

function releaseCacheKeys(appName, version, context = {}) {
  const v = String(version || "").trim();

  if (appName === "unifiOS") {
    const family = unifiOsReleaseFamily(version, context);

    if (!family?.slug) {
      return [];
    }

    // UniFi OS release URLs are hardware-family specific.
    return [`${appName}:${v}:${family.slug}`];
  }

  return [`${appName}:${v}`];
}

function getCachedReleaseUrl(appName, version, context = {}) {
  const cache = loadReleaseUrlCache();

  for (const key of releaseCacheKeys(appName, version, context)) {
    const entry = cache[key];

    if (typeof entry === "string" && entry.includes("community.ui.com/releases")) {
      return entry;
    }

    if (entry?.url && entry.url.includes("community.ui.com/releases")) {
      return entry.url;
    }
  }

  return null;
}

function putCachedReleaseUrl(appName, version, context = {}, url) {
  if (!url || !url.includes("community.ui.com/releases")) return;

  const cache = loadReleaseUrlCache();

  for (const key of releaseCacheKeys(appName, version, context)) {
    cache[key] = {
      url,
      ts: Date.now()
    };
  }

  saveReleaseUrlCache(cache);
}

async function resolveReleaseUrl(appName, version, context = {}) {
  const cachedUrl = getCachedReleaseUrl(appName, version, context);
  if (cachedUrl) return cachedUrl;

  const candidates = releaseSvcPaths(appName, version, context);

  for (const svcUrl of candidates) {
    try {
      const response = await axios.get(svcUrl, {
        timeout: 8000,
        validateStatus: status => status >= 200 && status < 500
      });

      if (response.data?.url && response.data.url.includes("community.ui.com/releases")) {
        putCachedReleaseUrl(appName, version, context, response.data.url);
        return response.data.url;
      }

      if (typeof response.data === "string" && response.data.includes("community.ui.com/releases")) {
        const match = response.data.match(/https:\/\/community\.ui\.com\/releases\/[^"'\s<>]+/);
        if (match) {
          putCachedReleaseUrl(appName, version, context, match[0]);
          return match[0];
        }
      }
    } catch {
      // Try the next candidate.
    }
  }

  const exactUrl = await withTimeout(
    resolveReleaseUrlWithHeadlessBrowser(appName, version, context),
    30000,
    null
  );

  if (exactUrl) {
    putCachedReleaseUrl(appName, version, context, exactUrl);
    return exactUrl;
  }

  if (appName === "unifiOS") {
    const family = unifiOsReleaseFamily(version, context);
    if (family) {
      return `https://community.ui.com/releases?q=${encodeURIComponent(family.title)}`;
    }
  }

  const fallbackSlug = browserReleaseTitleSlug(appName, version, context);
  if (fallbackSlug) {
    return `https://community.ui.com/releases?q=${encodeURIComponent(fallbackSlug)}`;
  }

  return "https://community.ui.com/releases";
}

function buildReleaseNotesUrls(versions) {
  const unifiOS = String(versions.unifiOS || "").trim();
  const network = String(versions.network || "").trim();

  return {
    unifiOS: unifiOS
      ? `/api/release-link?app=unifiOS&version=${encodeURIComponent(unifiOS)}`
      : "https://community.ui.com/releases",
    network: network
      ? `/api/release-link?app=network&version=${encodeURIComponent(network)}`
      : "https://community.ui.com/releases"
  };
}

async function getUnifiVersions() {
  const versions = {
    unifiOS: null,
    network: null,
    sources: {
      unifiOS: null,
      network: null
    }
  };

  try {
    const devices = await getUnifiDevices();
    const gateway = devices.find(isGateway);

    if (gateway) {
      versions.gatewayName = deviceName(gateway);
      versions.gatewayModel = deviceModel(gateway);
      versions.gatewayModelCode = rawDeviceModel(gateway);

      versions.unifiOS = firstNonEmpty(
        gateway.displayable_version,
        gateway.version,
        gateway.udapi_version?.version
      );

      if (versions.unifiOS) {
        versions.sources.unifiOS = "gateway.displayable_version";
      }
    }
  } catch (err) {
    versions.sources.unifiOS = `error: ${err.message}`;
  }

  const site = config.unifi?.site || "default";

  const candidateEndpoints = [
    `/proxy/network/api/s/${site}/stat/sysinfo`,
    `/proxy/network/api/s/${site}/self`,
    `/proxy/network/api/self`,
    `/proxy/network/api/status`,
    `/proxy/network/api/system`
  ];

  for (const endpoint of candidateEndpoints) {
    try {
      const response = await unifiGet(endpoint);

      if (response.status < 200 || response.status >= 300) {
        continue;
      }

      const payload = response.data || {};
      const data = Array.isArray(payload.data) ? payload.data[0] : payload.data || payload;

      const found = firstNonEmpty(
        data?.version,
        data?.network_version,
        data?.application_version,
        data?.app_version,
        data?.server_version,
        data?.controller_version,
        payload?.version,
        payload?.network_version,
        payload?.application_version,
        payload?.app_version,
        payload?.server_version,
        payload?.controller_version
      );

      if (found) {
        versions.network = found;
        versions.sources.network = endpoint;
        break;
      }
    } catch (err) {
      // Try the next endpoint.
    }
  }

  if (!versions.network) {
    versions.sources.network = "not found from API candidates";
  }

  versions.releaseUrls = buildReleaseNotesUrls(versions);

  return versions;
}


function normalizeInventoryName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function extractBlastRadiusIncusInventory(model) {
  const hosts = {};

  for (const component of model.components || []) {
    if (component.type === "incus-host") {
      const hostName = component.name || "";
      const key = normalizeInventoryName(hostName);

      if (!key) continue;

      hosts[key] = hosts[key] || {
        name: hostName,
        id: component.id || null,
        status: component.status || null,
        subtitle: component.subtitle || null,
        instances: []
      };
    }
  }

  for (const component of model.components || []) {
    const incus = component.incus;
    if (!incus || !incus.remote) continue;

    const remoteName = incus.remote;
    const key = normalizeInventoryName(remoteName);

    hosts[key] = hosts[key] || {
      name: remoteName,
      id: `incus-remote-${remoteName}`,
      status: "ok",
      subtitle: "Incus remote",
      instances: []
    };

    hosts[key].instances.push({
      id: component.id || incus.id || null,
      name: component.name || incus.name || "Unnamed instance",
      status: incus.status || component.status || null,
      type: incus.type || component.type || null,
      preferredIp: incus.preferredIp || null,
      preferredInterface: incus.preferredInterface || null,
      project: incus.project || null,
      nestedDocker: incus.nestedDocker?.summary || null
    });
  }

  for (const host of Object.values(hosts)) {
    host.instances.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    host.instanceCount = host.instances.length;
  }

  return {
    generatedAt: model.generatedAt || null,
    hostCount: Object.keys(hosts).length,
    hosts
  };
}

async function getBlastRadiusIncusInventory() {
  const br = config.blastRadius || {};

  if (!br.enabled || !br.baseUrl) {
    return {
      ok: false,
      enabled: !!br.enabled,
      message: "Blast Radius integration is not enabled.",
      hosts: {}
    };
  }

  const baseUrl = String(br.baseUrl).replace(/\/+$/, "");
  const response = await axios.get(`${baseUrl}/api/model`, {
    timeout: 20000,
    validateStatus: () => true
  });

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      enabled: true,
      baseUrl,
      message: `Blast Radius returned ${response.status}`,
      hosts: {}
    };
  }

  const inventory = extractBlastRadiusIncusInventory(response.data || {});

  return {
    ok: true,
    enabled: true,
    baseUrl,
    ...inventory
  };
}


function buildTopology(devices, clients, incusInventory = null) {
  const gatewaysRaw = devices.filter(isGateway);
  const switches = devices.filter(isSwitch).map(summarizeNetworkDevice);
  const accessPoints = devices.filter(isAccessPoint).map(summarizeNetworkDevice);
  const smartDevices = devices.filter(isSmartPowerDevice).map(summarizeNetworkDevice);

  const managedMacs = new Set(devices.map(device => normalizeMac(device.mac)).filter(Boolean));
  const allClients = clients.map(summarizeClient);

  const possibleUnifiHardwareClients = clients
    .filter(client => !managedMacs.has(normalizeMac(client.mac)))
    .filter(isLikelyUnifiHardwareClient)
    .map(summarizeClient);

  const possibleUnifiHardwareMacs = new Set(
    possibleUnifiHardwareClients.map(client => normalizeMac(client.mac)).filter(Boolean)
  );

  const wiredClients = allClients.filter(client =>
    client.wired && !possibleUnifiHardwareMacs.has(normalizeMac(client.mac))
  );

  const wirelessClients = allClients.filter(client =>
    client.wireless && !possibleUnifiHardwareMacs.has(normalizeMac(client.mac))
  );

  const gateway = gatewaysRaw.length > 0
    ? summarizeGateway(gatewaysRaw[0])
    : {
        name: "Gateway not found",
        model: "Unknown",
        modelCode: null,
        wanIp: null,
        primaryLanGateway: config.unifi?.primaryLanGateway || null,
        status: "Unknown"
      };

  const physicalTopology = buildPhysicalTopology(
    gateway,
    switches,
    accessPoints,
    smartDevices,
    wiredClients,
    wirelessClients
  );

  return {
    generatedAt: new Date().toISOString(),
    gateway,
    switches,
    accessPoints,
    smartDevices,
    possibleUnifiHardwareClients,
    wiredClients,
    wirelessClients,
    physicalTopology,
    incusInventory: incusInventory || {
      ok: false,
      enabled: false,
      hosts: {}
    },
    counts: {
      gateways: gatewaysRaw.length,
      switches: switches.length,
      accessPoints: accessPoints.length,
      smartDevices: smartDevices.length,
      possibleUnifiHardwareClients: possibleUnifiHardwareClients.length,
      wiredClients: wiredClients.length,
      wirelessClients: wirelessClients.length,
      totalClients: allClients.length
    }
  };
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    app: "ScottiBYTE UniFi Topology",
    shortName: "UniFi Topology",
    status: "running",
    version: "1.0.2",
    port: PORT,
    configLoaded: true,
    unifi: {
      gatewayHost: config.unifi?.gatewayHost || null,
      primaryLanGateway: config.unifi?.primaryLanGateway || null,
      site: config.unifi?.site || "default",
      pollSeconds: config.unifi?.pollSeconds || 30,
      insecureSSL: !!config.unifi?.insecureSSL,
      usernameConfigured: !!config.unifi?.username,
      passwordConfigured: !!config.unifi?.password,
      sessionCached: sessionIsValid(),
      lastLoginStatus: unifiSession.lastLoginStatus,
      lastLoginMessage: unifiSession.lastLoginMessage
    },
    time: new Date().toISOString()
  });
});

app.get("/api/unifi/test", async (req, res) => {
  try {
    const login = await loginUnifi(false);

    if (!login.ok) {
      return res.status(502).json({
        ok: false,
        message: login.message,
        loginStatus: login.status,
        loginStatusText: login.statusText,
        hasCookies: login.hasCookies
      });
    }

    const selfResponse = await login.client.get("/api/users/self", {
      headers: {
        Cookie: login.cookieHeader
      }
    });

    res.json({
      ok: true,
      message: login.reused ? "UniFi cached session succeeded" : "UniFi login succeeded",
      gatewayHost: config.unifi?.gatewayHost || null,
      site: config.unifi?.site || "default",
      loginStatus: login.status,
      reusedSession: !!login.reused,
      hasCookies: login.hasCookies,
      selfEndpointStatus: selfResponse.status,
      selfEndpointOk: selfResponse.status >= 200 && selfResponse.status < 300
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/api/unifi/devices", async (req, res) => {
  try {
    const rawDevices = await getUnifiDevices();
    const devices = rawDevices.map(summarizeNetworkDevice);

    res.json({
      ok: true,
      count: devices.length,
      gatewayCount: rawDevices.filter(isGateway).length,
      switchCount: rawDevices.filter(isSwitch).length,
      accessPointCount: rawDevices.filter(isAccessPoint).length,
      smartDeviceCount: rawDevices.filter(isSmartPowerDevice).length,
      devices
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/api/unifi/clients", async (req, res) => {
  try {
    const rawClients = await getUnifiClients();
    const clients = rawClients.map(summarizeClient);

    res.json({
      ok: true,
      count: clients.length,
      wiredCount: clients.filter(c => c.wired).length,
      wirelessCount: clients.filter(c => c.wireless).length,
      possibleUnifiHardwareCount: rawClients.filter(isLikelyUnifiHardwareClient).length,
      clients
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/api/blastradius/incus", async (req, res) => {
  try {
    const inventory = await getBlastRadiusIncusInventory();
    res.json(inventory);
  } catch (err) {
    res.status(500).json({
      ok: false,
      enabled: !!config.blastRadius?.enabled,
      message: err.message,
      hosts: {}
    });
  }
});

app.get("/api/unifi/client-discovery", async (req, res) => {
  try {
    const rawClients = await getUnifiClients();
    const clients = rawClients.map(summarizeClientDiscovery);

    res.json({ ok: true, count: clients.length, clients });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/api/unifi/gateway-fields", async (req, res) => {
  try {
    const rawDevices = await getUnifiDevices();
    const gateway = rawDevices.find(isGateway);

    if (!gateway) return res.status(404).json({ ok: false, message: "No UniFi gateway found" });

    const interesting = {};
    const keywords = ["name", "model", "display", "product", "type", "version", "board", "device", "short", "sku", "hardware", "gateway", "system", "architecture"];

    for (const key of Object.keys(gateway).sort()) {
      const lower = key.toLowerCase();
      if (keywords.some(word => lower.includes(word))) {
        const value = gateway[key];
        if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          interesting[key] = value;
        } else if (Array.isArray(value)) {
          interesting[key] = `[array length ${value.length}]`;
        } else if (typeof value === "object") {
          interesting[key] = `[object keys: ${Object.keys(value).slice(0, 20).join(", ")}]`;
        }
      }
    }

    res.json({
      ok: true,
      note: "Condensed gateway fields for model/name/product discovery.",
      derived: {
        name: deviceName(gateway),
        type: gateway.type || null,
        rawModel: rawDeviceModel(gateway),
        friendlyModel: deviceModel(gateway),
        ip: deviceIp(gateway),
        wanIp: firstNonEmpty(gateway.wan1?.ip, gateway.wan2?.ip, gateway.wan_ip, gateway.ip),
        primaryLanGateway: config.unifi?.primaryLanGateway || null,
        version: gateway.version || null,
        status: deviceStatus(gateway)
      },
      interesting
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get("/api/unifi/gateway-raw", async (req, res) => {
  try {
    const rawDevices = await getUnifiDevices();
    const gateway = rawDevices.find(isGateway);

    if (!gateway) return res.status(404).json({ ok: false, message: "No UniFi gateway found" });

    res.json({
      ok: true,
      note: "Raw UniFi gateway object for model-name discovery. No UniFi password is included.",
      keys: Object.keys(gateway).sort(),
      gateway
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});



app.get("/api/release-link", async (req, res) => {
  try {
    const appName = String(req.query.app || "");
    const version = String(req.query.version || "");

    if (!appName || !version) {
      return res.redirect("https://community.ui.com/releases");
    }

    const versions = await getUnifiVersions();
    const url = await resolveReleaseUrl(appName, version, versions);

    return res.redirect(302, url || "https://community.ui.com/releases");
  } catch (err) {
    const appName = String(req.query.app || "");
    const version = String(req.query.version || "");
    const fallbackSlug = browserReleaseTitleSlug(appName, version, {});
    const fallbackUrl = fallbackSlug
      ? `https://community.ui.com/releases?q=${encodeURIComponent(fallbackSlug)}`
      : "https://community.ui.com/releases";

    return res.redirect(302, fallbackUrl);
  }
});


app.get("/api/unifi/versions", async (req, res) => {
  try {
    const versions = await getUnifiVersions();

    res.json({
      ok: true,
      versions
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      message: err.message,
      versions: {
        unifiOS: null,
        network: null,
        sources: {
          unifiOS: "error",
          network: "error"
        }
      }
    });
  }
});

app.get("/api/topology", async (req, res) => {
  try {
    const [devices, clients, versions, incusInventory] = await Promise.all([
      getUnifiDevices(),
      getUnifiClients(),
      getUnifiVersions(),
      getBlastRadiusIncusInventory().catch(err => ({
        ok: false,
        enabled: !!config.blastRadius?.enabled,
        message: err.message,
        hosts: {}
      }))
    ]);

    const topology = buildTopology(devices, clients, incusInventory);
    topology.versions = versions;

    res.json(topology);
  } catch (err) {
    res.status(500).json({
      generatedAt: new Date().toISOString(),
      error: true,
      message: err.message,
      gateway: {
        name: "Topology unavailable",
        model: "Unknown",
        modelCode: null,
        wanIp: null,
        primaryLanGateway: config.unifi?.primaryLanGateway || null,
        status: "Error"
      },
      switches: [],
      accessPoints: [],
      smartDevices: [],
      possibleUnifiHardwareClients: [],
      wiredClients: [],
      wirelessClients: [],
      physicalTopology: {
        gateway: null,
        rootSwitches: [],
        orphanAccessPoints: []
      },
      counts: {
        gateways: 0,
        switches: 0,
        accessPoints: 0,
        smartDevices: 0,
        possibleUnifiHardwareClients: 0,
        wiredClients: 0,
        wirelessClients: 0,
        totalClients: 0
      }
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ScottiBYTE UniFi Topology running on http://0.0.0.0:${PORT}`);
});

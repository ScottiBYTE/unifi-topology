
const APP_LINKS = {
  github: "https://github.com/ScottiBYTE/unifi-topology",
  donate: "https://www.paypal.com/paypalme/ScottiBYTE"
};

let latestTopology = null;

const collapsedBranches = new Set([
  "possibleUnifiHardwareClients",
  "wiredClients",
  "wirelessClients"
]);

const branchUserTouched = new Set();

const collapsedGraphNodes = new Set();
let latestGraphExpandableNodeIds = [];
let latestGraphNodeTypes = new Map();
let showServiceInventory = false;
let graphExpansionMode = "default";

const viewState = {
  scale: 0.95,
  x: 22,
  y: 20,
  dragging: false,
  lastX: 0,
  lastY: 0
};


function restoreDefaultTopologyView() {
  graphExpansionMode = "default";
  collapsedGraphNodes.clear();
  collapsedBranches.clear();
  branchUserTouched.clear();

  [
    "possibleUnifiHardwareClients",
    "wiredClients",
    "wirelessClients"
  ].forEach(id => collapsedBranches.add(id));
}

function applyGraphVisualClasses() {
  const typeMap = {
    "Switch": "type-switch",
    "Gateway": "type-gateway",
    "WAN": "type-wan",
    "AP": "type-ap",
    "Ports": "type-ports",
    "Port": "type-port",
    "Client": "type-client",
    "WiFi": "type-client",
    "SSID": "type-ssid",
    "Incus": "type-incus",
    "Smart": "type-smart"
  };

  document.querySelectorAll(".graph-node").forEach(card => {
    const candidates = Array.from(card.querySelectorAll("span, div"))
      .filter(el => {
        const text = String(el.textContent || "").trim();
        return Object.prototype.hasOwnProperty.call(typeMap, text);
      });

    const badge = candidates[0];
    if (!badge) return;

    const typeText = String(badge.textContent || "").trim();
    const typeClass = typeMap[typeText];

    card.classList.add(typeClass);
    badge.classList.add("node-type-badge");
  });
}



function hasIncusServiceInventory(data = latestTopology) {
  const hosts = data?.incusInventory?.hosts || {};

  return Object.values(hosts).some(host =>
    Array.isArray(host?.instances) && host.instances.length > 0
  );
}


function setupHeaderActions() {
  const header = document.querySelector(".app-header");
  if (!header || document.getElementById("headerActions")) return;

  const statusPill = header.querySelector(".status-pill");

  const actions = document.createElement("div");
  actions.id = "headerActions";
  actions.className = "header-actions";

  actions.innerHTML = `
    <a class="header-link github-link" href="${APP_LINKS.github}" target="_blank" rel="noopener noreferrer" title="Open GitHub repository">
      GitHub v1.0.0
    </a>
    <a class="header-link donate-link" href="${APP_LINKS.donate}" target="_blank" rel="noopener noreferrer" title="Support ScottiBYTE">
      ❤ Donate
    </a>
    <button id="themeToggleBtn" class="header-link theme-toggle" type="button" title="Toggle light or dark mode">
      ☀ Light
    </button>
  `;

  if (statusPill) {
    const wrapper = document.createElement("div");
    wrapper.className = "header-right";
    statusPill.parentNode.insertBefore(wrapper, statusPill);
    wrapper.appendChild(actions);
    wrapper.appendChild(statusPill);
  } else {
    header.appendChild(actions);
  }

  const savedTheme = localStorage.getItem("scottibyte-unifi-topology-theme") || "dark";
  document.body.classList.toggle("light-mode", savedTheme === "light");
  updateThemeToggleLabel();

  document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
    const light = !document.body.classList.contains("light-mode");
    document.body.classList.toggle("light-mode", light);
    localStorage.setItem("scottibyte-unifi-topology-theme", light ? "light" : "dark");
    updateThemeToggleLabel();
  });
}

function updateThemeToggleLabel() {
  const button = document.getElementById("themeToggleBtn");
  if (!button) return;

  button.textContent = document.body.classList.contains("light-mode")
    ? "☾ Dark"
    : "☀ Light";
}

function updateServiceInventoryButton() {
  const button = document.getElementById("toggleServicesBtn");
  if (!button) return;

  const available = hasIncusServiceInventory();

  if (!available) {
    showServiceInventory = false;
    button.style.display = "none";
    button.classList.remove("service-toggle-active");
    return;
  }

  button.style.display = "";

  button.textContent = showServiceInventory ? "Remove Incus Services" : "Add Incus Services";
  button.title = showServiceInventory
    ? "Remove the optional Incus service inventory overlay."
    : "Add the optional Incus service inventory overlay.";
  button.classList.toggle("service-toggle-active", showServiceInventory);
}

function shouldDefaultCollapseBranch(id) {
  if (branchUserTouched.has(id)) return false;

  return (
    id.includes("-wired") ||
    id.includes("ssid-") ||
    id === "wiredClients" ||
    id === "wirelessClients" ||
    id === "possibleUnifiHardwareClients"
  );
}

function safe(value, fallback = "Unknown") {
  return value === null || value === undefined || value === "" ? fallback : value;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function applyTransform() {
  const world = document.getElementById("topologyWorld");
  if (!world) return;
  world.style.transform = `translate(${viewState.x}px, ${viewState.y}px) scale(${viewState.scale})`;
}

function clampScale(value) {
  return Math.min(2.2, Math.max(0.35, value));
}

function zoomAtCenter(delta) {
  const canvas = document.getElementById("topologyCanvas");
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  zoomAtPoint(delta, rect.width / 2, rect.height / 2);
}

function zoomAtPoint(delta, pointX, pointY) {
  const oldScale = viewState.scale;
  const newScale = clampScale(oldScale * delta);

  const worldX = (pointX - viewState.x) / oldScale;
  const worldY = (pointY - viewState.y) / oldScale;

  viewState.scale = newScale;
  viewState.x = pointX - worldX * newScale;
  viewState.y = pointY - worldY * newScale;

  applyTransform();
}

function resetView() {
  const canvas = document.getElementById("topologyCanvas");

  viewState.scale = 0.95;
  viewState.x = 22;
  viewState.y = 20;

  if (canvas) {
    canvas.scrollLeft = 0;
    canvas.scrollTop = 0;
  }

  applyTransform();
}

function attachPanZoomHandlers() {
  const canvas = document.getElementById("topologyCanvas");
  if (!canvas || canvas.dataset.panZoomAttached === "true") return;

  canvas.dataset.panZoomAttached = "true";

  canvas.addEventListener("wheel", event => {
    event.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    const delta = event.deltaY < 0 ? 1.12 : 0.88;

    zoomAtPoint(delta, pointX, pointY);
  }, { passive: false });

  canvas.addEventListener("mousedown", event => {
    if (event.button !== 0) return;
    if (event.target.closest("button, .branch-header, .graph-node, .graph-toggle, input, label")) return;

    viewState.dragging = true;
    viewState.lastX = event.clientX;
    viewState.lastY = event.clientY;
    canvas.classList.add("dragging");
  });

  window.addEventListener("mousemove", event => {
    if (!viewState.dragging) return;

    const dx = event.clientX - viewState.lastX;
    const dy = event.clientY - viewState.lastY;

    viewState.x += dx;
    viewState.y += dy;
    viewState.lastX = event.clientX;
    viewState.lastY = event.clientY;

    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    viewState.dragging = false;
    canvas.classList.remove("dragging");
  });
}

function gatewayBanner(gateway) {
  return `
    <section class="gateway-banner">
      <div class="gateway-banner-left">
        <div class="gateway-eyebrow">Gateway</div>
        <div class="gateway-banner-title">${escapeHtml(safe(gateway.name))}</div>
        <div class="gateway-banner-subtitle">
          Model: ${escapeHtml(safe(gateway.model))}
          <span>•</span>
          WAN: ${escapeHtml(safe(gateway.wanIp))}
          <span>•</span>
          Primary LAN: ${escapeHtml(safe(gateway.primaryLanGateway))}
        </div>
      </div>
      <div class="gateway-banner-status">${escapeHtml(safe(gateway.status))}</div>
    </section>
  `;
}


function versionBadges(versions) {
  const unifiOS = versions?.unifiOS || "Unknown";
  const network = versions?.network || "Unknown";
  const unifiOsUrl = versions?.releaseUrls?.unifiOS || "https://community.ui.com/releases";
  const networkUrl = versions?.releaseUrls?.network || "https://community.ui.com/releases";

  return `
    <div class="version-badges">
      <a class="version-badge" href="${escapeHtml(unifiOsUrl)}" target="_blank" rel="noopener noreferrer" title="Open UniFi OS release notes">
        UNIFI OS&nbsp; <strong>${escapeHtml(unifiOS)}</strong>
      </a>
      <a class="version-badge" href="${escapeHtml(networkUrl)}" target="_blank" rel="noopener noreferrer" title="Open UniFi Network release notes">
        NETWORK&nbsp; <strong>${escapeHtml(network)}</strong>
      </a>
    </div>
  `;
}

function nodeCard(device, kind, cssClass) {
  const title = escapeHtml(safe(device.name));
  const model = escapeHtml(safe(device.model, ""));
  const ip = escapeHtml(safe(device.ip, ""));
  const status = escapeHtml(safe(device.status, ""));

  const lines = [];

  if (model) lines.push(`Model: ${model}`);
  if (ip) lines.push(`IP: ${ip}`);
  if (device.wanIp) lines.push(`WAN: ${escapeHtml(device.wanIp)}`);
  if (device.primaryLanGateway) lines.push(`Primary LAN: ${escapeHtml(device.primaryLanGateway)}`);
  if (device.uplinkPort) lines.push(`Uplink Port: ${escapeHtml(device.uplinkPort)}`);
  if (device.switchPort) lines.push(`Switch Port: ${escapeHtml(device.switchPort)}`);
  if (device.ssid) lines.push(`SSID: ${escapeHtml(device.ssid)}`);
  if (device.network) lines.push(`Network: ${escapeHtml(device.network)}`);
  if (device.signal) lines.push(`Signal: ${escapeHtml(device.signal)}`);
  if (device.manufacturer) lines.push(`Vendor: ${escapeHtml(device.manufacturer)}`);

  return `
    <article class="node-card ${cssClass}">
      <div class="node-title">
        <span>${title}</span>
        <span class="node-kind">${escapeHtml(kind)}</span>
      </div>
      <div class="node-detail">${lines.join("<br>")}</div>
      ${status ? `<div class="node-status">${status}</div>` : ""}
    </article>
  `;
}

function internetCard(gateway) {
  return `
    <article class="node-card internet-card root-card">
      <div class="node-title">
        <span>Internet / WAN</span>
        <span class="node-kind">WAN</span>
      </div>
      <div class="node-detail">WAN IP: ${escapeHtml(safe(gateway.wanIp))}</div>
      <div class="node-status">Online</div>
    </article>
  `;
}

function branch(id, title, items, renderer, cssClass = "", limit = null) {
  if (shouldDefaultCollapseBranch(id)) collapsedBranches.add(id);

  const isCollapsed = collapsedBranches.has(id);
  const visibleItems = limit ? items.slice(0, limit) : items;
  const hiddenCount = limit && items.length > limit ? items.length - limit : 0;

  const body = visibleItems.length
    ? visibleItems.map(renderer).join("")
    : `<div class="small-note">No items found.</div>`;

  return `
    <section class="branch ${cssClass} ${isCollapsed ? "collapsed" : ""}" data-branch="${escapeHtml(id)}">
      <div class="branch-header" role="button" tabindex="0">
        <div>
          <div class="branch-title">${escapeHtml(title)}</div>
          <div class="branch-count">${items.length} item${items.length === 1 ? "" : "s"}</div>
        </div>
        <div>${isCollapsed ? "＋" : "−"}</div>
      </div>
      <div class="branch-items ${limit ? "client-list-limited" : ""}">
        ${body}
        ${hiddenCount ? `<div class="small-note">Showing first ${limit}. ${hiddenCount} more hidden for readability.</div>` : ""}
      </div>
    </section>
  `;
}

function clientCard(client, kind) {
  return nodeCard({
    name: client.name,
    model: client.model,
    ip: client.ip,
    status: client.connectionType || "",
    switchPort: client.switchPort,
    ssid: client.ssid,
    network: client.network,
    signal: client.signal,
    manufacturer: client.manufacturer
  }, kind, "client-card");
}

function renderSummary(data) {
  const counts = data.counts || {};
  const switches = counts.switches ?? 0;
  const accessPoints = counts.accessPoints ?? 0;
  const wiredClients = counts.wiredClients ?? 0;
  const wirelessClients = counts.wirelessClients ?? 0;
  const gateways = counts.gateways ?? counts.gatewayCount ?? (data.gateway ? 1 : 0);

  const cards = [
    ["Gateway", gateways],
    ["Switches", switches],
    ["Access Points", accessPoints],
    ["Wired Clients", wiredClients],
    ["Wireless Clients", wirelessClients],
    ["Total Clients", wiredClients + wirelessClients]
  ];

  document.getElementById("summaryCards").innerHTML = cards.map(([label, num]) => `
    <div class="mini-card">
      <div class="num">${escapeHtml(num)}</div>
      <div class="label">${escapeHtml(label)}</div>
    </div>
  `).join("");
}

function countWirelessOnAp(ap) {
  const groups = ap.wirelessBySsid || {};
  return Object.values(groups).reduce((total, clients) => total + clients.length, 0);
}

function portLabel(port) {
  return port ? `Port ${escapeHtml(port)}` : "Port unknown";
}

function attachmentChip(label, value, kind = "") {
  return `
    <div class="attachment-chip ${kind}">
      <div class="attachment-label">${label}</div>
      <div class="attachment-value">${value}</div>
    </div>
  `;
}

function groupWiredClientsByPort(clients) {
  const grouped = {};
  for (const client of clients || []) {
    const key = client.switchPort || "unknown";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(client);
  }
  return grouped;
}

function renderPortAttachments(sw) {
  const chips = [];

  for (const child of sw.childSwitches || []) {
    chips.push(attachmentChip(
      portLabel(child.uplinkPort),
      `→ ${escapeHtml(child.name)}`,
      "switch-attachment"
    ));
  }

  for (const ap of sw.accessPoints || []) {
    chips.push(attachmentChip(
      portLabel(ap.uplinkPort),
      `→ ${escapeHtml(ap.name)}`,
      "ap-attachment"
    ));
  }

  for (const smart of sw.smartDevices || []) {
    chips.push(attachmentChip(
      portLabel(smart.uplinkPort),
      `→ ${escapeHtml(smart.name)}`,
      "smart-attachment"
    ));
  }

  const wired = sw.wiredClients || [];
  const grouped = groupWiredClientsByPort(wired);
  const portCount = Object.keys(grouped).length;

  if (wired.length) {
    chips.push(attachmentChip(
      "Wired clients",
      `${wired.length} client${wired.length === 1 ? "" : "s"} on ${portCount} port${portCount === 1 ? "" : "s"}`,
      "client-attachment"
    ));
  }

  if (!chips.length) {
    return `<div class="attachment-empty">No port attachments detected.</div>`;
  }

  return `<div class="attachment-rail">${chips.join("")}</div>`;
}

function renderSsidAttachments(ap) {
  const groups = ap.wirelessBySsid || {};
  const ssids = Object.keys(groups);

  if (!ssids.length) return `<div class="attachment-empty">No wireless clients detected.</div>`;

  return `
    <div class="attachment-rail ssid-rail">
      ${ssids.map(ssid => attachmentChip(
        `SSID: ${escapeHtml(ssid)}`,
        `${groups[ssid].length} wireless client${groups[ssid].length === 1 ? "" : "s"}`,
        "ssid-attachment"
      )).join("")}
    </div>
    <div class="ssid-detail-branches">
      ${ssids.map(ssid => branch(
        `ssid-${ap.mac}-${ssid}`,
        `SSID: ${ssid}`,
        groups[ssid],
        client => clientCard(client, "WiFi"),
        "ssid-branch",
        40
      )).join("")}
    </div>
  `;
}

function switchDetail(sw) {
  const wiredBranch = branch(
    `switch-${sw.mac}-wired`,
    "Wired clients by port",
    sw.wiredClients || [],
    client => clientCard(client, "Wired"),
    "nested-branch compact-branch",
    80
  );

  return `
    <div class="horizontal-title">Ports and attachments</div>
    ${renderPortAttachments(sw)}
    ${wiredBranch}
  `;
}

function apDetail(ap) {
  return `
    <div class="horizontal-title">SSIDs and wireless clients</div>
    ${renderSsidAttachments(ap)}
  `;
}

function smartDetail(device) {
  return `
    <div class="horizontal-title">Attached smart device</div>
    <div class="attachment-empty">UniFi smart device attached to upstream port.</div>
  `;
}

function collectInfraRows(rootSwitches, orphanAccessPoints) {
  const rows = [];

  function addSwitch(sw, depth = 0) {
    rows.push({
      id: `switch-${sw.mac}`,
      depth,
      type: "switch",
      device: sw,
      detailHtml: switchDetail(sw)
    });

    for (const child of sw.childSwitches || []) {
      addSwitch(child, depth + 1);
    }

    for (const ap of sw.accessPoints || []) {
      rows.push({
        id: `ap-${ap.mac}`,
        depth: depth + 1,
        type: "ap",
        device: {
          ...ap,
          status: `${ap.status} · ${countWirelessOnAp(ap)} WiFi clients`
        },
        detailHtml: apDetail(ap)
      });
    }

    for (const smart of sw.smartDevices || []) {
      rows.push({
        id: `smart-${smart.mac}`,
        depth: depth + 1,
        type: "smart",
        device: smart,
        detailHtml: smartDetail(smart)
      });
    }
  }

  for (const sw of rootSwitches || []) addSwitch(sw, 0);

  for (const ap of orphanAccessPoints || []) {
    rows.push({
      id: `orphan-ap-${ap.mac}`,
      depth: 0,
      type: "ap",
      device: {
        ...ap,
        status: `${ap.status} · ${countWirelessOnAp(ap)} WiFi clients`
      },
      detailHtml: apDetail(ap)
    });
  }

  return rows;
}

function infraCard(row) {
  if (row.type === "switch") return nodeCard(row.device, "Switch", "switch-card");
  if (row.type === "ap") return nodeCard(row.device, "AP", "ap-card");
  if (row.type === "smart") return nodeCard(row.device, "Smart", "smart-card");
  return nodeCard(row.device, "Device", "node-card");
}

function infraRow(row, index, total) {
  return `
    <section class="ladder-row depth-${row.depth}">
      <div class="ladder-card">
        ${infraCard(row)}
      </div>
      <div class="ladder-connector ${index === total - 1 ? "last" : ""}">
        <span class="ladder-dot"></span>
      </div>
      <div class="ladder-detail">
        ${row.detailHtml}
      </div>
    </section>
  `;
}

function renderPhysicalTopology(data) {
  const gateway = data.gateway || {};
  const physical = data.physicalTopology || {};
  const rootSwitches = physical.rootSwitches || [];
  const orphanAccessPoints = physical.orphanAccessPoints || [];
  const possibleUnifiHardwareClients = data.possibleUnifiHardwareClients || [];
  const wiredClients = data.wiredClients || [];
  const wirelessClients = data.wirelessClients || [];

  const showWired = document.getElementById("showWiredClients").checked;
  const showWireless = document.getElementById("showWirelessClients").checked;
  const showOtherUnifi = document.getElementById("showOtherUnifi").checked;

  const infraRows = collectInfraRows(rootSwitches, orphanAccessPoints);

  return `
    <div id="topologyWorld" class="topology-world">
      ${gatewayBanner(gateway)}

      <div class="topology-map ladder-map">
        <div class="ladder-root">
          <section class="ladder-row root-ladder-row">
            <div class="ladder-card">
              ${internetCard(gateway)}
            </div>
            <div class="ladder-connector">
              <span class="ladder-dot"></span>
            </div>
            <div class="ladder-detail compact-root-detail">
              <div class="attachment-chip wan-attachment">
                <div class="attachment-label">WAN edge</div>
                <div class="attachment-value">${escapeHtml(safe(gateway.wanIp))}</div>
              </div>
            </div>
          </section>

          <section class="ladder-row root-ladder-row">
            <div class="ladder-card">
              ${nodeCard(gateway, "Gateway", "gateway-card root-card")}
            </div>
            <div class="ladder-connector">
              <span class="ladder-dot"></span>
            </div>
            <div class="ladder-detail compact-root-detail">
              <div class="attachment-chip gateway-attachment">
                <div class="attachment-label">Primary LAN gateway</div>
                <div class="attachment-value">${escapeHtml(safe(gateway.primaryLanGateway))}</div>
              </div>
            </div>
          </section>

          ${infraRows.length
            ? infraRows.map((row, index) => infraRow(row, index, infraRows.length)).join("")
            : `<div class="small-note">No infrastructure topology detected.</div>`}
        </div>

        <div class="side-inventory">
          ${showOtherUnifi ? branch(
            "possibleUnifiHardwareClients",
            "Possible UniFi ecosystem clients",
            possibleUnifiHardwareClients,
            device => clientCard(device, "Possible"),
            "wide-branch"
          ) : ""}

          ${showWired ? branch(
            "wiredClients",
            "All wired clients",
            wiredClients,
            device => clientCard(device, "Wired"),
            "wide-branch",
            80
          ) : ""}

          ${showWireless ? branch(
            "wirelessClients",
            "All wireless clients",
            wirelessClients,
            device => clientCard(device, "WiFi"),
            "wide-branch",
            80
          ) : ""}
        </div>
      </div>
    </div>
  `;
}


/* Blast Radius style graph topology renderer */

const GRAPH_CARD_WIDTH = 285;
const GRAPH_COL_GAP = 380;
const GRAPH_ROW_GAP = 36;
const GRAPH_LEFT = 30;
const GRAPH_TOP = 78;

function graphNodeHeight(node) {
  if (!node) return 110;

  if (node.type === "WAN") return 96;
  if (node.type === "Gateway") return 118;
  if (node.type === "Switch") return 162;
  if (node.type === "AP") return 162;
  if (node.type === "SSID") return 112;
  if (node.type === "Wired") return 120;
  if (node.type === "Ports") return 124;
  if (node.type === "Port") return 146;
  if (node.type === "WiFi") return 120;
  if (node.type === "Client") return 122;
  if (node.type === "Incus") return 132;
  if (node.type === "Smart") return 124;

  return 110;
}

function graphNode(id, type, title, subtitleLines = [], status = "", extraClass = "") {
  return {
    id,
    type,
    title,
    subtitleLines,
    status,
    extraClass,
    x: 0,
    y: 0,
    height: 110,
    hasChildren: false,
    collapsed: false
  };
}

function graphEdge(from, to, className = "") {
  return { from, to, className };
}

function makeFullGraphFromTopology(data) {
  const gateway = data.gateway || {};
  const physical = data.physicalTopology || {};
  const rootSwitches = physical.rootSwitches || [];

  const showWired = document.getElementById("showWiredClients")?.checked ?? true;
  const showWireless = document.getElementById("showWirelessClients")?.checked ?? true;
  const showOtherUnifi = document.getElementById("showOtherUnifi")?.checked ?? true;
  const showServices = showServiceInventory;

  const nodes = [];
  const edges = [];

  function addNode(node) {
    nodes.push(node);
    return node;
  }

  const internet = addNode(graphNode(
    "internet",
    "WAN",
    "Internet / WAN",
    [`WAN IP: ${safe(gateway.wanIp)}`],
    "Online",
    "internet-node"
  ));

  const gw = addNode(graphNode(
    "gateway",
    "Gateway",
    safe(gateway.name),
    [
      `Model: ${safe(gateway.model)}`,
      `WAN: ${safe(gateway.wanIp)}`,
      `Primary LAN: ${safe(gateway.primaryLanGateway)}`
    ],
    safe(gateway.status),
    "gateway-node"
  ));

  edges.push(graphEdge("internet", "gateway", "wan-link"));

  function switchLines(sw) {
    const lines = [];
    if (sw.model) lines.push(`Model: ${sw.model}`);
    if (sw.ip) lines.push(`IP: ${sw.ip}`);
    if (sw.uplinkPort) lines.push(`Uplink Port: ${sw.uplinkPort}`);

    const attachCount =
      (sw.childSwitches?.length || 0) +
      (sw.accessPoints?.length || 0) +
      (sw.smartDevices?.length || 0);

    const clientCount = showWired ? (sw.wiredClients?.length || 0) : 0;

    if (attachCount || clientCount) {
      lines.push(`${attachCount} infrastructure · ${clientCount} wired clients`);
    }

    return lines;
  }

  function apLines(ap) {
    const lines = [];
    if (ap.model) lines.push(`Model: ${ap.model}`);
    if (ap.ip) lines.push(`IP: ${ap.ip}`);
    if (ap.uplinkPort) lines.push(`Uplink Port: ${ap.uplinkPort}`);

    const wifiCount = countWirelessOnAp(ap);
    lines.push(`${wifiCount} WiFi clients`);

    return lines;
  }

  function smartLines(device) {
    const lines = [];
    if (device.model) lines.push(`Model: ${device.model}`);
    if (device.ip) lines.push(`IP: ${device.ip}`);
    if (device.uplinkPort) lines.push(`Uplink Port: ${device.uplinkPort}`);
    return lines;
  }

  function clientLines(client) {
    const lines = [];

    if (client.ip) lines.push(`IP: ${client.ip}`);
    if (client.switchPort) lines.push(`Switch Port: ${client.switchPort}`);
    if (client.ssid) lines.push(`SSID: ${client.ssid}`);
    if (client.network) lines.push(`Network: ${client.network}`);
    if (client.manufacturer) lines.push(`Vendor: ${client.manufacturer}`);
    if (client.signal) lines.push(`Signal: ${client.signal}`);

    return lines;
  }

  function addClientLeaf(client, depth, parentId, kind) {
    const clientIdBase = client.mac || client.id || `${parentId}-${client.name || "client"}`;
    const id = `${kind.toLowerCase()}-${clientIdBase}-${parentId}`.replaceAll(" ", "-");

    const node = graphNode(
      id,
      kind,
      safe(client.name, "Unnamed client"),
      clientLines(client),
      client.connectionType || "",
      kind === "WiFi" ? "wifi-client-node" : "wired-client-node"
    );

    node.depth = depth;
    addNode(node);
    edges.push(graphEdge(parentId, id, kind === "WiFi" ? "wifi-client-link" : "client-link"));
  }

  function wiredSummaryNode(sw, parentDepth, parentId) {
    // Disabled intentionally.
    // Wired clients are summarized on the switch card instead of being rendered
    // as a separate graph node.
    return;
  }


  function normalizeInventoryName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .trim();
  }

  function incusHostForPortName(portName, data) {
    const hosts = data?.incusInventory?.hosts || {};
    const normalizedPortName = normalizeInventoryName(portName);

    if (!normalizedPortName) return null;

    if (hosts[normalizedPortName]) return hosts[normalizedPortName];

    for (const [key, host] of Object.entries(hosts)) {
      const hostKey = normalizeInventoryName(key);
      const hostName = normalizeInventoryName(host.name);

      if (
        normalizedPortName === hostKey ||
        normalizedPortName === hostName ||
        normalizedPortName.startsWith(hostKey) ||
        normalizedPortName.startsWith(hostName) ||
        hostKey.startsWith(normalizedPortName) ||
        hostName.startsWith(normalizedPortName)
      ) {
        return host;
      }
    }

    return null;
  }

  function addIncusInstanceLeaf(instance, depth, parentId) {
    const id = `incus-${instance.id || instance.name || parentId}`.replaceAll(" ", "-");

    const dockerSummary = instance.nestedDocker?.available
      ? `${instance.nestedDocker.running || 0}/${instance.nestedDocker.total || 0} Docker running`
      : "";

    const node = graphNode(
      id,
      "Incus",
      safe(instance.name, "Unnamed instance"),
      [
        instance.preferredIp ? `IP: ${instance.preferredIp}` : "",
        instance.type ? `Type: ${instance.type}` : "",
        instance.status ? `Status: ${instance.status}` : "",
        dockerSummary
      ].filter(Boolean),
      "",
      "incus-instance-node"
    );

    node.depth = depth;
    addNode(node);
    edges.push(graphEdge(parentId, id, "incus-link"));
  }


  function addWiredPortGroups(sw, parentDepth, parentId) {
    if (!showWired || !(sw.wiredClients || []).length) return;

    const grouped = groupWiredClientsByPort(sw.wiredClients || []);
    const portMetaByNumber = new Map(
      (sw.ports || []).map(port => [String(port.port), port])
    );

    const ports = Object.keys(grouped).sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);

      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });

    if (!ports.length) return;

    const infrastructureCount =
      (sw.childSwitches?.length || 0) +
      (sw.accessPoints?.length || 0) +
      (sw.smartDevices?.length || 0);

    const usePortsGroup = infrastructureCount > 0;

    const groupId = `ports-${sw.mac || sw.name}`.replaceAll(" ", "-");
    const clientCount = sw.wiredClients.length;

    let portParentId = parentId;
    let portDepth = parentDepth + 1;

    if (usePortsGroup) {
      const groupNode = graphNode(
        groupId,
        "Ports",
        `${safe(sw.name)} Wired Ports`,
        [
          `${clientCount} UniFi-learned client${clientCount === 1 ? "" : "s"}`,
          `${ports.length} switch port${ports.length === 1 ? "" : "s"}`,
          "Click to expand ports"
        ],
        "",
        "ports-group-node"
      );

      groupNode.depth = parentDepth + 1;
      addNode(groupNode);
      edges.push(graphEdge(parentId, groupId, "port-link"));

      portParentId = groupId;
      portDepth = parentDepth + 2;
    }

    const portColumnSize = 12;

    for (const [portIndex, port] of ports.entries()) {
      const clients = grouped[port] || [];
      if (!clients.length) continue;

      const portMeta = portMetaByNumber.get(String(port)) || {};
      const configuredPortName =
        portMeta.name ||
        portMeta.configuredName ||
        portMeta.lldpName ||
        portMeta.connectedName ||
        "";

      const incusHost = incusHostForPortName(configuredPortName, data);
      const availableIncusInstances = incusHost?.instances || [];
      const incusInstances = showServices ? availableIncusInstances : [];

      const clientNames = clients.map(client =>
        safe(client.name, client.ip || client.mac || "Unnamed client")
      );

      const firstClient = clients[0] || {};
      const fallbackClientName = safe(
        firstClient.name,
        firstClient.ip || firstClient.mac || "Unnamed client"
      );

      const portId = `port-${sw.mac || sw.name}-${port}`.replaceAll(" ", "-");

      const title = configuredPortName
        ? `Port ${port} → ${configuredPortName}`
        : clients.length === 1
          ? `Port ${port} → ${fallbackClientName}`
          : `Port ${port}`;

      const singleClientName = safe(firstClient.name, "");
      const configuredNameLooksDifferent =
        configuredPortName &&
        singleClientName &&
        !configuredPortName.toLowerCase().includes(singleClientName.toLowerCase()) &&
        !singleClientName.toLowerCase().includes(configuredPortName.toLowerCase());

      const shouldExpandClients = clients.length > 1 || configuredNameLooksDifferent || availableIncusInstances.length > 0;

      const clientSummary = shouldExpandClients
        ? [
            `${clients.length} UniFi-learned client${clients.length === 1 ? "" : "s"}`,
            availableIncusInstances.length
              ? `${availableIncusInstances.length} service / instance${availableIncusInstances.length === 1 ? "" : "s"}${showServices ? "" : " available"}`
              : "",
            `Clients: ${clientNames.slice(0, 3).join(", ")}${clientNames.length > 3 ? `, +${clientNames.length - 3} more` : ""}`,
            portMeta.speed ? `Speed: ${portMeta.speed}` : "",
            `Parent: ${safe(sw.name)}`,
            availableIncusInstances.length && !showServices
              ? "Use Show Services to expand service inventory"
              : "Click to expand"
          ].filter(Boolean)
        : [
            firstClient.ip ? `IP: ${firstClient.ip}` : "",
            firstClient.network ? `Network: ${firstClient.network}` : "",
            firstClient.manufacturer ? `Vendor: ${firstClient.manufacturer}` : "",
            portMeta.speed ? `Speed: ${portMeta.speed}` : "",
            `Parent: ${safe(sw.name)}`
          ].filter(Boolean);

      const portNode = graphNode(
        portId,
        "Port",
        title,
        clientSummary,
        "",
        shouldExpandClients ? "port-node virtual-host-port-node" : "port-node single-client-port-node"
      );

      const wrappedPortDepth = portDepth + Math.floor(portIndex / portColumnSize);

      portNode.depth = wrappedPortDepth;
      addNode(portNode);
      edges.push(graphEdge(portParentId, portId, "port-link"));

      if (showServices && incusInstances.length > 0) {
        const incusColumnSize = 10;

        for (const [index, instance] of incusInstances.entries()) {
          const extraDepth = Math.floor(index / incusColumnSize);
          addIncusInstanceLeaf(instance, wrappedPortDepth + 1 + extraDepth, portId);
        }
      }

      // Only show learned UniFi clients underneath when there is no richer Incus inventory.
      // This avoids making DESKTOP-QKH7QRS look like the parent of the Incus host.
      if (shouldExpandClients && (!showServices || availableIncusInstances.length === 0)) {
        for (const client of clients) {
          addClientLeaf(client, wrappedPortDepth + 1, portId, "Client");
        }
      }
    }
  }


  function addSwitch(sw, depth, parentId) {
    const id = `sw-${sw.mac}`;

    const node = graphNode(
      id,
      "Switch",
      safe(sw.name),
      switchLines(sw),
      safe(sw.status),
      "switch-node"
    );

    const infrastructureCount =
      (sw.childSwitches?.length || 0) +
      (sw.accessPoints?.length || 0) +
      (sw.smartDevices?.length || 0);

    const wiredClientCount = showWired ? (sw.wiredClients?.length || 0) : 0;

    node.depth = depth;
    node.defaultCollapseDirectPorts = infrastructureCount === 0 && wiredClientCount > 0;

    addNode(node);
    edges.push(graphEdge(parentId, id, "switch-link"));

    // Wired clients are shown as physical switch-port relationships.
    // Switches with infrastructure get a compact "Wired Ports" group.
    // Wired-only switches expand directly into port cards.
    addWiredPortGroups(sw, depth, id);

    for (const child of sw.childSwitches || []) {
      addSwitch(child, depth + 1, id);
    }

    for (const ap of sw.accessPoints || []) {
      const apId = `ap-${ap.mac}`;
      const apNode = graphNode(
        apId,
        "AP",
        safe(ap.name),
        apLines(ap),
        safe(ap.status),
        "ap-node"
      );

      apNode.depth = depth + 1;
      addNode(apNode);
      edges.push(graphEdge(id, apId, "ap-link"));

      if (showWireless) {
        const groups = ap.wirelessBySsid || {};

        for (const ssid of Object.keys(groups).sort()) {
          const ssidId = `ssid-${ap.mac}-${ssid}`;
          const ssidNode = graphNode(
            ssidId,
            "SSID",
            `SSID: ${ssid}`,
            [`${groups[ssid].length} wireless clients`, "Click to expand clients"],
            "",
            "ssid-node"
          );

          ssidNode.depth = depth + 2;
          addNode(ssidNode);
          edges.push(graphEdge(apId, ssidId, "ssid-link"));

          for (const client of groups[ssid] || []) {
            addClientLeaf(client, depth + 3, ssidId, "WiFi");
          }
        }
      }
    }

    for (const smart of sw.smartDevices || []) {
      const smartId = `smart-${smart.mac || smart.name}`;
      const smartNode = graphNode(
        smartId,
        "Smart",
        safe(smart.name),
        smartLines(smart),
        safe(smart.status),
        "smart-node"
      );

      smartNode.depth = depth + 1;
      addNode(smartNode);
      edges.push(graphEdge(id, smartId, "smart-link"));
    }
  }

  internet.depth = 0;
  gw.depth = 1;

  for (const sw of rootSwitches) {
    addSwitch(sw, 2, "gateway");
  }

  if (showOtherUnifi) {
    // Kept out of main graph for now. Sidebar summary already shows totals.
  }

  const outgoing = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }

  for (const node of nodes) {
    node.hasChildren = outgoing.has(node.id);
    node.collapsed = collapsedGraphNodes.has(node.id);
  }

  latestGraphExpandableNodeIds = nodes
    .filter(node => node.hasChildren)
    .map(node => node.id);

  latestGraphNodeTypes = new Map(
    nodes.map(node => [node.id, node.type])
  );

  for (const node of nodes) {
    if (!node.hasChildren) continue;
    if (branchUserTouched.has(`graph-${node.id}`)) continue;

    // Initial view rule:
    //   Show the complete physical switch chain.
    //   Hide non-switch detail layers until the user expands them.
    //
    // This keeps:
    //   Internet → Gateway → Switch → Switch → Switch
    //
    // But collapses:
    //   Switch ports
    //   AP SSID/client details
    //   Wired client details
    //
    // AP cards remain visible when attached to switches, but their SSID/client
    // branches start collapsed.
    let collapseByDefault = false;

    if (graphExpansionMode === "clients") {
      // Client expansion opens ports, clients, SSIDs, and wireless clients.
      // Optional service inventory is controlled separately by Show Services.
      collapseByDefault = false;
    } else {
      // Default and physical-map views both show the infrastructure map,
      // but keep detail branches collapsed.
      collapseByDefault =
        node.type === "Ports" ||
        node.type === "Port" ||
        node.type === "SSID" ||
        node.type === "AP" ||
        node.type === "Smart" ||
        node.type === "Wired" ||
        node.defaultCollapseDirectPorts;
    }

    if (collapseByDefault) {
      collapsedGraphNodes.add(node.id);
      node.collapsed = true;
    }
  }

  return { nodes, edges, outgoing };
}

function visibleGraph(fullGraph) {
  const nodeMap = new Map(fullGraph.nodes.map(node => [node.id, node]));
  const visible = new Set();

  function walk(id) {
    const node = nodeMap.get(id);
    if (!node || visible.has(id)) return;

    visible.add(id);

    if (collapsedGraphNodes.has(id)) return;

    for (const childId of fullGraph.outgoing.get(id) || []) {
      walk(childId);
    }
  }

  walk("internet");

  const nodes = fullGraph.nodes.filter(node => visible.has(node.id));
  const edges = fullGraph.edges.filter(edge => visible.has(edge.from) && visible.has(edge.to));

  return { nodes, edges };
}

function layoutGraph(graph) {
  const columns = new Map();

  for (const node of graph.nodes) {
    const depth = node.depth ?? 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth).push(node);
  }

  const sortedDepths = Array.from(columns.keys()).sort((a, b) => a - b);

  // Wrap very tall columns into multiple horizontal lanes.
  // This matters most for Expand Everything, where a large switch may expose
  // many ports, clients, and Incus/service nodes at the same graph depth.
  const MAX_NODES_PER_LANE = 24;
  const LANE_GAP = 42;
  const LANE_WIDTH = GRAPH_CARD_WIDTH + LANE_GAP;

  let cursorX = GRAPH_LEFT;

  for (const depth of sortedDepths) {
    const columnNodes = columns.get(depth) || [];
    const laneCount = Math.max(1, Math.ceil(columnNodes.length / MAX_NODES_PER_LANE));

    for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
      const laneNodes = columnNodes.slice(
        laneIndex * MAX_NODES_PER_LANE,
        (laneIndex + 1) * MAX_NODES_PER_LANE
      );

      let cursorY = GRAPH_TOP;

      for (const node of laneNodes) {
        node.x = cursorX + laneIndex * LANE_WIDTH;
        node.y = cursorY;
        node.height = graphNodeHeight(node);

        cursorY += node.height + GRAPH_ROW_GAP;
      }
    }

    cursorX += laneCount * LANE_WIDTH + 70;
  }

  const width = Math.max(
    1500,
    ...graph.nodes.map(n => n.x + GRAPH_CARD_WIDTH + 160)
  );

  const height = Math.max(
    760,
    ...graph.nodes.map(n => n.y + graphNodeHeight(n) + 120)
  );

  return {
    nodes: graph.nodes,
    edges: graph.edges,
    width,
    height
  };
}

function makeGraphFromTopology(data) {
  const full = makeFullGraphFromTopology(data);
  const visible = visibleGraph(full);
  return layoutGraph(visible);
}

function renderGraphCard(node) {
  const expandableClass = node.hasChildren ? "expandable" : "";
  const collapsedClass = node.collapsed ? "collapsed-node" : "";
  const toggle = node.hasChildren
    ? `<span class="graph-toggle">${node.collapsed ? "+" : "−"}</span>`
    : "";

  return `
    <article
      class="graph-node node-card ${escapeHtml(node.extraClass)} ${expandableClass} ${collapsedClass}"
      style="left:${node.x}px; top:${node.y}px; min-height:${graphNodeHeight(node)}px;"
      data-node-id="${escapeHtml(node.id)}"
      title="${node.hasChildren ? "Click to collapse or expand" : ""}"
    >
      <div class="node-title">
        <span>${escapeHtml(node.title)}</span>
        <span class="node-kind">${escapeHtml(node.type)}</span>
      </div>
      <div class="node-detail">
        ${(node.subtitleLines || []).map(line => escapeHtml(line)).join("<br>")}
      </div>
      ${node.status ? `<div class="node-status">${escapeHtml(node.status)}</div>` : ""}
      ${toggle}
    </article>
  `;
}

function renderGraphLinks(graph) {
  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  function centerRight(node) {
    return {
      x: node.x + GRAPH_CARD_WIDTH,
      y: node.y + graphNodeHeight(node) / 2
    };
  }

  function centerLeft(node) {
    return {
      x: node.x,
      y: node.y + graphNodeHeight(node) / 2
    };
  }

  function pathFor(edge) {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    if (!from || !to) return "";

    const a = centerRight(from);
    const b = centerLeft(to);
    const midX = a.x + Math.max(60, (b.x - a.x) * 0.45);

    return `
      <path
        class="graph-link ${escapeHtml(edge.className || "")}"
        d="M ${a.x} ${a.y} C ${midX} ${a.y}, ${midX} ${b.y}, ${b.x} ${b.y}"
      ></path>
    `;
  }

  return `
    <svg class="graph-link-layer" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}">
      ${graph.edges.map(pathFor).join("")}
    </svg>
  `;
}

function renderPhysicalTopology(data) {
  const gateway = data.gateway || {};
  const graph = makeGraphFromTopology(data);

  return `
    <div id="topologyWorld" class="topology-world graph-world" style="width:${graph.width}px; height:${graph.height + 60}px;">
      ${gatewayBanner(gateway)}
      <div class="graph-map" style="width:${graph.width}px; height:${graph.height}px;">
        ${renderGraphLinks(graph)}
        ${graph.nodes.map(renderGraphCard).join("")}
      </div>
    </div>
  `;
}

function handleGraphNodeClick(event) {
  const card = event.target.closest(".graph-node.expandable");
  if (!card) return;

  event.preventDefault();
  event.stopPropagation();

  const id = card.dataset.nodeId;
  if (!id) return;

  branchUserTouched.add(`graph-${id}`);

  if (collapsedGraphNodes.has(id)) {
    collapsedGraphNodes.delete(id);
  } else {
    collapsedGraphNodes.add(id);
  }

  if (latestTopology) {
    renderTopology(latestTopology);
  }
}

function attachGraphHandlers() {
  const canvas = document.getElementById("topologyCanvas");
  if (!canvas || canvas.dataset.graphClickHandlerAttached === "true") return;

  canvas.addEventListener("click", handleGraphNodeClick, true);
  canvas.dataset.graphClickHandlerAttached = "true";
}

function drawConnectors() {
  // The graph renderer draws persistent SVG links directly in the markup.
}

function renderTopology(data) {
  document.getElementById("topologyCanvas").innerHTML = renderPhysicalTopology(data);
  attachBranchHandlers();
  attachGraphHandlers();
  applyGraphVisualClasses();
  applyTransform();
}

function attachBranchHandlers() {
  document.querySelectorAll(".branch-header").forEach(header => {
    header.addEventListener("click", () => {
      const branchEl = header.closest(".branch");
      const id = branchEl.dataset.branch;

      branchUserTouched.add(id);

      if (collapsedBranches.has(id)) collapsedBranches.delete(id);
      else collapsedBranches.add(id);

      if (latestTopology) renderTopology(latestTopology);
    });
  });
}

async function refresh() {
  const statusPill = document.getElementById("statusPill");
  const statusOutput = document.getElementById("statusOutput");
  const lastRefresh = document.getElementById("lastRefresh");

  try {
    const status = await getJson("/api/status");
    const topology = await getJson("/api/topology");

    latestTopology = topology;

    statusPill.textContent = "Running";
    statusPill.classList.add("good");
    statusPill.classList.remove("bad");

    const statusSummary = {
      status: status.status,
      port: status.port,
      configLoaded: status.configLoaded,
      site: status.unifi?.site,
      sessionCached: status.unifi?.sessionCached,
      lastLoginStatus: status.unifi?.lastLoginStatus,
      lastLoginMessage: status.unifi?.lastLoginMessage
    };

    if (statusOutput) {
      statusOutput.textContent = JSON.stringify(statusSummary, null, 2);
    }

    const gateway = topology.gateway || {};
    const versions = topology.versions || {};
    lastRefresh.innerHTML =
      `${escapeHtml(safe(gateway.name))} · ${escapeHtml(safe(gateway.model))} · ` +
      versionBadges(versions) +
      ` · Last refresh: ${escapeHtml(new Date(topology.generatedAt).toLocaleString())}`;

    renderSummary(topology);
    updateServiceInventoryButton();
    renderTopology(topology);
  } catch (err) {
    statusPill.textContent = "Error";
    statusPill.classList.remove("good");
    statusPill.classList.add("bad");
    if (statusOutput) {
      statusOutput.textContent = err.message;
    } else {
      console.error("Topology refresh failed:", err);
    }
    document.getElementById("topologyCanvas").innerHTML = `<div class="loading">Unable to load topology.</div>`;
  }
}

function documentEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function exportClientRows(clients) {
  if (!clients || !clients.length) {
    return `<p class="empty">None detected.</p>`;
  }

  return `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>IP</th>
          <th>MAC</th>
          <th>Port / SSID</th>
          <th>Network</th>
          <th>Vendor / Model</th>
        </tr>
      </thead>
      <tbody>
        ${clients.map(client => `
          <tr>
            <td>${documentEscape(client.name)}</td>
            <td>${documentEscape(client.ip)}</td>
            <td>${documentEscape(client.mac)}</td>
            <td>${documentEscape(client.switchPort || client.ssid || "")}</td>
            <td>${documentEscape(client.network)}</td>
            <td>${documentEscape(client.manufacturer || client.model || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function exportPortSummary(sw) {
  const rows = [];

  for (const child of sw.childSwitches || []) {
    rows.push({
      port: child.uplinkPort,
      type: "Downstream switch",
      name: child.name,
      ip: child.ip,
      model: child.model
    });
  }

  for (const ap of sw.accessPoints || []) {
    rows.push({
      port: ap.uplinkPort,
      type: "Access point",
      name: ap.name,
      ip: ap.ip,
      model: ap.model
    });
  }

  for (const smart of sw.smartDevices || []) {
    rows.push({
      port: smart.uplinkPort,
      type: "UniFi smart device",
      name: smart.name,
      ip: smart.ip,
      model: smart.model
    });
  }

  const grouped = groupWiredClientsByPort(sw.wiredClients || []);
  for (const port of Object.keys(grouped).sort((a, b) => Number(a) - Number(b))) {
    const clients = grouped[port];
    rows.push({
      port,
      type: "Wired clients",
      name: `${clients.length} client${clients.length === 1 ? "" : "s"}`,
      ip: clients.map(c => c.ip).filter(Boolean).join(", "),
      model: clients.map(c => c.name).filter(Boolean).join(", ")
    });
  }

  if (!rows.length) {
    return `<p class="empty">No port attachments detected.</p>`;
  }

  return `
    <table>
      <thead>
        <tr>
          <th>Port</th>
          <th>Type</th>
          <th>Name / Count</th>
          <th>IP / Details</th>
          <th>Model / Clients</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            <td>${documentEscape(row.port || "Unknown")}</td>
            <td>${documentEscape(row.type)}</td>
            <td>${documentEscape(row.name)}</td>
            <td>${documentEscape(row.ip || "")}</td>
            <td>${documentEscape(row.model || "")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function exportSsidSummary(ap) {
  const groups = ap.wirelessBySsid || {};
  const ssids = Object.keys(groups);

  if (!ssids.length) {
    return `<p class="empty">No wireless clients detected.</p>`;
  }

  return ssids.map(ssid => `
    <h5>SSID: ${documentEscape(ssid)} — ${groups[ssid].length} client${groups[ssid].length === 1 ? "" : "s"}</h5>
    ${exportClientRows(groups[ssid])}
  `).join("");
}

function exportSwitchSection(sw, depth = 0) {
  return `
    <section class="device-section depth-${depth}">
      <h3>${documentEscape(sw.name)}</h3>
      <p>
        <strong>Type:</strong> Switch<br>
        <strong>Model:</strong> ${documentEscape(sw.model)}<br>
        <strong>IP:</strong> ${documentEscape(sw.ip)}<br>
        <strong>Uplink port:</strong> ${documentEscape(sw.uplinkPort || "Root / unknown")}<br>
        <strong>Status:</strong> ${documentEscape(sw.status)}
      </p>

      <h4>Ports and attachments</h4>
      ${exportPortSummary(sw)}

      ${(sw.accessPoints || []).map(ap => `
        <section class="device-section depth-${depth + 1}">
          <h3>${documentEscape(ap.name)}</h3>
          <p>
            <strong>Type:</strong> Access Point<br>
            <strong>Model:</strong> ${documentEscape(ap.model)}<br>
            <strong>IP:</strong> ${documentEscape(ap.ip)}<br>
            <strong>Uplink port:</strong> ${documentEscape(ap.uplinkPort || "Unknown")}<br>
            <strong>Status:</strong> ${documentEscape(ap.status)}
          </p>
          <h4>SSIDs and wireless clients</h4>
          ${exportSsidSummary(ap)}
        </section>
      `).join("")}

      ${(sw.smartDevices || []).map(device => `
        <section class="device-section depth-${depth + 1}">
          <h3>${documentEscape(device.name)}</h3>
          <p>
            <strong>Type:</strong> UniFi Smart Device<br>
            <strong>Model:</strong> ${documentEscape(device.model)}<br>
            <strong>IP:</strong> ${documentEscape(device.ip)}<br>
            <strong>Uplink port:</strong> ${documentEscape(device.uplinkPort || "Unknown")}<br>
            <strong>Status:</strong> ${documentEscape(device.status)}
          </p>
        </section>
      `).join("")}

      ${(sw.childSwitches || []).map(child => exportSwitchSection(child, depth + 1)).join("")}
    </section>
  `;
}

function buildExportHtml(data) {
  const gateway = data.gateway || {};
  const physical = data.physicalTopology || {};
  const counts = data.counts || {};
  const generated = new Date(data.generatedAt || Date.now()).toLocaleString();

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ScottiBYTE UniFi Topology Export</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #ffffff;
      color: #111827;
      margin: 2rem;
      line-height: 1.35;
    }
    h1, h2, h3, h4, h5 {
      margin-bottom: 0.35rem;
    }
    h1 {
      border-bottom: 3px solid #0ea5e9;
      padding-bottom: 0.5rem;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(180px, 1fr));
      gap: 0.75rem;
      margin: 1rem 0 1.5rem;
    }
    .summary-card {
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 0.8rem;
      background: #f8fafc;
    }
    .summary-card strong {
      font-size: 1.4rem;
      color: #0369a1;
      display: block;
    }
    .gateway {
      border: 1px solid #0ea5e9;
      border-radius: 12px;
      padding: 1rem;
      background: #f0f9ff;
      margin: 1rem 0;
    }
    .device-section {
      border-left: 4px solid #0ea5e9;
      padding-left: 1rem;
      margin: 1.2rem 0;
      page-break-inside: avoid;
    }
    .depth-1 { margin-left: 1rem; border-left-color: #0284c7; }
    .depth-2 { margin-left: 2rem; border-left-color: #7c3aed; }
    .depth-3 { margin-left: 3rem; border-left-color: #9333ea; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.6rem 0 1rem;
      font-size: 0.9rem;
    }
    th, td {
      border: 1px solid #cbd5e1;
      padding: 0.45rem 0.55rem;
      vertical-align: top;
      text-align: left;
    }
    th {
      background: #e2e8f0;
    }
    .empty {
      color: #64748b;
      font-style: italic;
    }
    @media print {
      body { margin: 0.6in; }
      .device-section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>ScottiBYTE UniFi Topology Export</h1>
  <p>Generated: ${documentEscape(generated)}</p>

  <section class="gateway">
    <h2>${documentEscape(gateway.name)}</h2>
    <p>
      <strong>Model:</strong> ${documentEscape(gateway.model)}<br>
      <strong>WAN:</strong> ${documentEscape(gateway.wanIp)}<br>
      <strong>Primary LAN:</strong> ${documentEscape(gateway.primaryLanGateway)}<br>
      <strong>Status:</strong> ${documentEscape(gateway.status)}
    </p>
  </section>

  <section class="summary">
    <div class="summary-card"><strong>${documentEscape(counts.switches ?? 0)}</strong>Switches</div>
    <div class="summary-card"><strong>${documentEscape(counts.accessPoints ?? 0)}</strong>Access Points</div>
    <div class="summary-card"><strong>${documentEscape(counts.smartDevices ?? 0)}</strong>UniFi Smart Devices</div>
    <div class="summary-card"><strong>${documentEscape(counts.wiredClients ?? 0)}</strong>Wired Clients</div>
    <div class="summary-card"><strong>${documentEscape(counts.wirelessClients ?? 0)}</strong>Wireless Clients</div>
    <div class="summary-card"><strong>${documentEscape(counts.possibleUnifiHardwareClients ?? 0)}</strong>Possible UniFi Ecosystem Clients</div>
  </section>

  <h2>Infrastructure Flowdown</h2>
  ${(physical.rootSwitches || []).map(sw => exportSwitchSection(sw, 0)).join("")}

  ${(physical.orphanAccessPoints || []).length ? `
    <h2>Access Points Without Switch Parent</h2>
    ${(physical.orphanAccessPoints || []).map(ap => `
      <section class="device-section">
        <h3>${documentEscape(ap.name)}</h3>
        <p>
          <strong>Model:</strong> ${documentEscape(ap.model)}<br>
          <strong>IP:</strong> ${documentEscape(ap.ip)}<br>
          <strong>Status:</strong> ${documentEscape(ap.status)}
        </p>
        ${exportSsidSummary(ap)}
      </section>
    `).join("")}
  ` : ""}

  <h2>Possible UniFi Ecosystem Clients</h2>
  ${exportClientRows(data.possibleUnifiHardwareClients || [])}

  <h2>All Wired Clients</h2>
  ${exportClientRows(data.wiredClients || [])}

  <h2>All Wireless Clients</h2>
  ${exportClientRows(data.wirelessClients || [])}
</body>
</html>`;
}

function exportHtml() {
  if (!latestTopology) {
    alert("Topology data has not loaded yet.");
    return;
  }

  const html = buildExportHtml(latestTopology);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "unifi-topology-documentation.html";
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("refreshBtn").addEventListener("click", refresh);
document.getElementById("exportBtn").addEventListener("click", exportHtml);

document.getElementById("zoomOutBtn").addEventListener("click", () => zoomAtCenter(0.85));
document.getElementById("zoomInBtn").addEventListener("click", () => zoomAtCenter(1.15));
document.getElementById("resetViewBtn").addEventListener("click", resetView);

const expandAllButton = document.getElementById("expandAllBtn");

if (expandAllButton) {
  expandAllButton.textContent = "Expand Clients";
  expandAllButton.title = "Expand ports, SSIDs, UniFi clients, and wireless clients. Use Show Services for optional Blast Radius / Incus service inventory.";

  if (!document.getElementById("expandNetworkBtn")) {
    const expandNetworkButton = document.createElement("button");
    expandNetworkButton.id = "expandNetworkBtn";
    expandNetworkButton.type = "button";
    expandNetworkButton.textContent = "Expand Physical Map";
    expandNetworkButton.title = "Expand the physical UniFi map: switches, APs, and port groups, while keeping detailed clients and Incus instances collapsed.";

    expandAllButton.parentNode.insertBefore(expandNetworkButton, expandAllButton);

    expandNetworkButton.addEventListener("click", () => {
      graphExpansionMode = "physical";
      collapsedBranches.clear();
      collapsedGraphNodes.clear();
      branchUserTouched.clear();

      if (latestTopology) renderTopology(latestTopology);
      resetView();
    });
  }
}


if (expandAllButton && !document.getElementById("toggleServicesBtn")) {
  const toggleServicesButton = document.createElement("button");
  toggleServicesButton.id = "toggleServicesBtn";
  toggleServicesButton.type = "button";

  expandAllButton.parentNode.insertBefore(toggleServicesButton, expandAllButton.nextSibling);

  toggleServicesButton.addEventListener("click", () => {
    showServiceInventory = !showServiceInventory;
    updateServiceInventoryButton();

    // Services live below expanded ports / client branches.
    // If the user asks to show services, move into client-expanded mode
    // so the service layer is actually visible instead of hidden behind
    // collapsed physical-map port groups.
    graphExpansionMode = "clients";
    collapsedGraphNodes.clear();
    collapsedBranches.clear();
    branchUserTouched.clear();

    if (latestTopology) renderTopology(latestTopology);
    resetView();
  });

  updateServiceInventoryButton();
}

document.getElementById("collapseAllBtn").addEventListener("click", () => {
  restoreDefaultTopologyView();

  if (latestTopology) renderTopology(latestTopology);

  // Return to the same useful starting position as the original load.
  resetView();
});

document.getElementById("expandAllBtn").addEventListener("click", () => {
  graphExpansionMode = "clients";
  collapsedGraphNodes.clear();
  collapsedBranches.clear();
  branchUserTouched.clear();

  if (latestTopology) renderTopology(latestTopology);
  resetView();
});

["showWiredClients", "showWirelessClients", "showOtherUnifi"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    if (latestTopology) renderTopology(latestTopology);
  });
});

attachPanZoomHandlers();
resetView();
setupHeaderActions();
refresh();
setInterval(refresh, 30000);


// === sb-unifi-topology-legend-card ===
function replaceConnectionCardWithLegend() {
  const cards = Array.from(document.querySelectorAll(".card, .panel, .sidebar-card, .control-card, section, .sidebar > div"));
  const connectionCard = cards.find(card => {
    const text = (card.textContent || "").trim();
    return /Connection/i.test(text) && card.querySelector("pre");
  });

  if (!connectionCard) return;

  const title = connectionCard.querySelector("h1,h2,h3,h4,.card-title,.panel-title,strong");
  if (title) title.textContent = "Legend";

  const pre = connectionCard.querySelector("pre");
  if (!pre) return;

  pre.outerHTML = `
    <div class="legend-list">
      <div class="legend-item"><span class="legend-swatch internet"></span><span>Internet / WAN</span></div>
      <div class="legend-item"><span class="legend-swatch gateway"></span><span>Gateway</span></div>
      <div class="legend-item"><span class="legend-swatch switch"></span><span>Switch</span></div>
      <div class="legend-item"><span class="legend-swatch ap"></span><span>Access Point</span></div>
      <div class="legend-item"><span class="legend-swatch port-group"></span><span>Port Group</span></div>
      <div class="legend-item"><span class="legend-swatch port"></span><span>Individual Port</span></div>
      <div class="legend-item"><span class="legend-swatch client"></span><span>Regular Client</span></div>
      <div class="legend-item"><span class="legend-swatch incus"></span><span>Incus / Service Node</span></div>
      <div class="legend-note">
        Expand Physical Map = physical infrastructure and collapsed port groups.<br>
        Expand Clients = ports, UniFi clients, and wireless clients.<br>
        Add Incus Services = overlays optional Incus service inventory when configured.
      </div>
    </div>
  `;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", replaceConnectionCardWithLegend);
} else {
  replaceConnectionCardWithLegend();
}


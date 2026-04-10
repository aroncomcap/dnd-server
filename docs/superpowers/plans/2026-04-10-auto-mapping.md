# Auto-Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three-level auto-mapping system (World/Location/Detail) that builds progressively as players explore, with fog of war, three visual styles, and hybrid UI placement.

**Architecture:** Server-side `map-engine.js` manages the map graph (nodes, edges, fog of war, positioning). Claude outputs a `MAP: <location>` hint per turn. Client-side `map-renderer.js` renders SVG maps with three selectable styles. Maps live in a desktop sidebar, mobile tab, and inline chat snapshots.

**Tech Stack:** SVG (client-side rendering), existing Socket.io for real-time updates, existing `game_state` DB for persistence. No new dependencies.

---

### Task 1: Map Engine — Core Data Model

**Files:**
- Create: `map-engine.js`

- [ ] **Step 1: Create map-engine.js with the MapGraph class**

```js
// map-engine.js
class MapGraph {
  constructor(data = null) {
    // nodes: { [name]: { x, y, level, parent, revealed, visited, connections, description, distance } }
    // playerLocation: string
    // activeLevel: 'world' | 'location' | 'detail'
    this.nodes = {};
    this.playerLocation = null;
    this.activeLevel = 'world';
    if (data) {
      this.nodes = data.nodes || {};
      this.playerLocation = data.playerLocation || null;
      this.activeLevel = data.activeLevel || 'world';
    }
  }

  toJSON() {
    return {
      nodes: this.nodes,
      playerLocation: this.playerLocation,
      activeLevel: this.activeLevel,
    };
  }

  getNode(name) {
    // Case-insensitive lookup
    const key = Object.keys(this.nodes).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? this.nodes[key] : null;
  }

  getNodeKey(name) {
    return Object.keys(this.nodes).find(k => k.toLowerCase() === name.toLowerCase()) || name;
  }

  addNode(name, opts = {}) {
    const key = this.getNodeKey(name);
    if (this.nodes[key]) {
      // Merge new data into existing
      Object.assign(this.nodes[key], opts);
      return this.nodes[key];
    }
    this.nodes[key] = {
      x: opts.x ?? null,
      y: opts.y ?? null,
      level: opts.level || 'world',
      parent: opts.parent || null,
      revealed: opts.revealed ?? false,
      visited: opts.visited ?? false,
      connections: opts.connections || [],
      description: opts.description || '',
      distance: opts.distance || '',
    };
    return this.nodes[key];
  }

  addConnection(from, to) {
    const fromKey = this.getNodeKey(from);
    const toKey = this.getNodeKey(to);
    const fromNode = this.nodes[fromKey];
    const toNode = this.nodes[toKey];
    if (fromNode && !fromNode.connections.includes(toKey)) fromNode.connections.push(toKey);
    if (toNode && !toNode.connections.includes(fromKey)) toNode.connections.push(fromKey);
  }

  moveTo(name) {
    const key = this.getNodeKey(name);
    let node = this.nodes[key];
    if (!node) {
      node = this.addNode(name);
    }
    // If we had a previous location, add connection
    if (this.playerLocation && this.playerLocation !== key) {
      this.addConnection(this.playerLocation, key);
    }
    node.revealed = true;
    node.visited = true;
    // Reveal connections
    for (const conn of node.connections) {
      const connNode = this.nodes[conn];
      if (connNode) connNode.revealed = true;
    }
    const isNew = this.playerLocation !== key;
    this.playerLocation = key;
    // Determine active level
    if (node.level) this.activeLevel = node.level;
    return { isNew, node };
  }

  revealNode(name) {
    const key = this.getNodeKey(name);
    const node = this.nodes[key];
    if (node) {
      node.revealed = true;
      return true;
    }
    return false;
  }

  // Auto-position a new node near its connections
  autoPosition(name) {
    const key = this.getNodeKey(name);
    const node = this.nodes[key];
    if (!node || (node.x !== null && node.y !== null)) return;

    const connected = node.connections
      .map(c => this.nodes[c])
      .filter(n => n && n.x !== null && n.y !== null);

    if (connected.length === 0) {
      // First node or no positioned connections — place at center
      const existing = Object.values(this.nodes).filter(n => n.x !== null);
      if (existing.length === 0) {
        node.x = 400;
        node.y = 300;
      } else {
        // Place at a random offset from the centroid of existing nodes
        const cx = existing.reduce((s, n) => s + n.x, 0) / existing.length;
        const cy = existing.reduce((s, n) => s + n.y, 0) / existing.length;
        const angle = Math.random() * Math.PI * 2;
        node.x = cx + Math.cos(angle) * 120;
        node.y = cy + Math.sin(angle) * 120;
      }
    } else {
      // Average position of connected nodes + offset
      const cx = connected.reduce((s, n) => s + n.x, 0) / connected.length;
      const cy = connected.reduce((s, n) => s + n.y, 0) / connected.length;
      // Offset away from centroid of all connections
      const angle = Math.atan2(cy - 300, cx - 400) + Math.PI + (Math.random() - 0.5);
      node.x = cx + Math.cos(angle) * 100;
      node.y = cy + Math.sin(angle) * 100;
    }
  }

  // Sync world locations from the ---WORLD--- data into the map
  syncFromWorldData(worldLocations) {
    if (!worldLocations) return;
    for (const loc of worldLocations) {
      const existing = this.getNode(loc.name);
      if (!existing) {
        // Add as skeleton node (hidden, no position)
        this.addNode(loc.name, {
          description: loc.description,
          distance: loc.distance,
          level: 'world',
        });
      } else {
        // Update description/distance if changed
        const key = this.getNodeKey(loc.name);
        if (loc.description) this.nodes[key].description = loc.description;
        if (loc.distance) this.nodes[key].distance = loc.distance;
      }
    }
  }

  // Get nodes for a specific zoom level
  getNodesForLevel(level) {
    return Object.entries(this.nodes)
      .filter(([_, n]) => n.level === level && n.revealed)
      .map(([name, n]) => ({ name, ...n }));
  }
}

// Process a turn: extract MAP hint, update graph
function processMapHint(mapGraph, worldRaw, worldLocations) {
  let currentLocation = null;

  // Extract MAP: line from world raw text
  if (worldRaw) {
    const mapMatch = worldRaw.match(/^MAP:\s*(.+)$/im);
    if (mapMatch) {
      currentLocation = mapMatch[1].trim();
    }
  }

  // Sync world locations into the graph
  if (worldLocations) {
    mapGraph.syncFromWorldData(worldLocations);
  }

  let result = { moved: false, isNew: false, location: null };

  if (currentLocation) {
    const { isNew, node } = mapGraph.moveTo(currentLocation);
    mapGraph.autoPosition(currentLocation);
    result = { moved: true, isNew, location: currentLocation };
  }

  return result;
}

module.exports = { MapGraph, processMapHint };
```

- [ ] **Step 2: Commit**

```bash
git add map-engine.js
git commit -m "feat: add map-engine.js with MapGraph class and processMapHint"
```

---

### Task 2: Server Integration — Parse MAP hint, emit updates

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Import map-engine and integrate into game state**

At the top of `server.js`, after the existing requires:
```js
const { MapGraph, processMapHint } = require('./map-engine');
```

In `getGameState()`, add `mapGraph` to the per-game state:
```js
mapGraph: new MapGraph(),
```

In the `game_joined` handler, after loading from DB, restore the map:
```js
// After: gs.world = await db.getState(gameId, 'world', ...);
const mapData = await db.getState(gameId, 'map', null);
if (mapData) gs.mapGraph = new MapGraph(mapData);
```

Add `mapGraph` to the `game_joined` emit payload:
```js
mapState: gs.mapGraph.toJSON(),
```

- [ ] **Step 2: Process MAP hint after each Claude call**

In `callClaude()`, after the existing world-saving block (`if (parsed.world)`), add:

```js
// Process map hint
const mapResult = processMapHint(gs.mapGraph, worldRaw, parsed.world?.locations);
if (mapResult.moved) {
  await db.setState(gameId, 'map', gs.mapGraph.toJSON());
  io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
  if (mapResult.isNew) {
    io.to(gameId).emit('map_inline', {
      location: mapResult.location,
      mapState: gs.mapGraph.toJSON(),
    });
  }
}
```

Note: `worldRaw` is the raw world block text. It's already available in `parseResponse()` — save it to a variable before parsing sections. Modify `parseResponse()` to return `worldRaw` alongside the parsed world object:

In the return statement of `parseResponse()`:
```js
return { narration, options, scene, world, isKillshot, worldRaw: worldRaw || '' };
```

Then in `callClaude()`, after `const parsed = parseResponse(reply);`:
```js
const mapResult = processMapHint(gs.mapGraph, parsed.worldRaw, parsed.world?.locations);
```

- [ ] **Step 3: Add MAP hint to system prompt**

In `buildSystemPrompt()`, add to the `---WORLD---` output format instructions, after the CHAR_UPDATES section:

```
MAP: [Current location name — where the party is RIGHT NOW after this turn's action]
```

- [ ] **Step 4: Add socket handlers for manual reveal and map style**

```js
socket.on('reveal_location', async (data) => {
  const gameId = socket.gameId;
  if (!gameId) return;
  const gs = getGameState(gameId);
  if (gs.mapGraph.revealNode(data.name)) {
    await db.setState(gameId, 'map', gs.mapGraph.toJSON());
    io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
    emitSystem(gameId, { text: `🗺️ Revealed: ${data.name}` });
  }
});

socket.on('set_map_style', (data) => {
  const gameId = socket.gameId;
  if (!gameId) return;
  const gs = getGameState(gameId);
  gs.mapStyle = data.style; // 'parchment' | 'dark' | 'tactical'
  io.to(gameId).emit('map_style_changed', { style: data.style });
});
```

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: integrate map-engine into server, parse MAP hint, emit updates"
```

---

### Task 3: Client Map Renderer

**Files:**
- Create: `public/map-renderer.js`

- [ ] **Step 1: Create the SVG map renderer**

```js
// public/map-renderer.js
// Three visual styles for the auto-map

const MAP_STYLES = {
  parchment: {
    bg: '#e8d5b0',
    nodeFill: '#f5ead688',
    nodeStroke: '#5c3d1e',
    nodeStrokeWidth: 2,
    edgeColor: '#5c3d1e',
    labelColor: '#5c3d1e',
    labelFont: 'serif',
    fogColor: 'rgba(232,213,176,0.85)',
    playerColor: '#c8922a',
    playerGlow: '#c8922a',
    visitedOpacity: 0.5,
    currentOpacity: 1.0,
    gridColor: '#5c3d1e22',
    enemyColor: '#8b2020',
  },
  dark: {
    bg: '#0a0a15',
    nodeFill: '#c8922a11',
    nodeStroke: '#c8922a88',
    nodeStrokeWidth: 1,
    edgeColor: '#c8922a44',
    labelColor: '#c8922a99',
    labelFont: 'monospace',
    fogColor: 'rgba(10,10,21,0.9)',
    playerColor: '#f0c060',
    playerGlow: '#c8922a',
    visitedOpacity: 0.4,
    currentOpacity: 1.0,
    gridColor: '#ffffff11',
    enemyColor: '#cc3333',
  },
  tactical: {
    bg: '#1a1a1a',
    nodeFill: '#333333',
    nodeStroke: '#666666',
    nodeStrokeWidth: 1,
    edgeColor: '#555555',
    labelColor: '#aaaaaa',
    labelFont: 'sans-serif',
    fogColor: 'rgba(0,0,0,0.8)',
    playerColor: '#c8922a',
    playerGlow: '#f0c060',
    visitedOpacity: 0.3,
    currentOpacity: 1.0,
    gridColor: '#ffffff15',
    enemyColor: '#cc3333',
  },
};

class MapRenderer {
  constructor(container, style = 'dark') {
    this.container = container;
    this.style = MAP_STYLES[style] || MAP_STYLES.dark;
    this.styleName = style;
    this.mapState = null;
    this.activeLevel = 'world';
    this.svg = null;
    this.onNodeClick = null; // callback(nodeName)
    this.init();
  }

  init() {
    this.container.innerHTML = '';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('width', '100%');
    this.svg.setAttribute('height', '100%');
    this.svg.style.background = this.style.bg;
    this.svg.style.borderRadius = '8px';
    this.container.appendChild(this.svg);
  }

  setStyle(styleName) {
    this.style = MAP_STYLES[styleName] || MAP_STYLES.dark;
    this.styleName = styleName;
    this.svg.style.background = this.style.bg;
    if (this.mapState) this.render();
  }

  setLevel(level) {
    this.activeLevel = level;
    if (this.mapState) this.render();
  }

  update(mapState) {
    this.mapState = mapState;
    this.activeLevel = mapState.activeLevel || 'world';
    this.render();
  }

  render() {
    if (!this.mapState) return;
    const s = this.style;
    const nodes = this.mapState.nodes;
    const playerLoc = this.mapState.playerLocation;

    // Clear SVG
    this.svg.innerHTML = '';

    // Get viewBox bounds from positioned nodes
    const positioned = Object.entries(nodes)
      .filter(([_, n]) => n.x !== null && n.y !== null && n.revealed);

    if (positioned.length === 0) {
      // Empty map
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', '50%');
      text.setAttribute('y', '50%');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', s.labelColor);
      text.setAttribute('font-family', s.labelFont);
      text.setAttribute('font-size', '14');
      text.textContent = 'No locations discovered yet';
      this.svg.appendChild(text);
      return;
    }

    // Calculate bounds
    const xs = positioned.map(([_, n]) => n.x);
    const ys = positioned.map(([_, n]) => n.y);
    const padding = 80;
    const minX = Math.min(...xs) - padding;
    const maxX = Math.max(...xs) + padding;
    const minY = Math.min(...ys) - padding;
    const maxY = Math.max(...ys) + padding;
    this.svg.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);

    // Draw grid for tactical style
    if (this.styleName === 'tactical') {
      const gridGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      gridGroup.setAttribute('opacity', '0.15');
      for (let x = Math.floor(minX / 30) * 30; x < maxX; x += 30) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x); line.setAttribute('y1', minY);
        line.setAttribute('x2', x); line.setAttribute('y2', maxY);
        line.setAttribute('stroke', '#555'); line.setAttribute('stroke-width', '0.5');
        gridGroup.appendChild(line);
      }
      for (let y = Math.floor(minY / 30) * 30; y < maxY; y += 30) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', minX); line.setAttribute('y1', y);
        line.setAttribute('x2', maxX); line.setAttribute('y2', y);
        line.setAttribute('stroke', '#555'); line.setAttribute('stroke-width', '0.5');
        gridGroup.appendChild(line);
      }
      this.svg.appendChild(gridGroup);
    }

    // Draw edges
    for (const [name, node] of positioned) {
      if (!node.connections) continue;
      for (const conn of node.connections) {
        const target = nodes[conn];
        if (!target || target.x === null || !target.revealed) continue;
        // Avoid drawing duplicates
        if (name < conn) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', node.x); line.setAttribute('y1', node.y);
          line.setAttribute('x2', target.x); line.setAttribute('y2', target.y);
          line.setAttribute('stroke', s.edgeColor);
          line.setAttribute('stroke-width', '2');
          if (this.styleName === 'dark') {
            line.setAttribute('filter', 'url(#glow)');
          }
          this.svg.appendChild(line);
        }
      }
    }

    // Draw nodes
    for (const [name, node] of positioned) {
      const isCurrent = name === playerLoc;
      const opacity = isCurrent ? s.currentOpacity : (node.visited ? s.visitedOpacity : 0.3);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('opacity', opacity);
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => {
        if (this.onNodeClick) this.onNodeClick(name);
      });

      // Node shape
      const nodeW = 80;
      const nodeH = 40;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', node.x - nodeW / 2);
      rect.setAttribute('y', node.y - nodeH / 2);
      rect.setAttribute('width', nodeW);
      rect.setAttribute('height', nodeH);
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', s.nodeFill);
      rect.setAttribute('stroke', isCurrent ? s.playerColor : s.nodeStroke);
      rect.setAttribute('stroke-width', isCurrent ? 2 : s.nodeStrokeWidth);
      g.appendChild(rect);

      // Label
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', node.x);
      label.setAttribute('y', node.y + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', isCurrent ? s.playerColor : s.labelColor);
      label.setAttribute('font-family', s.labelFont);
      label.setAttribute('font-size', '10');
      label.textContent = name.length > 12 ? name.slice(0, 11) + '…' : name;
      g.appendChild(label);

      this.svg.appendChild(g);
    }

    // Draw player token
    if (playerLoc && nodes[playerLoc] && nodes[playerLoc].x !== null) {
      const pn = nodes[playerLoc];
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', pn.x);
      circle.setAttribute('cy', pn.y - 28);
      circle.setAttribute('r', '6');
      circle.setAttribute('fill', s.playerColor);
      // Glow
      const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      glow.setAttribute('cx', pn.x);
      glow.setAttribute('cy', pn.y - 28);
      glow.setAttribute('r', '10');
      glow.setAttribute('fill', 'none');
      glow.setAttribute('stroke', s.playerGlow);
      glow.setAttribute('stroke-width', '1');
      glow.setAttribute('opacity', '0.5');
      this.svg.appendChild(glow);
      this.svg.appendChild(circle);
    }
  }

  // Generate a static snapshot as data URL (for inline chat)
  toDataURL() {
    const svgData = new XMLSerializer().serializeToString(this.svg);
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  }
}

// Export for use as module or global
if (typeof module !== 'undefined') module.exports = { MapRenderer, MAP_STYLES };
if (typeof window !== 'undefined') window.MapRenderer = MapRenderer;
```

- [ ] **Step 2: Commit**

```bash
git add public/map-renderer.js
git commit -m "feat: add client-side SVG map renderer with 3 styles"
```

---

### Task 4: Game Page UI — Map Sidebar, Tab, and Inline

**Files:**
- Modify: `public/game.html`

- [ ] **Step 1: Add map container to game screen and a Map nav tab**

In the HTML, add a map sidebar div inside `#screen-game`, after the scene panel:
```html
<div id="map-sidebar" style="display:none;">
  <div class="panel" style="height:100%;display:flex;flex-direction:column;padding:8px;">
    <div style="display:flex;gap:4px;margin-bottom:6px;">
      <button class="map-level-btn active" data-level="world">🌍 World</button>
      <button class="map-level-btn" data-level="location">🏰 Location</button>
      <button class="map-level-btn" data-level="detail">🚪 Detail</button>
    </div>
    <div id="map-container" style="flex:1;min-height:200px;"></div>
  </div>
</div>
```

Add a Map button to the nav bar (between Party and World):
```html
<button data-screen="map">
  <span class="nav-icon">🗺️</span><span id="map-badge"></span>Map
</button>
```

Add a full-screen map screen for mobile:
```html
<div id="screen-map" class="screen">
  <div class="panel" style="flex:1;display:flex;flex-direction:column;padding:8px;">
    <div style="display:flex;gap:4px;margin-bottom:6px;">
      <button class="map-level-btn-mobile" data-level="world">🌍 World</button>
      <button class="map-level-btn-mobile" data-level="location">🏰 Location</button>
      <button class="map-level-btn-mobile" data-level="detail">🚪 Detail</button>
    </div>
    <div id="map-container-mobile" style="flex:1;min-height:300px;"></div>
  </div>
</div>
```

- [ ] **Step 2: Add CSS for map components**

```css
.map-level-btn, .map-level-btn-mobile {
  flex: 1;
  padding: 4px;
  background: #3d2510;
  border: 1px solid #c8922a44;
  border-radius: 4px;
  color: #c8922a;
  font-family: 'Crimson Pro', serif;
  font-size: 0.7rem;
  cursor: pointer;
  text-align: center;
}
.map-level-btn.active, .map-level-btn-mobile.active {
  background: #c8922a;
  color: #0d0600;
  font-weight: bold;
}
#map-badge {
  display: inline-block;
  width: 6px;
  height: 6px;
  background: #f0c060;
  border-radius: 50%;
  margin-left: 2px;
  visibility: hidden;
}
#map-badge.active { visibility: visible; }
```

Desktop CSS (in the 1024px+ media query): show `#map-sidebar` in the grid alongside chat:
```css
#screen-game.has-map.active {
  display: grid;
  grid-template-columns: 3fr 2fr;
  grid-template-rows: auto 1fr auto;
  gap: 16px;
  max-width: 1200px;
}
#screen-game.has-map #map-sidebar {
  display: block;
  grid-column: 2;
  grid-row: 2;
}
```

- [ ] **Step 3: Add JavaScript — initialize renderer, handle socket events**

```html
<script src="/map-renderer.js"></script>
```

In the JS section:
```js
// ── Map ──────────────────────────────────────────────────────
let mapRenderer = null;
let mapRendererMobile = null;

function initMap() {
  const container = document.getElementById('map-container');
  const containerMobile = document.getElementById('map-container-mobile');
  if (container) mapRenderer = new MapRenderer(container, 'dark');
  if (containerMobile) mapRendererMobile = new MapRenderer(containerMobile, 'dark');
}

function updateMap(mapState) {
  if (mapRenderer) mapRenderer.update(mapState);
  if (mapRendererMobile) mapRendererMobile.update(mapState);
  // Show sidebar on desktop
  if (mapState.playerLocation) {
    document.getElementById('screen-game').classList.add('has-map');
    document.getElementById('map-sidebar').style.display = 'block';
  }
}

socket.on('map_update', (mapState) => {
  updateMap(mapState);
  // Flash badge on mobile
  const badge = document.getElementById('map-badge');
  if (badge) badge.classList.add('active');
});

socket.on('map_inline', (data) => {
  // Push a map snapshot into the chat
  addMsg('system', `🗺️ Entered: ${data.location}`);
});

socket.on('map_style_changed', (data) => {
  if (mapRenderer) mapRenderer.setStyle(data.style);
  if (mapRendererMobile) mapRendererMobile.setStyle(data.style);
});

// Level tab clicks
document.querySelectorAll('.map-level-btn, .map-level-btn-mobile').forEach(btn => {
  btn.addEventListener('click', () => {
    const level = btn.dataset.level;
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (mapRenderer) mapRenderer.setLevel(level);
    if (mapRendererMobile) mapRendererMobile.setLevel(level);
  });
});

// Node click → travel request
function onMapNodeClick(name) {
  const me = getMyName();
  if (me && isMyTurnCheck()) {
    document.getElementById('action-input').value = `Travel to ${name}`;
    sendAction();
  }
}

// On game_joined, initialize map from state
// (in the game_joined handler, after existing code)
initMap();
if (state.mapState && state.mapState.playerLocation) {
  updateMap(state.mapState);
}
if (mapRenderer) mapRenderer.onNodeClick = onMapNodeClick;
if (mapRendererMobile) mapRendererMobile.onNodeClick = onMapNodeClick;
```

- [ ] **Step 4: Commit**

```bash
git add public/game.html
git commit -m "feat: add map UI — sidebar on desktop, tab on mobile, inline chat"
```

---

### Task 5: Host Tab Map Settings

**Files:**
- Modify: `public/game.html`

- [ ] **Step 1: Add map settings to the Host panel**

After the existing ferocity slider in the Host tab:
```html
<label style="margin-top:12px;">🗺️ Map Style</label>
<select id="map-style-select">
  <option value="parchment">📜 Parchment & Ink</option>
  <option value="dark">🌑 Dark & Glowing</option>
  <option value="tactical">⚔️ Tactical Grid</option>
</select>

<label style="margin-top:8px;">🗺️ Manual Reveal</label>
<div style="display:flex;gap:6px;">
  <input id="reveal-location-input" type="text" placeholder="Location name to reveal" style="flex:1;font-size:0.85rem;padding:6px 8px;"/>
  <button class="token-btn" id="btn-reveal-location">👁 Reveal</button>
</div>
```

- [ ] **Step 2: Add JS handlers**

```js
document.getElementById('map-style-select').addEventListener('change', () => {
  socket.emit('set_map_style', { style: document.getElementById('map-style-select').value });
});

document.getElementById('btn-reveal-location').addEventListener('click', () => {
  const name = document.getElementById('reveal-location-input').value.trim();
  if (!name) return;
  socket.emit('reveal_location', { name });
  document.getElementById('reveal-location-input').value = '';
});
```

- [ ] **Step 3: Commit**

```bash
git add public/game.html
git commit -m "feat: add map style selector and manual reveal to Host tab"
```

---

### Task 6: Discord Map Command

**Files:**
- Modify: `discord-bot.js`

- [ ] **Step 1: Add `/tt map` subcommand**

In `buildSubcommands()`:
```js
.addSubcommand(sub => sub
  .setName('map')
  .setDescription('Show the current map'))
```

- [ ] **Step 2: Add handler**

```js
else if (sub === 'map') {
  const gameId = await db.getChannelGame(interaction.channelId);
  if (!gameId) {
    await interaction.reply({ content: 'Link this channel first.', ephemeral: true });
    return;
  }
  const gs = gameEngine.getGameState(gameId);
  if (!gs.mapGraph || !gs.mapGraph.playerLocation) {
    await interaction.reply({ content: 'No map data yet — start exploring!', ephemeral: true });
    return;
  }
  // Send a text-based map summary
  const nodes = Object.entries(gs.mapGraph.nodes)
    .filter(([_, n]) => n.revealed)
    .map(([name, n]) => {
      const marker = name === gs.mapGraph.playerLocation ? '📍' : (n.visited ? '✅' : '👁');
      return `${marker} **${name}**${n.description ? ' — ' + n.description : ''}`;
    }).join('\n');
  const embed = new EmbedBuilder()
    .setColor(0xC8922A)
    .setTitle('🗺️ Map')
    .setDescription(nodes || 'No locations discovered.')
    .setFooter({ text: `Current: ${gs.mapGraph.playerLocation || 'Unknown'} | Level: ${gs.mapGraph.activeLevel}` });
  await interaction.reply({ embeds: [embed] });
}
```

- [ ] **Step 3: Add `/tt reveal` subcommand for Discord GM reveal**

```js
.addSubcommand(sub => sub
  .setName('reveal')
  .setDescription('Reveal a location on the map (GM)')
  .addStringOption(opt => opt.setName('location').setDescription('Location to reveal').setRequired(true).setAutocomplete(true)))
```

Handler:
```js
else if (sub === 'reveal') {
  const gameId = await db.getChannelGame(interaction.channelId);
  if (!gameId) { await interaction.reply({ content: 'Link this channel first.', ephemeral: true }); return; }
  const name = interaction.options.getString('location');
  const gs = gameEngine.getGameState(gameId);
  if (gs.mapGraph.revealNode(name)) {
    await db.setState(gameId, 'map', gs.mapGraph.toJSON());
    io.to(gameId).emit('map_update', gs.mapGraph.toJSON());
    await interaction.reply(`🗺️ Revealed **${name}** on the map.`);
  } else {
    await interaction.reply({ content: `Location "${name}" not found in map data.`, ephemeral: true });
  }
}
```

Add autocomplete for the reveal location option in the autocomplete handler:
```js
if (focused.name === 'location') {
  const gameId = await db.getChannelGame(interaction.channelId);
  if (!gameId) { await interaction.respond([]); return; }
  const gs = gameEngine.getGameState(gameId);
  const nodes = Object.keys(gs.mapGraph?.nodes || {});
  const filtered = nodes.filter(n => n.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
  await interaction.respond(filtered.map(n => ({ name: n, value: n })));
  return;
}
```

- [ ] **Step 4: Commit**

```bash
git add discord-bot.js
git commit -m "feat: add /tt map and /tt reveal Discord commands"
```

---

### Task 7: PDF Location Extraction Seeding

**Files:**
- Modify: `server.js` (the PDF upload endpoint)

- [ ] **Step 1: Extract location names from uploaded PDFs and seed the map**

In the `/api/games/:id/upload-pdf` route, after extracting text and saving to `custom_context`, add:

```js
// Seed map with location names from PDF
const gs = getGameState(req.params.id);
const locationPattern = /(?:^|\n)(?:#{1,3}\s+)?([A-Z][A-Za-z\s''-]{2,30})(?:\n|$)/gm;
let match;
const pdfText = allText;
while ((match = locationPattern.exec(pdfText)) !== null) {
  const name = match[1].trim();
  // Skip common non-location headers
  const skip = /^(chapter|appendix|introduction|table|figure|page|index|contents|credits|about)/i;
  if (!skip.test(name) && name.split(' ').length <= 5) {
    gs.mapGraph.addNode(name, { level: 'world', description: 'From campaign source' });
  }
}
await db.setState(req.params.id, 'map', gs.mapGraph.toJSON());
```

- [ ] **Step 2: Commit**

```bash
git add server.js
git commit -m "feat: seed map graph with location names from uploaded PDFs"
```

---

### Task 8: Final Integration and Deploy

**Files:**
- Modify: `server.js`, `public/game.html`

- [ ] **Step 1: Add .superpowers to .gitignore**

```bash
echo ".superpowers/" >> .gitignore
```

- [ ] **Step 2: Run the server locally and verify**

```bash
cd /Users/aron/Downloads/dnd-server
DATABASE_URL=... ANTHROPIC_API_KEY=... node server.js
```

Open http://localhost:3000, create a game, register a character, start the adventure. Verify:
- Map sidebar appears on desktop when Claude outputs a MAP hint
- Map tab works on mobile
- Fog of war works (only visited locations visible)
- Clicking a node inserts "Travel to X" as an action
- Host tab map style selector changes the visual style
- Manual reveal works

- [ ] **Step 3: Commit all remaining changes and deploy**

```bash
git add -A
git commit -m "feat: auto-mapping — complete integration with all 3 zoom levels, fog of war, 3 styles"
git push origin main
railway up --detach
```

- [ ] **Step 4: Verify on Railway**

Check Railway logs for clean startup. Open the live URL and test map functionality with a game.

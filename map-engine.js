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

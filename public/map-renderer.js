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
      label.textContent = name.length > 12 ? name.slice(0, 11) + '\u2026' : name;
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

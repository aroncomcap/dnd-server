'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MapGraph, processMapHint } = require('../map-engine');

describe('MapGraph', () => {
  it('constructs with no data', () => {
    const map = new MapGraph();
    assert.deepEqual(map.nodes, {});
    assert.equal(map.playerLocation, null);
    assert.equal(map.activeLevel, 'world');
  });

  it('constructs with initial data', () => {
    const data = {
      nodes: { Forest: { x: 100, y: 200, level: 'world', revealed: true } },
      playerLocation: 'Forest',
      activeLevel: 'world',
    };
    const map = new MapGraph(data);
    assert.ok(map.nodes.Forest);
    assert.equal(map.playerLocation, 'Forest');
  });

  it('toJSON serializes state correctly', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 100, y: 200 });
    map.playerLocation = 'Forest';
    map.activeLevel = 'location';
    const json = map.toJSON();
    assert.deepEqual(json, {
      nodes: map.nodes,
      playerLocation: 'Forest',
      activeLevel: 'location',
    });
  });

  it('addNode creates new node with defaults', () => {
    const map = new MapGraph();
    const node = map.addNode('Forest');
    assert.ok(map.nodes.Forest);
    assert.equal(node.x, null);
    assert.equal(node.y, null);
    assert.equal(node.level, 'world');
    assert.equal(node.revealed, false);
    assert.equal(node.visited, false);
    assert.deepEqual(node.connections, []);
  });

  it('addNode merges into existing node', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 100, y: 200 });
    const node = map.addNode('Forest', { description: 'A dark forest' });
    assert.equal(node.x, 100);
    assert.equal(node.y, 200);
    assert.equal(node.description, 'A dark forest');
  });

  it('addNode is case-insensitive', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 100 });
    const node = map.addNode('FOREST', { y: 200 });
    assert.equal(map.nodes.Forest.x, 100);
    assert.equal(map.nodes.Forest.y, 200);
    assert.equal(Object.keys(map.nodes).length, 1);
  });

  it('getNode retrieves node case-insensitively', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 100 });
    const node = map.getNode('forest');
    assert.ok(node);
    assert.equal(node.x, 100);
  });

  it('getNode returns null for missing node', () => {
    const map = new MapGraph();
    assert.equal(map.getNode('Missing'), null);
  });

  it('getNodeKey returns canonical key', () => {
    const map = new MapGraph();
    map.addNode('Forest', {});
    assert.equal(map.getNodeKey('forest'), 'Forest');
    assert.equal(map.getNodeKey('FOREST'), 'Forest');
  });

  it('addConnection creates bidirectional link', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    map.addNode('Cave');
    map.addConnection('Forest', 'Cave');
    assert.ok(map.nodes.Forest.connections.includes('Cave'));
    assert.ok(map.nodes.Cave.connections.includes('Forest'));
  });

  it('addConnection is idempotent', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    map.addNode('Cave');
    map.addConnection('Forest', 'Cave');
    map.addConnection('Forest', 'Cave');
    assert.equal(map.nodes.Forest.connections.length, 1);
  });

  it('addConnection handles case-insensitive names', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    map.addNode('Cave');
    map.addConnection('forest', 'CAVE');
    assert.ok(map.nodes.Forest.connections.includes('Cave'));
  });

  it('moveTo reveals and visits node', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    const { isNew, node } = map.moveTo('Forest');
    assert.equal(isNew, true);
    assert.equal(node.revealed, true);
    assert.equal(node.visited, true);
    assert.equal(map.playerLocation, 'Forest');
  });

  it('moveTo creates node if missing', () => {
    const map = new MapGraph();
    map.moveTo('Forest');
    assert.ok(map.nodes.Forest);
    assert.equal(map.playerLocation, 'Forest');
  });

  it('moveTo adds connection to previous location', () => {
    const map = new MapGraph();
    map.moveTo('Forest');
    map.moveTo('Cave');
    assert.ok(map.nodes.Forest.connections.includes('Cave'));
    assert.ok(map.nodes.Cave.connections.includes('Forest'));
  });

  it('moveTo reveals connected nodes', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    map.addNode('Cave');
    map.nodes.Forest.connections = ['Cave'];
    map.moveTo('Forest');
    assert.equal(map.nodes.Cave.revealed, true);
  });

  it('moveTo updates activeLevel from node', () => {
    const map = new MapGraph();
    map.addNode('Forest', { level: 'location' });
    map.moveTo('Forest');
    assert.equal(map.activeLevel, 'location');
  });

  it('moveTo returns isNew=false on returning to same location', () => {
    const map = new MapGraph();
    map.moveTo('Forest');
    const { isNew } = map.moveTo('Forest');
    assert.equal(isNew, false);
  });

  it('revealNode reveals existing node', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    const result = map.revealNode('Forest');
    assert.equal(result, true);
    assert.equal(map.nodes.Forest.revealed, true);
  });

  it('revealNode returns false for missing node', () => {
    const map = new MapGraph();
    const result = map.revealNode('Missing');
    assert.equal(result, false);
  });

  it('autoPosition places first node at center', () => {
    const map = new MapGraph();
    map.addNode('Forest');
    map.autoPosition('Forest');
    assert.equal(map.nodes.Forest.x, 400);
    assert.equal(map.nodes.Forest.y, 300);
  });

  it('autoPosition skips if already positioned', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 100, y: 200 });
    map.autoPosition('Forest');
    assert.equal(map.nodes.Forest.x, 100);
    assert.equal(map.nodes.Forest.y, 200);
  });

  it('autoPosition places near existing nodes', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 400, y: 300 });
    map.addNode('Cave');
    map.autoPosition('Cave');
    assert.ok(map.nodes.Cave.x !== null);
    assert.ok(map.nodes.Cave.y !== null);
    // Should be near Forest (400, 300) within 120 unit radius
    const dist = Math.sqrt(
      (map.nodes.Cave.x - 400) ** 2 + (map.nodes.Cave.y - 300) ** 2
    );
    assert.ok(dist <= 130, `Distance ${dist} should be near 120`);
  });

  it('autoPosition respects node connections', () => {
    const map = new MapGraph();
    map.addNode('Forest', { x: 400, y: 300 });
    map.addNode('Cave', { x: 500, y: 400 });
    map.addNode('Tavern');
    map.nodes.Tavern.connections = ['Forest', 'Cave'];
    map.autoPosition('Tavern');
    // Should be average of connections + offset
    assert.ok(map.nodes.Tavern.x !== null);
    assert.ok(map.nodes.Tavern.y !== null);
  });

  it('syncFromWorldData adds skeleton nodes', () => {
    const map = new MapGraph();
    const worldLocations = [
      { name: 'Forest', description: 'Dark trees', distance: 'nearby' },
      { name: 'Cave', description: 'Deep cavern', distance: 'far' },
    ];
    map.syncFromWorldData(worldLocations);
    assert.ok(map.nodes.Forest);
    assert.ok(map.nodes.Cave);
    assert.equal(map.nodes.Forest.description, 'Dark trees');
  });

  it('syncFromWorldData updates existing node descriptions', () => {
    const map = new MapGraph();
    map.addNode('Forest', { description: 'Old description' });
    map.syncFromWorldData([{ name: 'Forest', description: 'New description' }]);
    assert.equal(map.nodes.Forest.description, 'New description');
  });

  it('syncFromWorldData skips null input', () => {
    const map = new MapGraph();
    map.syncFromWorldData(null);
    assert.deepEqual(map.nodes, {});
  });

  it('getNodesForLevel filters by level and revealed', () => {
    const map = new MapGraph();
    map.addNode('Forest', { level: 'world', revealed: true });
    map.addNode('Cave', { level: 'world', revealed: false });
    map.addNode('Room', { level: 'location', revealed: true });
    const result = map.getNodesForLevel('world');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Forest');
  });

  it('getNodesForLevel includes name in result', () => {
    const map = new MapGraph();
    map.addNode('Forest', { level: 'world', revealed: true });
    const result = map.getNodesForLevel('world');
    assert.equal(result[0].name, 'Forest');
    assert.ok(result[0].x !== undefined);
  });
});

describe('processMapHint', () => {
  it('extracts MAP: line from world data', () => {
    const map = new MapGraph();
    const worldRaw = 'SCENE: Dark forest\nMAP: Forest Path\nOther data';
    const result = processMapHint(map, worldRaw);
    assert.equal(result.location, 'Forest Path');
    assert.equal(result.moved, true);
  });

  it('ignores case in MAP: line', () => {
    const map = new MapGraph();
    const worldRaw = 'map: Forest Path';
    const result = processMapHint(map, worldRaw);
    assert.equal(result.location, 'Forest Path');
  });

  it('returns moved=false when no MAP line', () => {
    const map = new MapGraph();
    const worldRaw = 'SCENE: Dark forest\nOther data';
    const result = processMapHint(map, worldRaw);
    assert.equal(result.moved, false);
  });

  it('syncs world locations into map', () => {
    const map = new MapGraph();
    const worldLocations = [
      { name: 'Forest', description: 'Dark trees' },
    ];
    processMapHint(map, null, worldLocations);
    assert.ok(map.nodes.Forest);
  });

  it('detects isNew correctly', () => {
    const map = new MapGraph();
    const worldRaw = 'MAP: Forest';
    const result = processMapHint(map, worldRaw);
    assert.equal(result.isNew, true);
    // Second move to same location
    const result2 = processMapHint(map, worldRaw);
    assert.equal(result2.isNew, false);
  });

  it('handles null worldRaw', () => {
    const map = new MapGraph();
    const result = processMapHint(map, null);
    assert.equal(result.moved, false);
  });

  it('returns default result when no MAP and no locations', () => {
    const map = new MapGraph();
    const result = processMapHint(map, 'Some data');
    assert.deepEqual(result, { moved: false, isNew: false, location: null });
  });
});

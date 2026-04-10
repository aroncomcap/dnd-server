# Auto-Mapping Feature Design

## Overview

Three-level auto-mapping system that builds maps progressively as players explore. Maps are a visual layer on top of the existing world data, rendered as interactive SVGs with optional AI art overlays.

## Three Zoom Levels

Fixed three-level hierarchy. Claude decides what each level represents per game.

- **World** — regions, cities, major landmarks. Shows travel distances between locations. Wilderness hex crawl scale.
- **Location** — city districts, dungeon levels, building interiors. Areas within a single world location. Clickable to zoom into Detail.
- **Detail** — individual rooms with optional grid. Character tokens, enemy positions, objects. Combat-ready view.

A "Location" is flexible: a city, a dungeon, a cave complex, a ship. Claude assigns the granularity based on narrative context.

## UI Placement

### Desktop (1024px+)
Persistent sidebar to the right of the chat panel. Contains World/Location/Detail sub-tabs. Always visible, updates live. Uses the existing 2-column grid layout — map replaces the scene image panel (or shares space with it).

### Mobile (<1024px)
Dedicated **Map** tab in the bottom nav bar (🗺️). Full-screen map view with World/Location/Detail sub-tabs. Badge notification on the tab icon when the map updates.

### Inline Chat Push
When the party enters a new location or room, a small inline map snapshot is pushed into the chat flow as a message. This is a static image snapshot of the current map state, not interactive. Gives context without requiring the player to switch tabs.

## Map Rendering

### Three Visual Styles (selectable per game in Host tab)

1. **Parchment & Ink** — sepia tones, hand-drawn feel, serif labels. Fog of war as parchment covering unexplored areas. Matches Tavern Table theme.
2. **Dark & Glowing** — dark background with gold glowing edges. Fog of war as darkness. Modern, high contrast.
3. **Tactical Grid** — VTT-style with 5ft grid squares. Character tokens with initials, enemy tokens in red. Best for combat.

Selection stored per game in the `games` table or game_state key-value.

### AI Art Overlay
Optional FLUX-generated atmospheric illustration layered on top of the SVG map. Generated when entering a significant new area. Uses the existing `---SCENE---` infrastructure. Displayed as a background image behind the SVG overlay.

## Fog of War

- All areas start hidden (unrevealed).
- When a player visits a location, it and its connecting corridors are revealed.
- Previously explored areas remain visible but dimmed (reduced opacity).
- The current location is fully bright with the player token.
- **GM Reveal**: the host can manually reveal areas via the Host tab or a command. Claude can also reveal areas narratively (e.g., an NPC draws a map, a character finds a map scroll) by including location names in the `MAP:` hint.

## Data Model

Maps are a visual layer on the existing `---WORLD---` locations data. No separate map data model. Each location in the world data gets additional positioning and map metadata:

```json
{
  "locations": [
    {
      "name": "Guard Room",
      "description": "Stone-walled room with weapon racks",
      "distance": "adjacent to Entry Hall",
      "map": {
        "x": 250,
        "y": 120,
        "level": "detail",
        "parent": "Sunken Temple",
        "revealed": true,
        "visited": true,
        "connections": ["Entry Hall", "Corridor B"]
      }
    }
  ]
}
```

Stored in `game_state` under key `map` with the full graph. The `---WORLD---` locations list is the source of truth for what exists; the `map` state adds positioning and visibility.

## Data Flow

### Claude's Output
One additional line in the `---WORLD---` block:

```
MAP: Guard Room
```

Just the current location name. ~5 tokens overhead per turn.

### Server Processing (mapEngine module)

On each turn, after parsing the response:

1. Extract `MAP: <location>` from the world block.
2. Look up location in the map graph.
3. If new location: create node, auto-position using force-directed layout relative to connected nodes.
4. Move player token to the location.
5. Reveal the location node and its connecting edges.
6. Determine which zoom level is active (if the location is a room in a dungeon, zoom to Detail; if it's a city on the world map, zoom to World).
7. Save updated map state to DB (`game_state` key: `map`).
8. Emit `map_update` event to all clients.
9. If entering a new area, also emit `map_inline` with a snapshot for the chat.

### Client Rendering

SVG renderer on the client:
- Draws nodes as rectangles/circles based on zoom level.
- Draws edges as lines/corridors between connected nodes.
- Applies fog of war (opacity/visibility based on revealed/visited state).
- Applies selected visual style (parchment/dark/tactical).
- Positions player token with glow effect.
- Enemy tokens positioned during combat (from NPC data in `---WORLD---`).
- Click a node to request travel there (emits a player action).

## Map Generation Sources

### Progressive Discovery (default)
Maps start empty. Nodes created as Claude mentions locations. Positions auto-assigned using a simple force-directed algorithm that spaces nodes evenly and respects connection relationships.

### PDF Seed
When campaign PDFs are uploaded, the server extracts location names during PDF processing. These become skeleton nodes in the map graph — they exist but are hidden behind fog of war with no positions. When Claude first mentions one of these locations, the node gets positioned and revealed. This makes maps snap into place faster for published adventures.

Extraction is best-effort: look for capitalized place names, section headers, and location lists in the PDF text.

## Discord Integration

- `/tt map` — posts the current map as a PNG image attachment (server-side SVG-to-PNG render or canvas screenshot).
- Map updates announced in Discord when significant changes happen (new area discovered, combat positions change).

## New Files

- `map-engine.js` — server module: map graph, positioning, fog of war, state management.
- `public/map-renderer.js` — client module: SVG rendering, styles, interaction, zoom controls.
- Updates to `server.js`: parse MAP hint, integrate mapEngine, new socket events.
- Updates to `game.html`: sidebar/tab UI, inline chat maps.
- Updates to `discord-bot.js`: `/tt map` command.

## Settings (Host Tab)

- Map Style: dropdown (Parchment / Dark / Tactical)
- AI Art Overlay: toggle on/off
- Manual Reveal: button + location name input to reveal hidden areas

## Constraints

- SVG rendering is client-side only — no server-side image libraries needed (except for Discord PNG export, which can use a simple canvas approach).
- Map state persists in the DB via the existing game_state key-value store.
- Force-directed positioning runs client-side for responsiveness. Server stores the resulting positions.
- No map editor — maps are built entirely from gameplay and PDF extraction.

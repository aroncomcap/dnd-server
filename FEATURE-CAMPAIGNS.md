# Feature Request: Campaign-Based Architecture with Persistent World State

**Status:** Backlog
**Priority:** Medium
**Complexity:** High (architectural refactor)
**Date Created:** 2026-04-24

## Overview

Separate world state from individual games and introduce a **Campaigns** layer that persists across multiple games. This enables:
- Long-running story arcs across multiple "sessions" (games)
- Persistent NPCs, locations, and history across games
- Shared world state that players can reference between games
- Campaign-level progression and continuity

## Current Architecture

```
Game 1 → game_state (world, locations, NPCs, story)
Game 2 → game_state (separate world, isolated from Game 1)
Game 3 → game_state (separate world, isolated from Games 1-2)
```

**Problem:** Each game has its own isolated world. Games can't share persistent world state.

---

## Proposed Architecture

```
Campaign (persistent world state)
  ├── Game 1 (Session 1)
  ├── Game 2 (Session 2)
  ├── Game 3 (Session 3)
  └── Shared world state: locations, NPCs, timeline, accomplishments
```

### Data Model

**New Table: `campaigns`**
```sql
CREATE TABLE campaigns (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  host_user_id TEXT REFERENCES users(id),
  system TEXT DEFAULT 'dnd5e',
  world_state JSONB,  -- Locations, NPCs, accomplishments, timeline
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**Modified Table: `games`**
```sql
ALTER TABLE games ADD COLUMN campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
-- Each game belongs to a campaign (or is standalone if campaign_id is NULL)
```

**New Table: `campaign_events`** (Timeline)
```sql
CREATE TABLE campaign_events (
  id UUID PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  event_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
-- Records major events (NPC died, location discovered, etc.) with game references
```

---

## Implementation Phases

### Phase 1: Data Structure (Week 1-2)
- [ ] Create `campaigns` table
- [ ] Create `campaign_events` table
- [ ] Modify `games` table to add `campaign_id` foreign key
- [ ] Create migration to populate campaigns for existing games (optional)

### Phase 2: API Endpoints (Week 3)
- [ ] `POST /api/campaigns` - Create campaign
- [ ] `GET /api/campaigns/:id` - Get campaign with full world state
- [ ] `PUT /api/campaigns/:id` - Update campaign world state
- [ ] `POST /api/campaigns/:id/games` - Create game within campaign
- [ ] `GET /api/campaigns/:id/games` - List all games in campaign
- [ ] `GET /api/campaigns/:id/timeline` - Get campaign event timeline

### Phase 3: Client UI (Week 4)
- [ ] Campaign browser/selector on lobby
- [ ] Campaign creation form
- [ ] Campaign world state viewer
- [ ] Campaign timeline viewer
- [ ] Link games to campaigns

### Phase 4: Game Integration (Week 5)
- [ ] Load campaign world state on game start
- [ ] Save world state to campaign (not just game)
- [ ] Display campaign context (NPCs, locations, history) in game
- [ ] Record major events to campaign timeline

---

## Benefits

✅ **Persistent World:** NPCs, locations, and history survive between games
✅ **Story Continuity:** Players can track multi-game story arcs
✅ **Reference Material:** Players can review campaign history/timeline
✅ **Game Flexibility:** Can run side quests or alternate games in same world
✅ **Reusability:** Campaign templates could be shared across users

---

## Migration Path

**For existing games:**
- Create "Legacy" campaign for each game (optional)
- Or allow games to exist standalone (campaign_id = NULL)
- Gradually encourage users to group related games into campaigns

**Backward compatibility:**
- Games without campaigns still work as today
- World state stays in game_state if no campaign linked
- Can migrate later without breaking existing functionality

---

## Related Discussions

- Cleanup preserves world state for potential reuse ✓
- Rules/templates/killshots separate from games ✓
- This enables true campaign persistence across sessions

---

## Considerations

### Data Volume
- Campaign world state could grow large (hundreds of NPCs, locations)
- Consider: Archival of old campaigns, pruning mechanisms

### Ownership & Permissions
- Who owns the campaign? (Host user)
- Can players from different campaigns interact?
- Campaign sharing model?

### Scaling
- Multiple games reading from same campaign simultaneously
- Lock mechanisms for world state updates
- Conflict resolution if two games modify world state at same time

---

## Future Enhancements

- **Campaign Templates:** Pre-built worlds (Forgotten Realms, etc.)
- **Campaign Sharing:** Publish campaigns for other DMs to use
- **Campaign Analytics:** Campaign-level statistics and progress
- **Backup/Export:** Export full campaign (all games + world state)
- **Version Control:** Track world state changes across games
- **Collaborative Campaigns:** Multiple DMs managing one world

---

## Notes

This is a substantial architectural change but unlocks much richer gameplay experiences. The separation of world state from games is the key lever - once that's done, all other features follow naturally.

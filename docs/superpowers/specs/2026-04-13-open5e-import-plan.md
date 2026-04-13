# Open5e Content Import Plan

**Date:** 2026-04-13
**Status:** Plan (not yet implemented)
**API:** https://api.open5e.com/v2/

## Available Content

### WotC SRD (Priority 1 — Start Here)

| Content Type | SRD 2014 | SRD 2024 | Endpoint |
|-------------|----------|----------|----------|
| Creatures | 325 | 329 | `/v2/creatures/?document__key=srd-2014` |
| Spells | 319 | TBD | `/v2/spells/?document__key=srd-2014` |
| Magic Items | TBD | TBD | `/v1/magicitems/` |
| Conditions | available | available | `/v2/conditions/` |
| Weapons | available | available | `/v2/weapons/` |
| Armor | available | available | `/v2/armor/` |

### Third-Party (Priority 2 — Import Selectively)

| Source | Key | Publisher | Creatures | Other |
|--------|-----|-----------|-----------|-------|
| Tome of Beasts 1 | `tob` | Kobold Press | 391 | Best 3rd party bestiary |
| Tome of Beasts 2 | `tob2` | Kobold Press | ~400 | |
| Tome of Beasts 3 | `tob3` | Kobold Press | ~400 | |
| Creature Codex | `ccdx` | Kobold Press | ~400 | |
| Deep Magic | `deepm` | Kobold Press | | 700+ spells |
| Vault of Magic | `vom` | Kobold Press | | 900+ magic items |
| Monstrous Menagerie | `a5e-mm` | EN Publishing | ~600 | A5E variant rules |
| Tal'Dorei Setting | `tdcs` | Green Ronin | | Critical Role |

**Total available:** ~3,200 creatures, 1,000+ spells, 900+ magic items across all sources.

## Architecture: Import Pipeline

### Phase 1: Import Script (`import-open5e.js`)

Command-line tool that fetches from Open5e API and transforms to our schema.

```bash
# Import all SRD 2014 creatures
node import-open5e.js creatures srd-2014

# Import specific source
node import-open5e.js creatures tob

# Import spells
node import-open5e.js spells srd-2014

# Dry run (show what would be imported, don't write)
node import-open5e.js creatures srd-2014 --dry-run

# Import to a specific monster source in DB
node import-open5e.js creatures tob --source-name="Tome of Beasts"
```

### Phase 2: Transform Open5e → Our Schema

**Creature mapping:**

```
Open5e field              → Our combatStats field
─────────────────────────────────────────────────
name                      → name
challenge_rating          → cr
armor_class               → ac
hit_points                → hp, maxHp
ability_scores.strength   → abilities.str (etc)
saving_throws             → saveProficiencies
actions[].attack_bonus    → weapons[].attackMod (derive str/dex)
actions[].damage_dice     → weapons[].damage
actions[].damage_type     → weapons[].damageType
traits[].name             → features[]
damage_resistances        → resistances[]
damage_immunities         → immunities[]
damage_vulnerabilities    → vulnerabilities[]
speed.walk                → speed
```

**Personality/tactics generation:**
After importing raw stats, run a batch Haiku call to generate personality, combatStyle, tactics, and morale for each creature. ~100 tokens per creature, batched 20 at a time.

Cost to generate personality for 325 SRD creatures: ~$0.50

### Phase 3: Storage as Monster Sources

Import into the existing `monster_sources` DB table as global sources:

```sql
INSERT INTO monster_sources (name, system, scope, monsters)
VALUES ('D&D 5e SRD 2014', 'dnd5e', 'global', '{...all 325 creatures...}');
```

Each source is a separate row. Games auto-attach the SRD source. Hosts can attach additional sources (Tome of Beasts, etc.) from a source picker in the Host tab.

### Phase 4: Source Picker UI

Host tab gets a "Monster Sources" panel:
- Shows currently attached sources with creature count
- "Add Source" dropdown lists all available global sources
- "Remove Source" button per source
- Sources are checked in priority order during monster lookup

## What to Import First

### Round 1: SRD 2014 Creatures (325)
- Replace our hand-built 84 monsters with the full SRD set
- Run through DPR validator after import
- Generate personality/tactics via Haiku batch
- Cost: ~$0.50 for personality generation

### Round 2: SRD 2014 Spells (319)
- Store as a spell reference DB for the combat engine
- Used by stat parser to validate character spells
- Used by encounter designer for DPR estimation

### Round 3: Tome of Beasts 1 (391)
- Most popular 3rd party bestiary
- Import as a separate monster source
- Hosts opt-in via Source Picker

### Round 4: Magic Items + Conditions + Equipment
- Magic items for loot generation
- Conditions for combat engine condition tracking
- Equipment for character sheet validation

## Implementation Tasks

1. **`import-open5e.js`** — CLI script: fetch, paginate, transform, validate, write
2. **Transform functions** — Open5e creature → our combatStats, Open5e spell → our spell schema
3. **Personality batch generator** — Haiku batch call for personality/tactics/morale
4. **DPR validation** — Run validator on imported data, fix outliers
5. **DB seeder** — Write imported sources to `monster_sources` table as global scope
6. **Source picker UI** — Host tab panel to attach/detach monster sources per game
7. **Spell reference DB** — New table or JSON file for spell data

## Licensing

All Open5e content is published under OGL 1.0a or Creative Commons. The API explicitly provides license URLs per document. Safe to use for:
- SRD content (WotC, OGL) — fully open
- Kobold Press content (OGL) — fully open
- EN Publishing (OGL) — fully open

We should store and display the `document__license_url` for each source for attribution.

## Maintenance

After initial import:
- Re-run import periodically to pick up corrections/additions
- The import script should be idempotent (update existing, add new, don't duplicate)
- Version tracking: store the import date and Open5e document version
- DPR validator runs automatically after each import to catch stat issues

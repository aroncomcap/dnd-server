#!/usr/bin/env node
// Script to add personality fields to all monsters in both JSON files
const fs = require('fs');
const path = require('path');

const dnd5ePersonality = {
  "goblin": {
    "personality": "Cowardly and cunning. Fights dirty — uses hit-and-run tactics, hides behind allies, and flees when outmatched.",
    "combatStyle": "hit-and-run",
    "tactics": "Prefers ranged attacks from cover. Uses Nimble Escape to disengage after melee. Focuses weakest-looking target. Flees below 50% HP.",
    "morale": "cowardly"
  },
  "skeleton": {
    "personality": "Mindless undead animated by dark magic, driven only by the will of its creator. It feels nothing — no pain, no fear.",
    "combatStyle": "aggressive",
    "tactics": "Advances relentlessly toward the nearest living creature. Attacks without hesitation. Switches to ranged attacks when enemies are distant. Never retreats.",
    "morale": "fanatical"
  },
  "zombie": {
    "personality": "A shambling, barely-animate corpse driven by a single compulsion: reach and destroy the living. Utterly mindless.",
    "combatStyle": "aggressive",
    "tactics": "Shuffles toward the nearest living target and attacks with its slam. Ignores pain and wounds. Never stops advancing even at low HP — Undead Fortitude may save it.",
    "morale": "fanatical"
  },
  "orc": {
    "personality": "Brutal and aggressive, driven by a warrior culture that glorifies violence. Charges into battle with a battle cry.",
    "combatStyle": "aggressive",
    "tactics": "Uses Aggressive to close distance immediately. Targets the strongest-looking foe first to prove dominance. Throws a javelin if closing, then switches to greataxe. Does not retreat.",
    "morale": "brave"
  },
  "kobold": {
    "personality": "Sycophantic and cowardly individually, but cunning in numbers. Relies entirely on pack tactics and traps.",
    "combatStyle": "pack-tactics",
    "tactics": "Always tries to flank — needs an ally adjacent to target to use Pack Tactics. Uses sling at range and only melee in desperation. Flees if outnumbered or if most allies are dead.",
    "morale": "cowardly"
  },
  "wolf": {
    "personality": "A cunning predator that hunts in coordinated packs, testing prey before committing to an attack.",
    "combatStyle": "pack-tactics",
    "tactics": "Circles to flank before attacking to gain Pack Tactics advantage. Targets the smallest or weakest prey. Uses bite to knock targets prone. Retreats if the pack is broken.",
    "morale": "brave"
  },
  "dire-wolf": {
    "personality": "An apex predator of primordial forests — larger, fiercer, and smarter than a normal wolf. Commands lesser wolves.",
    "combatStyle": "pack-tactics",
    "tactics": "Leads the pack, targeting the most dangerous-looking enemy first. Uses bite to knock targets prone and follow up. Fights until pack is mostly dead, then retreats.",
    "morale": "brave"
  },
  "bandit": {
    "personality": "A desperate opportunist — in it for gold, not glory. Turns violent fast but has a survival instinct.",
    "combatStyle": "aggressive",
    "tactics": "Opens with a crossbow shot if possible, then closes to melee. Targets isolated or wounded enemies. Surrenders or flees when outmatched — fights to survive, not to die.",
    "morale": "normal"
  },
  "bugbear": {
    "personality": "A sadistic bully that loves the element of surprise and cruelty. Patient and calculating before striking.",
    "combatStyle": "hit-and-run",
    "tactics": "Tries to initiate combat with a Surprise Attack for bonus damage. Targets isolated enemies. Uses javelin before closing to melee. Fights hard but retreats when badly wounded.",
    "morale": "normal"
  },
  "ogre": {
    "personality": "Dumb as rocks and twice as mean. Lives for smashing things and takes great pleasure in causing pain.",
    "combatStyle": "brute",
    "tactics": "Charges the largest or most armored target to prove strength. Uses greatclub relentlessly. Throws a javelin at fleeing enemies. Too stupid to retreat — keeps swinging until it or its enemies fall.",
    "morale": "brave"
  },
  "troll": {
    "personality": "A fearless, regenerating nightmare that knows it can outlast almost anything. Arrogant about its ability to heal.",
    "combatStyle": "berserker",
    "tactics": "Attacks with reckless abandon — bite plus two claws every round. Doesn't care about taking damage because it regenerates. Only hesitates if fire or acid is used, as those stop regeneration. Never flees.",
    "morale": "brave"
  },
  "owlbear": {
    "personality": "A territorial apex predator with the worst traits of both its component creatures. Once enraged, nothing stops it.",
    "combatStyle": "aggressive",
    "tactics": "Charges the nearest creature and attacks with beak and claws. Has no tactical sense — pure predatory instinct. Focuses on one target until it drops, then moves to the next.",
    "morale": "brave"
  },
  "giant-spider": {
    "personality": "A patient, calculating predator that prefers to web prey first, then move in for the kill.",
    "combatStyle": "defensive",
    "tactics": "Opens with a web attack to restrain a target. Then bites the restrained target for advantage. Uses Spider Climb to attack from walls or ceilings where possible. Retreats to high surfaces when wounded.",
    "morale": "normal"
  },
  "ghoul": {
    "personality": "A ravenous undead driven by an insatiable hunger for living flesh, especially paralyzed victims.",
    "combatStyle": "aggressive",
    "tactics": "Claws at targets to paralyze them (Con save), then bites paralyzed victims for auto-crits. Ignores wounds and fights until destroyed — undead hunger overrides self-preservation.",
    "morale": "fanatical"
  },
  "wight": {
    "personality": "A malevolent undead warrior that retains its intelligence and tactical knowledge, now driven by hatred of the living.",
    "combatStyle": "tactical",
    "tactics": "Opens with longbow fire before closing to melee. Uses Life Drain to reduce maximum HP, prioritizing targets with high HP. Commands any undead allies. Fights until destroyed.",
    "morale": "fanatical"
  },
  "mimic": {
    "personality": "A cunning ambush predator that disguises itself as mundane objects. Utterly patient and utterly treacherous.",
    "combatStyle": "defensive",
    "tactics": "Waits in object form until a creature touches it, then adhesively grapples them. Bites the grappled target every round. Uses pseudopod on anyone trying to free the grappled target.",
    "morale": "normal"
  },
  "basilisk": {
    "personality": "A territorial reptilian predator that doesn't understand why its gaze terrifies prey. Simply hungry.",
    "combatStyle": "aggressive",
    "tactics": "Advances on the nearest target and bites. The petrifying gaze passively affects anyone who looks at it. Has no real tactics beyond charging and biting — purely instinctual.",
    "morale": "brave"
  },
  "manticore": {
    "personality": "Cruel and sadistic, a manticore enjoys toying with prey from a safe distance before moving in for the kill.",
    "combatStyle": "ranged-ambush",
    "tactics": "Opens with tail spike volleys (3 spikes per round) from outside melee range. Uses flight to stay out of reach of grounded enemies. Only closes to melee when tail spikes are exhausted or prey is nearly dead.",
    "morale": "normal"
  },
  "young-green-dragon": {
    "personality": "Arrogant and manipulative, a green dragon believes itself superior to all. It lies, schemes, and poisons from above.",
    "combatStyle": "tactical",
    "tactics": "Opens with Poison Breath if 3+ enemies are in range. Uses flight to stay above melee. Targets spellcasters first to neutralize threats. Retreats to lair if bloodied — arrogant, not suicidal.",
    "morale": "brave"
  },
  "adult-red-dragon": {
    "personality": "A supremely arrogant apex predator and hoarder. Regards everything as either treasure, food, or an insult to be destroyed.",
    "combatStyle": "tactical",
    "tactics": "Opens with Fire Breath on clustered enemies. Uses multiattack (bite + 2 claws) on the most dangerous target. Uses legendary actions to attack between rounds. Flies above melee range. Never truly flees from its lair.",
    "morale": "brave"
  },
  "giant-rat": {
    "personality": "A disease-carrying scavenger emboldened by numbers. Individually cowardly, terrifying in a swarm.",
    "combatStyle": "pack-tactics",
    "tactics": "Flanks alongside other rats to gain Pack Tactics advantage. Bites and retreats. Flees immediately if most of the swarm is killed. Targets injured or prone enemies.",
    "morale": "cowardly"
  },
  "stirge": {
    "personality": "A mindless blood-sucking parasite that latches on and feeds until driven off or destroyed.",
    "combatStyle": "aggressive",
    "tactics": "Dives in and uses blood drain to attach, then keeps sucking each round. Multiple stirges pile onto the same target. Detaches and flees only if the host dies or is destroyed.",
    "morale": "normal"
  },
  "flying-snake": {
    "personality": "A territorial ambush predator that uses its flight to strike from unexpected angles.",
    "combatStyle": "hit-and-run",
    "tactics": "Swoops down for a bite and retreats to a perch each round. Uses Flyby to avoid opportunity attacks. Targets unarmored or unaware targets. Flees if significantly wounded.",
    "morale": "cowardly"
  },
  "imp": {
    "personality": "Scheming, malicious, and terrified of being sent back to the Nine Hells. Serves willingly but plots constantly.",
    "combatStyle": "hit-and-run",
    "tactics": "Uses invisibility to attack from hiding, retreating between attacks. Targets spellcasters to disrupt concentration. Polymorphs into rat/raven form to flee if losing. Uses sting to impose poison disadvantage.",
    "morale": "cowardly"
  },
  "pseudodragon": {
    "personality": "A proud, cat-like creature with a fierce temper despite its small size. Bonds strongly with chosen companions.",
    "combatStyle": "hit-and-run",
    "tactics": "Darts in with a sting to impose the poisoned condition, then retreats. Uses flight to stay out of melee range. Targets enemies threatening its bonded companion. Flees if seriously wounded.",
    "morale": "normal"
  },
  "animated-armor": {
    "personality": "A mindless magical construct with no personality — pure defense of its assigned location or creator.",
    "combatStyle": "aggressive",
    "tactics": "Guards its assigned area and attacks intruders relentlessly. Targets the closest creature. Uses both fist attacks each round. Does not retreat and cannot be reasoned with.",
    "morale": "fanatical"
  },
  "rug-of-smothering": {
    "personality": "An eerie magical construct that animates to crush and suffocate — patient as furniture, deadly as a trap.",
    "combatStyle": "defensive",
    "tactics": "Waits passively until a creature stands on or near it, then uses Smother to grapple and restrain. Stays on top of its target, dealing automatic damage each round. Ignores all other threats.",
    "morale": "fanatical"
  },
  "specter": {
    "personality": "A tortured undead spirit full of rage and despair, lashing out at the living it envies.",
    "combatStyle": "aggressive",
    "tactics": "Flies through walls to find isolated targets. Uses Life Drain to slowly kill, preferring weakened targets. Incorporeal movement lets it ignore terrain. Fights until destroyed — it cannot truly die again.",
    "morale": "fanatical"
  },
  "shadow": {
    "personality": "A dark, predatory entity that hunts in darkness and drains the strength from its victims.",
    "combatStyle": "hit-and-run",
    "tactics": "Stays in darkness or dim light where it has advantage. Strength Drain weakens targets to make them easier to kill. Targets creatures with low Strength first. Creates more shadows from slain humanoids.",
    "morale": "fanatical"
  },
  "hell-hound": {
    "personality": "A fiendish predator bred in the Nine Hells for hunting. Disciplined, vicious, and obedient to evil masters.",
    "combatStyle": "pack-tactics",
    "tactics": "Flanks with pack mates to gain Pack Tactics advantage. Uses Fire Breath (recharge 5-6) on clusters of enemies. Bites the target held down by allies. Fights until slain — fiendish loyalty.",
    "morale": "fanatical"
  },
  "winter-wolf": {
    "personality": "An intelligent, cruel predator that uses cold and cunning to overwhelm prey. Speaks Giant and boasts of its kills.",
    "combatStyle": "tactical",
    "tactics": "Opens with Cold Breath to freeze clustered enemies. Uses Pack Tactics by flanking with allies. Bites prone or frozen targets for advantage. Retreats to regroup if isolated.",
    "morale": "brave"
  },
  "werewolf": {
    "personality": "A conflicted or feral lycanthrope — either tormented by its curse or fully embracing the beast within.",
    "combatStyle": "aggressive",
    "tactics": "Charges the most dangerous-looking enemy. Uses multiattack (claw + bite) every round. Prioritizes biting to spread lycanthropy. Regenerates while in hybrid or wolf form. Retreats when near death.",
    "morale": "brave"
  },
  "mummy": {
    "personality": "An ancient cursed guardian bound to protect a tomb for eternity. Radiates supernatural dread.",
    "combatStyle": "aggressive",
    "tactics": "Advances slowly and uses Dreadful Glare to frighten enemies into paralysis. Attacks with Rotting Fist to inflict Mummy Rot curse. Ignores damage from nonmagical weapons. Fights until destroyed.",
    "morale": "fanatical"
  },
  "phase-spider": {
    "personality": "An alien ambush predator that slips between the Ethereal and Material planes to hunt its prey.",
    "combatStyle": "hit-and-run",
    "tactics": "Phases into the Ethereal Plane after each attack to avoid retaliation. Bites from ethereal overlap positions. Targets isolated or weakened enemies. Phases out when badly wounded.",
    "morale": "normal"
  },
  "spectator": {
    "personality": "An aberrant guardian bound to protect something specific for 101 years. Pedantic about its duty, delusional when stressed.",
    "combatStyle": "defensive",
    "tactics": "Hovers in place, firing Eye Rays at all intruders. Uses Reflective Carapace to reflect spells. Prioritizes incapacitating rays on spellcasters. Guards its object and does not pursue fleeing enemies.",
    "morale": "fanatical"
  },
  "wyvern": {
    "personality": "A vicious but simple-minded flying predator. Territorial and aggressive, attacks anything it perceives as prey.",
    "combatStyle": "aggressive",
    "tactics": "Swoops down from altitude to attack with stinger first to poison prey, then follows with talons. Lands on fallen targets to tear them apart. Pursues retreating enemies — predatory instinct.",
    "morale": "brave"
  },
  "water-elemental": {
    "personality": "A churning, tireless force of nature with no personality — pure elemental will given watery form.",
    "combatStyle": "aggressive",
    "tactics": "Uses Whelm to engulf and restrain a target, drowning them. Slams other targets while maintaining the engulf. Splits attention if engulfed target is freed. Does not retreat — elemental constructs know no fear.",
    "morale": "fanatical"
  },
  "fire-elemental": {
    "personality": "An ever-hungry flame given form — it wants only to burn and consume. Crackles with elemental fury.",
    "combatStyle": "aggressive",
    "tactics": "Moves through enemy squares to set them ablaze with Fire Form. Targets clustered enemies to spread the Ignite effect. Uses touch attacks to stack burning damage. Never retreats — fire only grows.",
    "morale": "fanatical"
  },
  "air-elemental": {
    "personality": "A swirling, invisible force of wind — indifferent and overwhelming. It simply is.",
    "combatStyle": "aggressive",
    "tactics": "Uses Whirlwind to throw creatures into the air when available (recharge 4-6). Slams with two slam attacks when Whirlwind is on cooldown. Focuses on a single target to knock them prone. Ignores damage and death — elemental resolve.",
    "morale": "fanatical"
  },
  "earth-elemental": {
    "personality": "A slow, implacable force of stone and earth — patient as mountains, unstoppable in motion.",
    "combatStyle": "brute",
    "tactics": "Uses Earth Glide to approach through the floor, surprising enemies. Two slam attacks each round. Uses Siege Monster quality to smash terrain and structures. Slow to anger but utterly relentless once engaged.",
    "morale": "fanatical"
  },
  "stone-golem": {
    "personality": "A perfect magical construct — no personality, no hesitation, no mercy. Obeys its creator absolutely.",
    "combatStyle": "brute",
    "tactics": "Walks toward its target and uses Multiattack (2 slams) each round. Uses Slow aura to hamper spellcasters and fighters. Immune to all spells except specific ones. Fights until destroyed — no self-preservation instinct.",
    "morale": "fanatical"
  },
  "young-black-dragon": {
    "personality": "Sadistic and territorial, a young black dragon revels in corrosion and decay. Mocks prey before destroying it.",
    "combatStyle": "tactical",
    "tactics": "Opens with Acid Breath on clustered enemies. Uses Amphibious trait to attack from water, retreating underwater to recharge. Multiattacks the most armored target (acid bypasses metal armor). Retreats to water if badly wounded.",
    "morale": "brave"
  },
  "young-white-dragon": {
    "personality": "The most feral and least intelligent of dragons — a predator that views everything as prey or territory.",
    "combatStyle": "aggressive",
    "tactics": "Opens with Cold Breath to freeze enemies in place. Multiattacks with bite and claws. Uses Ice Walk to fight on icy terrain where enemies slip. Retreats to lair if badly wounded — even white dragons have self-preservation.",
    "morale": "brave"
  },
  "young-blue-dragon": {
    "personality": "Vain and territorial, a blue dragon sees itself as a natural ruler. Demands tribute and obliterates defiance.",
    "combatStyle": "tactical",
    "tactics": "Uses Lightning Breath on groups in a line. Keeps mobile with flight to stay out of melee. Targets spellcasters and ranged attackers first. Retreats to lair if below half HP — too proud to die in the field.",
    "morale": "brave"
  },
  "mind-flayer": {
    "personality": "Cold, calculating, and supremely arrogant. Views all other races as either thralls or food. Tactical to the point of cowardice.",
    "combatStyle": "spellcaster",
    "tactics": "Opens with Mind Blast to stun multiple enemies. Uses Dominate Monster on the strongest warrior to turn them against allies. Extracts brains only from stunned or helpless targets. Immediately flees via plane shift if the situation turns against it.",
    "morale": "cowardly"
  },
  "vampire": {
    "personality": "Centuries of predation have made this vampire patient, manipulative, and utterly convinced of its own superiority.",
    "combatStyle": "tactical",
    "tactics": "Uses Charm to neutralize the most dangerous combatant. Bites charmed or grappled targets to drain HP and abilities. Calls mist and bat forms to reposition or escape. Retreats to coffin if reduced to low HP to regenerate.",
    "morale": "normal"
  },
  "roper": {
    "personality": "A sessile ambush predator that mimics stalagmites perfectly. Infinitely patient, lethal once it strikes.",
    "combatStyle": "defensive",
    "tactics": "Fires up to 6 tendrils at once to grapple and drag creatures into its bite. Retracts tendrils on damaged creatures and sends new ones. Stays rooted in place — it never needs to move. Fights until destroyed.",
    "morale": "fanatical"
  },
  "hydra": {
    "personality": "A mindless, voracious water monster that becomes more dangerous the more you hurt it. Pure appetite.",
    "combatStyle": "aggressive",
    "tactics": "Makes one bite per active head (starts at 5). Regrows two heads for each severed head unless also dealt fire damage. Targets the same creature with multiple bite attacks. Never retreats — the hydra only knows hunger.",
    "morale": "fanatical"
  },
  "frost-giant": {
    "personality": "A proud warrior of the frozen north who respects only strength. Bellows challenges and crushes the weak.",
    "combatStyle": "brute",
    "tactics": "Opens by hurling rocks (range 60/240) before closing to greataxe melee. Targets the largest or most armored enemy first. Uses Multiattack (2 greataxe strikes). Retreats only if magically compelled — frost giants do not show weakness.",
    "morale": "brave"
  },
  "fire-giant": {
    "personality": "A militaristic warrior-smith who values discipline and conquest above all. Views combat as a craft to be perfected.",
    "combatStyle": "tactical",
    "tactics": "Throws rocks at ranged enemies while closing. Uses Multiattack (2 greatsword strikes) on the most dangerous melee target. Coordinates with other fire giants in tactical formations. Fights to the last — retreating dishonors the forge.",
    "morale": "brave"
  },
  "ancient-black-dragon": {
    "personality": "An ancient apex predator drowning in centuries of spite and cruelty. Its very presence poisons the land.",
    "combatStyle": "tactical",
    "tactics": "Opens with Acid Breath on the largest cluster of enemies. Uses Legendary Actions between rounds to strike, detect, or use wing attack. Targets healers and spellcasters first. Retreats to its swamp lair if seriously threatened — it has lived too long to die foolishly.",
    "morale": "brave"
  },
  "beholder": {
    "personality": "Paranoid, megalomaniacal, and utterly convinced all other beings — including other beholders — are inferior and threatening.",
    "combatStyle": "tactical",
    "tactics": "Keeps its antimagic cone aimed at the most dangerous spellcaster. Fires multiple eye rays per round targeting different threats. Uses Charm Ray, Fear Ray, and Disintegrate Ray in rotation. Stays hovering out of melee reach. Never willingly retreats from its lair.",
    "morale": "brave"
  },
  "lich": {
    "personality": "An archmage who traded life for immortality. Coldly logical, endlessly patient, considers all others as test subjects.",
    "combatStyle": "spellcaster",
    "tactics": "Opens with Disrupt Life to damage all living creatures in range. Uses legendary actions to cast spells between rounds. Targets concentration spells first to prevent counterspells. Uses Paralyzing Touch on approaching melee fighters. Returns via phylactery if destroyed.",
    "morale": "fanatical"
  },
  "pit-fiend": {
    "personality": "A supreme devil general who commands absolute loyalty through fear and contract. Every action is calculated for maximum domination.",
    "combatStyle": "tactical",
    "tactics": "Opens with Wall of Fire to divide the battlefield. Uses Multiattack (mace + tail + claw + bite) on the paladin or most dangerous holy warrior. Casts Fear on grouped enemies. Summons lesser devils when below half HP. Retreats to Avernus rather than die outside its plane.",
    "morale": "normal"
  },
  "kraken": {
    "personality": "An ancient, godlike entity of the deep seas. Patient beyond mortal comprehension, wrathful when disturbed. It views mortals as insects.",
    "combatStyle": "aggressive",
    "tactics": "Uses Tentacle attacks to grapple and restrain multiple targets simultaneously. Uses Fling to hurl grappled creatures into other enemies or walls. Lightning Storm hits all non-tentacle targets. Uses Ink Cloud to blind enemies trying to flee. It does not flee — it is the apex of the ocean.",
    "morale": "fanatical"
  }
};

const rqPersonality = {
  "broo": {
    "personality": "A disease-ridden chaos spawn that wallows in corruption and violence. Gleefully cruel and unpredictable.",
    "combatStyle": "aggressive",
    "tactics": "Opens with Speedart spirit magic to boost arrow shots, then closes to mace combat. Casts Sickness on the healthiest-looking target. Uses chaotic nature to act unpredictably — may attack randomly or use Chaos Gift at worst moments.",
    "morale": "brave"
  },
  "dark-troll": {
    "personality": "A cunning nocturnal hunter that uses darkness magic and overwhelming strength to dominate prey.",
    "combatStyle": "tactical",
    "tactics": "Opens by casting Darkwall to create a field of magical darkness, then attacks through it using infravision. Uses Demoralize to reduce enemy morale. Casts Strength before major attacks. Aims for the highest-SIZ opponent first.",
    "morale": "brave"
  },
  "scorpion-man": {
    "personality": "A savage predator of arid wastelands, combining humanoid cunning with scorpion lethality. It hunts the Prax plains.",
    "combatStyle": "aggressive",
    "tactics": "Leads with claw attacks to lock down a target, then delivers the POT 14 sting for paralysis. Keeps attacking the same target until they fall. POW-strong targets get claws; weaker ones get sting first.",
    "morale": "brave"
  },
  "jack-o-bear": {
    "personality": "A terrifying chaotic predator whose fear aura breaks enemy morale before the claws do. Hunts with nightmarish patience.",
    "combatStyle": "aggressive",
    "tactics": "Enters within 10m to trigger fear aura (POW vs POW check or flee). Attacks those who hold their nerve with claw and bite. Targets the most frightened-looking enemy. Fights until prey flees or is killed.",
    "morale": "brave"
  },
  "walktapus": {
    "personality": "A mindless chaos horror that grabs everything within reach of its tentacles and tears it apart with its beak.",
    "combatStyle": "aggressive",
    "tactics": "Fires multiple tentacles to grapple as many creatures as possible. Hauls grappled creatures toward its beak for massive damage. Ignores pain and keeps grappling even when tentacles are damaged.",
    "morale": "fanatical"
  },
  "giant-beetle": {
    "personality": "A mindless armored predator driven entirely by hunger and territorial instinct. Unstoppable once enraged.",
    "combatStyle": "brute",
    "tactics": "Charges the nearest creature and bites repeatedly. Heavy carapace armor shrugs off many attacks. No tactics beyond advancing and biting — pure animal aggression.",
    "morale": "brave"
  },
  "saber-tooth-cat": {
    "personality": "A legendary predator of the Prax plains — patient, calculating, strikes with devastating initial force.",
    "combatStyle": "hit-and-run",
    "tactics": "Stalks to close range before attacking. Opens with a bite for maximum damage (bonus d6 on first attack) then follows with claws. Retreats if outnumbered to stalk easier prey — too valuable to die pointlessly.",
    "morale": "normal"
  },
  "griffin": {
    "personality": "A noble aerial predator that considers itself above most creatures. Territorial but not malicious — unless you threaten its nest.",
    "combatStyle": "hit-and-run",
    "tactics": "Opens with a dive attack from altitude (bonus damage). Strikes with fore-claw and beak then ascends before enemies can retaliate. Targets horses and mounted riders first. Retreats if significantly wounded.",
    "morale": "normal"
  },
  "centaur": {
    "personality": "A proud, honor-bound warrior of the Prax plains with a deep connection to Ernalda. Fights with discipline and skill.",
    "combatStyle": "tactical",
    "tactics": "Opens with composite bow fire at long range. Closes to spear combat using charging movement for bonus damage. Casts Protection and Heal as needed. Targets the most dangerous-looking opponent. Retreats only if overwhelmed.",
    "morale": "brave"
  },
  "minotaur": {
    "personality": "A berserking warrior who invokes Berserk and charges headlong into battle, gorging on the chaos of melee.",
    "combatStyle": "berserker",
    "tactics": "Casts Berserk and Bladesharp before combat if possible. Charges the nearest enemy and attacks with great axe, using gore as a secondary. Berserk state prevents retreat — fights to the death in that state.",
    "morale": "brave"
  },
  "dragonewt": {
    "personality": "A draconic being on the path of spiritual advancement. Fights with disciplined skill and arcane power — death is merely an inconvenience it must meditate on.",
    "combatStyle": "tactical",
    "tactics": "Opens with Detection Magic to identify magical threats. Casts Protection and Bladesharp. Uses klanth in skilled melee, dodging as needed. Casts Breath of Fire on groups. Does not fear death due to reincarnation belief.",
    "morale": "brave"
  },
  "dream-dragon": {
    "personality": "An ancient, legendary draconic entity of Gloranthan myth. Speaks in riddles and treats mortals as fascinating curiosities — until they become annoying.",
    "combatStyle": "spellcaster",
    "tactics": "Opens with Dream Breath on the largest cluster of enemies (POW vs POW or magical sleep). Casts Dragon's Might to enhance itself. Bites and claws anything that gets close. Uses True Dragonform only in extreme peril. Does not truly care if mortals die.",
    "morale": "brave"
  },
  "allosaur": {
    "personality": "A massive, mindless predator from Prax — pure hunter with no thought beyond the next meal.",
    "combatStyle": "aggressive",
    "tactics": "Charges the largest prey animal and bites. Uses tail lash against anything flanking. Focuses entirely on one target until it drops. Does not retreat — predatory instinct overrides self-preservation.",
    "morale": "brave"
  },
  "disease-spirit": {
    "personality": "A malevolent spirit of Mallia that exists only to spread disease and suffering. Invisible, patient, insidious.",
    "combatStyle": "spellcaster",
    "tactics": "Attacks through spirit combat first. Uses disease touch on the highest-CON target to strip them. Casts Disruption on those resisting spirit combat. Sneaks up using its 90% sneak skill — surprise is its primary weapon.",
    "morale": "fanatical"
  },
  "air-elemental-medium": {
    "personality": "A bound elemental of the wind rune — mindless, impersonal, overwhelmingly powerful in motion.",
    "combatStyle": "aggressive",
    "tactics": "Uses whirlwind to engulf targets and deal ongoing damage. Wind buffet on anyone not engulfed. Prioritizes engulfing the leader or most armored fighter. Does not retreat — elemental constructs do not choose to stop.",
    "morale": "fanatical"
  },
  "earth-elemental-medium": {
    "personality": "A summoned gnome of immense crushing weight — slow, implacable, immune to most harm.",
    "combatStyle": "brute",
    "tactics": "Passes through earth to appear beneath enemies. Slams with massive engulf attack to trap victims in earth. Ignores incoming damage from normal weapons. Focuses on one target until destroyed or dismissed.",
    "morale": "fanatical"
  },
  "fire-elemental-medium": {
    "personality": "A salamander of living fire — hungry and eager to burn everything it touches.",
    "combatStyle": "aggressive",
    "tactics": "Fire touch to set targets ablaze, then lets burning damage stack each round. Moves through flammable terrain to spread fire. Targets those wearing metal armor last — focuses on lighter-armored victims first.",
    "morale": "fanatical"
  },
  "water-elemental-medium": {
    "personality": "A summoned undine that seeks to drown all it engulfs. Cold, relentless, watery destruction.",
    "combatStyle": "aggressive",
    "tactics": "Water slam to grapple, then drowning attack to strip CON each round. Pulls grappled targets away from allies. Slams anyone trying to free the drowning victim. Cannot be summoned far from water.",
    "morale": "fanatical"
  },
  "cave-troll": {
    "personality": "A brutish, light-blind cave predator with overwhelming raw power. Smashes everything, eats the remains.",
    "combatStyle": "brute",
    "tactics": "Casts Darkwall to neutralize light-based disadvantage. Throws rocks to open combat, then charges for great club and bite. Targets the smallest creature first — instinct to attack what it can crush. Fights until slain.",
    "morale": "brave"
  },
  "baboon": {
    "personality": "A semi-intelligent creature of Prax that respects power and tradition. Will parley if shown strength — attacks if disrespected.",
    "combatStyle": "pack-tactics",
    "tactics": "Troops cooperate to surround a single enemy. Combines bite and club attacks. Uses climb to attack from elevated positions and retreat up cliff faces. Retreats as a group if half the troop falls.",
    "morale": "normal"
  }
};

// Add personality fields to 5e monsters
const dnd5ePath = path.join(__dirname, '../monsters/monsters-5e-srd.json');
const dnd5e = JSON.parse(fs.readFileSync(dnd5ePath, 'utf8'));

let dnd5eUpdated = 0;
for (const [slug, data] of Object.entries(dnd5ePersonality)) {
  if (dnd5e[slug]) {
    dnd5e[slug].personality = data.personality;
    dnd5e[slug].combatStyle = data.combatStyle;
    dnd5e[slug].tactics = data.tactics;
    dnd5e[slug].morale = data.morale;
    dnd5eUpdated++;
  } else {
    console.warn(`WARNING: 5e monster slug not found: ${slug}`);
  }
}

fs.writeFileSync(dnd5ePath, JSON.stringify(dnd5e, null, 2));
console.log(`Updated ${dnd5eUpdated}/${Object.keys(dnd5e).length} 5e monsters`);

// Add personality fields to RQ monsters
const rqPath = path.join(__dirname, '../monsters/monsters-rq-core.json');
const rq = JSON.parse(fs.readFileSync(rqPath, 'utf8'));

let rqUpdated = 0;
for (const [slug, data] of Object.entries(rqPersonality)) {
  if (rq[slug]) {
    rq[slug].personality = data.personality;
    rq[slug].combatStyle = data.combatStyle;
    rq[slug].tactics = data.tactics;
    rq[slug].morale = data.morale;
    rqUpdated++;
  } else {
    console.warn(`WARNING: RQ monster slug not found: ${slug}`);
  }
}

fs.writeFileSync(rqPath, JSON.stringify(rq, null, 2));
console.log(`Updated ${rqUpdated}/${Object.keys(rq).length} RQ monsters`);

console.log('Done!');

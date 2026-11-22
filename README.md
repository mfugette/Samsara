# Samsara

A Minecraft modpack for **NeoForge 1.21.1** built around the Buddhist idea of
*saṃsāra*, the cycle of rebirth. You cannot permanently die. Every death sends you to one
of seven realms, and your karma decides which. The long-term goal is to escape the cycle.

All of Samsara's own logic is [KubeJS](https://kubejs.com/) scripts and a datapack, both
under `kubejs/`.

> **Work in progress.** Karma, rebirth, all seven realms, ageing and graves work in game.
> Some parts are not built yet (see [Status](#status)), and this repository does not yet
> load as-is (see [Installing](#installing)).

## How it plays

### Karma

What you do builds up six stats: three poisons and their three antidotes.

| Poison | Antidote | A life led by this poison is reborn as |
|---|---|---|
| Greed | Generosity | a hungry ghost (preta) |
| Hatred | Loving-kindness (metta) | a being in hell (naraka) |
| Delusion | Wisdom | an animal |

For example:

- Striking or killing a peaceful animal adds hatred; killing a villager adds far more.
  Killing hostile mobs adds a little, and less the more you kill in one life.
- Opening a container that belongs to someone else (another player's, or one in a
  village) adds greed.
- Dying carelessly adds delusion, and dying again soon after adds more.
- Feeding animals adds generosity. Taking hits from hostile mobs without striking back
  adds metta.
- Wisdom has no source yet. It is meant to come from insight and meditation.

### Rebirth

When you die, your karma picks your next life:

- With little karma either way, you are born human again. Every new player starts here.
- If your poisons clearly outweigh your antidotes, and weigh enough, you fall to a lower
  realm chosen by your strongest poison.
- Strong merit with little wisdom makes you a deva.
- Merit mixed with aggression makes you an asura.
- Anything else: human.

Each rebirth then uses up part of the karma that caused it, so neither heaven nor hell
lasts for ever. Wisdom carries over between lives far better than anything else.

A realm's rules follow the realm you were **born** into, not where you stand. A human who
walks into the Nether is only visiting.

### The realms

| Realm | Where you are born | A life lasts | What it is like |
|---|---|---|---|
| Brahma | its own dimension | 12 h | reached only through meditation, which is not built yet |
| Deva | its own Overworld-like dimension | 6 h | Radiance of the Blessed: faster, stronger, healing, golden hearts, no fire damage; mobs leave you alone |
| Human | the Overworld | 6 h | the only realm from which liberation is possible |
| Asura | the deva realm, at the foot of its mountains | 3 h | no special rules yet |
| Hungry ghost | the Overworld, at your last human grave | 30 min | nothing harms or hunts you and only other ghosts can see you; you can hold only food, every meal is a crumb, and the hunger never stops |
| Animal | the Overworld, in your creature's home biome | 15 min | Adventure mode, no crafting or containers; you graze or hunt by your diet; only predators hunt you |
| Hell | its own dimension | 30 min | half health; Self-wrought Torment slows, weakens and starves you, and withers you down to one heart -- but never kills |

A life's length counts only while you play. When it runs out, you die of old age and are
reborn.

With Woodwalkers installed, an animal-born player takes the body of an Alex's Mobs
creature: a herbivore, omnivore or carnivore, depending on how their karma leaned.

### Graves

Only humans leave graves (Corail Tombstone). In any other life your belongings simply drop
where you die, and a grave key cannot be used until you are human again.

### Liberation

Liberation is possible only from a human life, and needs a large share of wisdom with
very little greed, hatred or delusion. Generosity and metta alone lead to the deva realm,
not out of the cycle.

## Status

**Working:** karma and rebirth, ripening, every realm's place and lifespan, the rules of
the hell, hungry-ghost, animal and deva realms, animal bodies, graves.

**Not built yet:** rules for the asura and brahma realms, any source of wisdom (so
liberation cannot happen in normal play), the ending that liberation leads to, quests.

## Requirements

The versions the pack is built and tested with:

| Mod | Version | Needed for |
|---|---|---|
| NeoForge | 21.1.264 (Minecraft 1.21.1) | everything |
| KubeJS | 2101.7.2-build.377 | everything |
| Rhino | 2101.2.7-build.85 | everything (KubeJS's script engine) |
| Terralith | 2.6.2 | the deva realm's terrain |
| Streams Reflowing | 2.15.2 | the deva realm's rivers |
| Alex's Mobs | 2.2.4 | animal bodies and their home biomes |
| Woodwalkers + CraftedCore | 5.8.13 + 5.8.2 | optional: drawing an animal-born player as its creature |
| Corail Tombstone | 9.5.6 | optional: graves |
| SparseStructures | 3.0 | optional: switches off Tombstone's abandoned graves |

## Installing

This repository is the pack's source, not a ready-made download.

1. Make a NeoForge 1.21.1 instance with the mods above.
2. Copy `kubejs/` and `config/` from this repository into it.
3. Add the settings below. They cannot be shipped here because those mods' config files
   are All Rights Reserved.
   - Streams Reflowing, `config/streamsreflowing.properties`:
     `outletBiomes=#minecraft:is_river,#minecraft:is_ocean,#c:is_swamp,samsara:deva_ocean,samsara:deva_river`
   - Corail Tombstone, `config/tombstone-server.toml`: `ghostly_shape_duration = 0` (its
     ghostly shape would refill a hungry ghost's food) and `xp_loss_on_death = 100`.
     In `config/tombstone-client.toml`: `activate_grave_by_sneaking = false` and
     `display_knowledge_message = false`.
4. Create a **new world**: Samsara's dimensions are added when a world is created.

> **Known gap:** the deva realm's eight biome files (`samsara:deva_*`) are not included.
> They are built from Terralith's biome files, and Terralith's licence does not allow
> modified copies of its data to be redistributed. Until they exist in your instance, the
> `samsara:deva` dimension refers to biomes that do not exist, and Minecraft will not load
> the datapack.

## Commands

`/karma` shows your own karma, the realm it points to, and why.

With operator permission:

| Command | What it does |
|---|---|
| `/karma show <player>` | someone else's karma |
| `/karma set <player> <stat> <value>`, `/karma add ...` | change a stat (`greed`, `hatred`, `delusion`, `generosity`, `metta`, `wisdom`) |
| `/karma realm <player> <realm>` | the realm whose rules apply now |
| `/karma forcerealm <player> <realm\|none>` | where their next death sends them |
| `/karma life <player> <seconds>` | how much of their current life is left |
| `/karma liberate <player> [on\|off]` | grant or remove liberation |
| `/karma reset <player>` | clear their karma and make them human again |

Realms: `naraka`, `preta`, `animal`, `asura`, `human`, `deva`, `brahma`.

## Credits

- The realms follow the cosmology of the Pali Canon, as set out at
  [Access to Insight](https://www.accesstoinsight.org/ptf/dhamma/sagga/loka.html). The
  asura follows the Mahayana and Tibetan reading: a warring demigod with real merit,
  consumed by envy.
- Built with KubeJS and Rhino. The deva realm's terrain is Terralith's (Stardust Labs),
  its rivers are Streams Reflowing's, the creatures are Alex's Mobs', the bodies are
  Woodwalkers', and the graves are Corail Tombstone's. Each belongs to its authors under
  its own licence; this repository includes only a few of their configuration files,
  where those licences allow it.

## License

No licence has been chosen yet, so all rights are reserved for now.

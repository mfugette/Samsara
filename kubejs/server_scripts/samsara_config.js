// Samsara — config. All tunable numbers live here. Edit values and run /reload to apply.
//
// Shared across the other samsara_*.js files via the global.SMS namespace so load
// order between files does not matter (everything is read at runtime, not load time).

global.SMS = global.SMS || {}

// ---- The six karma stats: three Poisons and three Antidotes -----------------
//
// The three unwholesome roots (akusala-mula) and the three qualities that counter
// them. Each poison has a direct antidote: greed/generosity, hatred/metta,
// delusion/wisdom.
//
// These are NON-NEGATIVE accumulators, floored at 0 and capped at config.statCap.
// A negative poison would be incoherent -- "anti-greed" is already generosity --
// and routing divides by (A + P), so a signed scale would divide by zero whenever
// the two sides cancelled. Keeping them unsigned is what makes every share in
// config.routing meaningful.
global.SMS.POISONS = ['greed', 'hatred', 'delusion']
global.SMS.ANTIDOTES = ['generosity', 'metta', 'wisdom']
global.SMS.STATS = global.SMS.POISONS.concat(global.SMS.ANTIDOTES)

// Which antidote counters which poison. Used by the readout to pair them up, and
// available to any future mechanic that wants the opposing stat.
global.SMS.ANTIDOTE_FOR = {
    greed: 'generosity',
    hatred: 'metta',
    delusion: 'wisdom',
}

global.SMS.config = {
    // ---- Scale --------------------------------------------------------------
    // Every stat lives in 0 .. statCap. Small numbers are deliberate: the player
    // reads these in Yama's ledger, and a 0-10 scale is legible at a glance where
    // an unbounded accumulator is not.
    statCap: 10.0,

    // All stat writes are rounded to a multiple of this. Award values are drawn
    // from {0.1, 0.25, 0.5, 0.75, 1.0}, whose finest common grain is 0.05, so
    // quantising here means a stat can never carry a trailing decimal beyond two
    // places. This is enforced in ONE place (global.SMS.setStat) so nothing can
    // bypass it -- ripening and passive decay both produce values like
    // 1.125 or 2.4750000000000001 otherwise.
    statGrain: 0.05,

    // ---- Karma point values -------------------------------------------------
    // Each entry says: this act adds this much to this stat. Values are additive
    // and positive -- a "bad" act grows a poison, it does not shrink an antidote.
    //
    // Scaled for statCap = 10: killHostile at 0.1 means 100 hostiles to cap hatred,
    // killVillager at 1.0 means ten villagers. Every value is from the agreed
    // increment set {0.1, 0.25, 0.5, 0.75, 1.0}.
    karma: {
        // --- Hatred: harming living things ---
        killHostile: 0.1, // hostiles are cheapest -- combat is normal play here
        killPassive: 0.25, // animals and other peaceful mobs
        killVillager: 1.0, // villager-class: the heaviest single act in the game
        killTamed: 1.0, // a tamed or named animal: betrayal of a bond
        killBaby: 0.5, // a baby animal
        hurtPassive: 0.1, // struck a peaceful mob and left it alive

        // --- Greed: taking what was not given ---
        lootContainer: 0.1, // opened a container the player did not place
        breakVillagerBlock: 0.25, // destroyed a villager's workstation or bed

        // --- Delusion: heedlessness (moha) ---
        carelessDeath: 0.25, // died with nobody to blame -- fall, lava, drowning
        repeatDeath: 0.5, // died again inside the rapid-death window

        // --- Generosity (dana) ---
        breedAnimal: 0.25, // caring for life (breeding proxy, see samsara_karma.js)

        // --- Metta: active goodwill toward beings ---
        plantCrop: 0.1, // tending life rather than taking it
        tameAnimal: 0.25, // taking an animal into your care
        feedAnimal: 0.1, // feeding or healing an animal

        // --- Wisdom (panna) ---
        // DELIBERATELY EMPTY. Wisdom comes from insight: the Four Sights, realm
        // beings, past-life recollection and jhana -- all phase 6+ content that
        // does not exist yet. Since wisdom is the ONLY key to liberation
        // (config.liberation), this means liberation is phase-6-gated by design,
        // not by oversight. Do not add a filler wisdom source to "unblock" it.
    },

    // Which stat each act feeds. Keeping this separate from the numbers means
    // re-routing an act to a different stat is a one-word edit.
    //
    // NOTE on metta vs. the old `virtue`: metta is loving-kindness, so it covers
    // acts directed AT a living being (feeding, taming, tending). General ethical
    // conduct -- honest trades, not stealing -- is handled as the ABSENCE of greed
    // rather than as a metta award. There is no act here that pays for merely
    // refraining.
    karmaStat: {
        killHostile: 'hatred',
        killPassive: 'hatred',
        killVillager: 'hatred',
        killTamed: 'hatred',
        killBaby: 'hatred',
        hurtPassive: 'hatred',

        lootContainer: 'greed',
        breakVillagerBlock: 'greed',

        carelessDeath: 'delusion',
        repeatDeath: 'delusion',

        breedAnimal: 'generosity',

        plantCrop: 'metta',
        tameAnimal: 'metta',
        feedAnimal: 'metta',
    },

    // ---- Rebirth routing ----------------------------------------------------
    // Routing works on SHARES of the total, never on raw sums, so it is scale-free:
    //
    //   P   = greed + hatred + delusion          (poison total)
    //   A   = generosity + metta + wisdom        (antidote total)
    //   Net = A / (A + P)                        (0 = all poison, 1 = all antidote)
    //   share(stat) = stat / (A + P)
    //
    // With both totals at 0, Net is defined as 0.5 -- a new player is perfectly
    // balanced and routes to human by rule 5. That is why no special case is needed
    // to start the game as a human.
    //
    // Rules are evaluated IN ORDER and the first match wins:
    //
    //   0. minTotal floor   -> human   (not enough karma to judge)
    //   1. liberation       -> no rebirth at all (see config.liberation)
    //   2. Net < lowerNet   -> down; the largest poison picks the realm
    //   3. Net >= devaNet AND wisdom share of A < devaWisdomMax -> deva
    //   4. Net >= asuraNet AND hatred leads P AND hatred share >= asuraHatredShare
    //                       -> asura
    //   5. otherwise        -> human
    routing: {
        // Rule 0. Below this much total karma (A + P), routing always returns human.
        //
        // This is what stops a brand-new player's FIRST kill from deciding their
        // next life. One hostile gives P = 0.1, A = 0, so Net = 0.0, which is below
        // lowerNet and would otherwise route straight to the animal realm. The floor
        // is the direct successor to the old `neutralBand`, expressed on the new
        // scale.
        minTotal: 2.0,

        // Rule 2. Below this Net, the player falls. 0.40 means poison must outweigh
        // antidote by roughly 3:2 before a lower rebirth happens.
        lowerNet: 0.40,

        // Rule 3. Deva: real merit, but no insight. Virtue without wisdom is the
        // classic deva trap -- a pleasant birth that burns through its own merit.
        devaNet: 0.65,
        devaWisdomMax: 0.25, // wisdom's share OF THE ANTIDOTE TOTAL, not of A+P

        // Rule 4. Asura: merit corrupted by aggression. Checked after deva, so a
        // wise, peaceful, high-merit player is never dragged here.
        //
        // NOTE ON TRADITION. This source (accesstoinsight.org/ptf/dhamma/sagga/
        // loka.html) is Theravada and places asuras in the LOWER realms (rank 4, in
        // the states of deprivation, caused by the ten unwholesome actions). This
        // pack follows the Mahayana/Tibetan reading instead, where the asura is a
        // warring demigod with genuine merit consumed by envy. That is a deliberate
        // choice: it gives merit-plus-hatred its own destination rather than
        // collapsing it into hell, which is better game design and matches the
        // design doc's "beings with real virtue who are consumed by conflict".
        asuraNet: 0.50,
        asuraHatredShare: 0.15, // hatred's share of A+P

        // Tie-break order when two stats in a group are exactly equal, listed
        // LEAST severe first. A tie resolves to the earlier entry, so an evenly
        // spread life gets the gentler verdict.
        //
        // Delusion comes first among the poisons because it is the ROOT poison --
        // greed and hatred both rest on it -- so an ambiguous bad life reads as
        // heedless rather than malicious. Without an explicit order, ties fell to
        // array order and a 1/1/1 poison spread routed to hell purely because
        // 'hatred' happened to be listed first.
        tieBreak: [
            // poisons, gentlest outcome first: animal, then hungry ghost, then hell
            'delusion',
            'greed',
            'hatred',
            // antidotes, most ordinary first, so a tie does not over-reward
            'metta',
            'generosity',
            'wisdom',
        ],
    },

    // ---- Liberation ---------------------------------------------------------
    // The exit from samsara. Checked FIRST in routing (rule 1), and only for a
    // player who is already human -- liberation is reachable from the human realm
    // alone, which is what makes a human birth "precious".
    //
    // DESIGN PRINCIPLE: generosity and metta improve the QUALITY of a rebirth, but
    // only wisdom unlocks the exit. Maxing the other two antidotes lands you in
    // deva, not nibbana. These thresholds encode exactly that -- note that wisdom
    // needs a large share of EVERYTHING (A + P), so a player cannot buy their way
    // out by piling up generosity; doing so inflates A and pushes wisdom's share
    // back down. Liberation requires restraint, not accumulation.
    liberation: {
        enabled: true,

        // Wisdom's share of A + P must reach this.
        wisdomShareMin: 0.40,
        // Each poison's share of A + P must be at or under its ceiling.
        delusionShareMax: 0.05,
        greedShareMax: 0.10,
        hatredShareMax: 0.10,

        // Only check for a player whose birthRealm is one of these.
        realms: ['human'],
    },

    // ---- Karma ripening -----------------------------------------------------
    // On each rebirth, the karma that caused the birth is partly SPENT. This is
    // what stops a permanent heaven or a permanent hell: a deva falls when its
    // merit is exhausted, and a hell-being leaves when its hatred is.
    //
    // This REPLACES the old flat 25% death burn. The burn hit all six stats
    // equally and ran before the destination was known, so it could not be
    // realm-specific. Ripening is realm-specific by definition, so it runs AFTER
    // pickDestination resolves the realm.
    ripening: {
        enabled: true,

        // Lower realms (naraka / preta / animal): spend the poison that sent you
        // there. Only the DOMINANT poison is reduced -- the specific karma ripened.
        lowerDominantPoison: 0.50,

        // Deva and asura: these births run on generosity and metta, so those are
        // what burn away. Wisdom is excluded on purpose (see wisdomRate).
        higherGenerosity: 0.50,
        higherMetta: 0.50,

        // Human: an ordinary life spends a little of everything.
        humanAll: 0.20,

        // Wisdom ripens far more slowly than anything else, in EVERY realm. Insight
        // carries over between lives -- this is the soft form of the canonical rule
        // that stream-entry permanently closes off the lower realms. Whatever the
        // realm-specific rates above would do to wisdom, this overrides.
        wisdomRate: 0.10,

        // Anti-farm, inherited from the old death burn. Without it a player stuck
        // in hell could suicide repeatedly to ripen their hatred away, which would
        // make any escape task pointless. Each death inside cooldownTicks of the
        // previous one multiplies every rate above by repeatFalloff again, so the
        // 1st death ripens fully, the 2nd ~35%, the 3rd ~12%. Waiting out the
        // cooldown resets the streak.
        //
        // 12000 ticks = 10 real minutes.
        cooldownTicks: 12000,
        repeatFalloff: 0.35,
    },

    // ---- Realm -> dimension mapping -----------------------------------------
    // Samsara owns its realms. The dimensions below ship WITH this mod as datapack
    // JSON under kubejs/data/samsara/, so nothing here depends on a third-party mod
    // being installed or configured a particular way.
    //
    // Only `human` and `animal` use vanilla dimensions, and they always exist.
    //
    // BRAHMA IS NOT REACHABLE BY KARMA, and that is correct. In the source
    // cosmology the brahma realms (ranks 12-22) are reached ONLY by jhana
    // attainment, graded by jhana stage -- not by accumulated merit at all. The
    // routing rules therefore have no brahma branch. The realm stays fully defined
    // here (dimension, spawn, scan bounds) so the jhana gate in phase 6 can be its
    // sole entrance.
    realmDimensions: {
        naraka: 'samsara:naraka',
        preta: 'samsara:preta',
        animal: 'minecraft:overworld', // the animal realm shares the human world
        asura: 'samsara:asura',
        human: 'minecraft:overworld',
        deva: 'samsara:deva',
        brahma: 'samsara:brahma', // jhana only -- see note above
    },

    // ---- Optional third-party integrations ----------------------------------
    // If a pack ships a mod with a better-suited dimension, prefer it. Each entry is
    // only applied when that dimension actually resolves at runtime, so an uninstalled
    // mod costs nothing and nothing here is a hard dependency.
    //
    // Pack authors: add, remove or reorder freely. Later entries win.
    realmOverrides: [
        { realm: 'deva', dimension: 'aether:the_aether' },
        { realm: 'preta', dimension: 'undergarden:undergarden' },
        // NOTE: deliberately commented out. minecraft:the_end always resolves, so
        // this would ALWAYS win over samsara:asura and the custom realm would never
        // be seen. Uncomment only in a pack with an End overhaul worth preferring.
        // { realm: 'asura', dimension: 'minecraft:the_end' },
    ],

    // Set true to ignore realmOverrides entirely and always use Samsara's own
    // dimensions, even when the other mods are present.
    forceOwnDimensions: false,

    // Deva is tiered: the source puts six heavens in the sense-sphere. When Twilight
    // Forest is present it serves as the LOWEST heaven (Four Great Kings -- yakkhas
    // and tree spirits, which the source compares to goblins and fairies), so a
    // player who is barely a deva lands there rather than in the heaven proper.
    // Falls back silently to the realm's normal dimension when absent.
    //
    // Threshold is on the 0..statCap scale now, not the old unbounded one.
    devaTiers: {
        lowestHeaven: 'twilightforest:twilight_forest',
        generosityThreshold: 5.0,
    },

    // ---- Realm penalties ----------------------------------------------------
    // CRITICAL RULE: penalties follow the player's birthRealm, NEVER the dimension
    // they happen to be standing in. Players still need the Nether for blaze rods and
    // netherite and the End for progression -- a human walking through a portal is
    // just VISITING. Only a player *born* into a realm lives under its rules.
    // See design doc section 7.
    realmEffects: {
        naraka: {
            // The body itself is diminished. 20.0 is the vanilla default,
            // so 10.0 is five hearts.
            maxHealth: 10.0,
        },

        preta: {
            // Hungry ghost: a huge belly and a pinhole mouth. Food the preta eats for
            // itself barely registers -- generosity will be the efficient way to eat
            // once feeding others is implemented (design doc 7).
            foodMultiplier: 0.2,

            // The hunger bar is CAPPED, not just lowered once. 6 points = 3 icons
            // (the bar is drawn as 10 icons over 20 points, so one icon is 2 points).
            // Enforced as a ceiling on a timer because vanilla keeps refilling it:
            // a one-shot setFoodLevel would be undone by the next meal.
            foodCap: 6.0,

            // A permanent, renewed hunger effect: the preta is never not starving.
            // amplifier 0 is Hunger I -- it drains saturation/food steadily. Higher
            // amplifiers drain fast enough to starve through the cap continuously.
            hungerEffect: {
                id: 'minecraft:hunger',
                amplifier: 0,
                // Re-applied well before it lapses, so the icon never flickers off.
                // Duration is in TICKS for the /effect command (it takes seconds --
                // see samsara_realms.js, which converts).
                durationTicks: 400,
            },

            // Spectral and starved: a diminished body, though less so than naraka.
            maxHealth: 14.0,
        },

        animal: {
            // An animal has no hands for tools and no mind for planning. It can
            // still fight, forage, break blocks and carry items, but it cannot
            // craft, open containers, or build.
            noCrafting: true,
            noContainers: true,
            noBlockPlacing: true,
        },
    },

    // Blocks an animal-realm player may not open. Matched by suffix so modded
    // variants (copper_chest, oak_barrel, ...) are caught without listing each one.
    containerBlockSuffixes: [
        'chest',
        'barrel',
        'shulker_box',
        'furnace',
        'smoker',
        'blast_furnace',
        'dispenser',
        'dropper',
        'hopper',
        'crafting_table',
        'anvil',
        'enchanting_table',
        'brewing_stand',
        'loom',
        'cartography_table',
        'smithing_table',
        'stonecutter',
        'grindstone',
        'beacon',
        // Added after a coverage check: these are all real storage or interaction
        // blocks that an animal should not be able to work, and the suffix list
        // missed every one of them.
        'lectern',
        'composter',
        'cauldron', // includes water_cauldron / lava_cauldron / powder_snow_cauldron
        'chiseled_bookshelf',
        'decorated_pot',
        'crafter', // 1.21+ auto-crafter; harmless to list early
        'bee_nest',
        'beehive',
        'campfire', // cooking station
    ],

    // ---- Passive karma decay ------------------------------------------------
    // Karma is not a permanent ledger: in Buddhist thought a birth ends when the
    // karma that produced it is exhausted, so karma must wear away with time too,
    // not only at death.
    //
    // Proportional rather than flat, so a large debt sheds quickly at first and then
    // slows, while small amounts linger instead of snapping to zero.
    decay: {
        enabled: true,

        // 6000 ticks = 5 real minutes. At 1% per 5 min a stat halves in ~5.7 hours
        // of play.
        intervalTicks: 6000,
        fraction: 0.01,

        // WISDOM DECAYS MUCH MORE SLOWLY. Insight is meant to carry across lives
        // (config.ripening.wisdomRate), and a 1%/5min passive drain would erode the
        // one stat designed to persist. This multiplies the fraction above for
        // wisdom only: 0.01 * 0.1 = 0.1% per 5 minutes.
        wisdomFactionMultiplier: 0.1,

        // Values at or below this are rounded away, so stats actually reach zero
        // instead of trailing infinitesimals forever. On the 0..10 scale this is
        // one statGrain step.
        floor: 0.05,
    },

    // ---- Victim classification overrides ------------------------------------
    // isMonster() maps to vanilla's Monster/Enemy type, which puts several mobs on the
    // wrong side of the line for this mod. These lists are checked BEFORE it.

    // Treated as villager-class: the heaviest kill in the game. These are beings a
    // player trades and lives alongside.
    villagerLikeEntities: [
        'minecraft:villager',
        'minecraft:wandering_trader',
        'minecraft:iron_golem', // the village's guardian; killing one is a betrayal
    ],

    // Treated as hostile regardless of vanilla's type hierarchy.
    hostileEntities: [
        // Hoglins are Animals in vanilla, so isMonster() is false -- but they attack
        // on sight and are a normal Nether food source. Charging the passive rate for
        // them punished ordinary survival.
        'minecraft:hoglin',
        'minecraft:zoglin',
        // Slimes and magma cubes are Mob + Enemy, not Monster, in some mappings.
        'minecraft:slime',
        'minecraft:magma_cube',
        // Bosses. Not Monster in every mapping, and plainly not passive.
        'minecraft:ender_dragon',
        'minecraft:wither',
        'minecraft:phantom',
        'minecraft:shulker',
    ],

    // ---- Karma anti-farm ----------------------------------------------------
    // Merit has to be hard to manufacture, and harm has to be hard to launder, or
    // routing means nothing. These guard the award hooks against repetition.
    karmaAntiFarm: {
        // Replanting the same block position does not pay again inside this window.
        // 24000 ticks = 20 real minutes, comfortably longer than a crop takes to
        // grow, so genuine farming still earns while break-replace spam does not.
        plantPositionTicks: 24000,

        // Cap on remembered plant positions per player before pruning. Keeps the
        // in-memory map bounded over a long session.
        plantMemoryMax: 512,

        // Hitting the same mob repeatedly pays hatred once per this window.
        // 1200 ticks = 1 real minute. Without it, hurtPassive would charge per swing
        // and a single cow could cap hatred.
        hurtEntityTicks: 1200,

        // Feeding the same animal pays metta once per this window. 6000 = 5 min.
        // Breeding already pays separately via breedAnimal, so without this a stack
        // of wheat would be a merit vending machine.
        feedEntityTicks: 6000,

        // Cap on remembered entities for the two guards above, per player.
        entityMemoryMax: 256,

        // Opening the same container pays greed once per this window.
        // 24000 ticks = 20 min. Re-opening a chest you are actively looting should
        // not charge per click.
        containerPositionTicks: 24000,
    },

    // ---- Which blocks count as "planting a crop" ----------------------------
    cropBlocks: [
        'minecraft:wheat',
        'minecraft:carrots',
        'minecraft:potatoes',
        'minecraft:beetroots',
        'minecraft:nether_wart',
        'minecraft:melon_stem',
        'minecraft:pumpkin_stem',
        'minecraft:torchflower_crop',
        'minecraft:pitcher_crop',
        'minecraft:cocoa',
    ],

    // ---- Villager infrastructure (greed: breakVillagerBlock) ----------------
    // Breaking one of these within `villagerBlockRadius` of a living villager reads
    // as taking from the village. Matched by exact id.
    villagerBlocks: [
        'minecraft:composter', // farmer
        'minecraft:smithing_table', // toolsmith
        'minecraft:grindstone', // weaponsmith
        'minecraft:blast_furnace', // armorer
        'minecraft:smoker', // butcher
        'minecraft:cauldron', // leatherworker
        'minecraft:brewing_stand', // cleric
        'minecraft:cartography_table', // cartographer
        'minecraft:fletching_table', // fletcher
        'minecraft:loom', // shepherd
        'minecraft:barrel', // fisherman
        'minecraft:lectern', // librarian
        'minecraft:stonecutter', // mason
        'minecraft:bell', // the village's heart
    ],

    // How close a villager must be for the block to count as theirs.
    villagerBlockRadius: 12,

    // ---- Food items that count as feeding an animal (metta) -----------------
    // Matched by suffix so modded variants are caught. Checked against the held
    // item id in ItemEvents.entityInteracted.
    animalFoodSuffixes: [
        'wheat',
        'wheat_seeds',
        'carrot',
        'potato',
        'beetroot',
        'beetroot_seeds',
        'melon_seeds',
        'pumpkin_seeds',
        'hay_block',
        'apple',
        'golden_apple',
        'golden_carrot',
        'bamboo',
        'sugar_cane',
        'cookie', // parrots
        'seagrass', // turtles
        'kelp',
        'sweet_berries',
        'glow_berries',
        'cactus',
        'bread',
        'beef',
        'porkchop',
        'chicken',
        'mutton',
        'rabbit',
        'cod',
        'salmon',
        'tropical_fish',
    ],

    // ---- Realm spawn points -------------------------------------------------
    // Rebirth means losing your place in the world, so a player is always reborn at
    // their realm's spawn -- NOT where they died. Anchoring on the corpse made a
    // same-realm death indistinguishable from a vanilla respawn.
    //
    // EVERY realm needs explicit coordinates. KubeJS 6 exposes no world-spawn
    // accessor at all -- verified by scanning the whole jar: nothing matches
    // sharedSpawn/spawnPos, and `spawnLocation` exists only on ServerPlayer (the
    // player's own bed), not on a level. Leaving `human` as null fell through to
    // origin and the search dug to bedrock, landing players at y=-6.
    //
    // The `y` value is where the safe-spawn search STARTS, not where the player
    // necessarily lands -- the search walks from there to find solid ground with
    // headroom, so it only needs to be in the right band for that realm's terrain.
    // Each y below is the height where that realm's density function actually crosses
    // zero -- i.e. where its ground really is. Computed from the y_clamped_gradient in
    // each worldgen/noise_settings JSON, then checked against where players actually
    // landed in game on 2026-10-18:
    //
    //   realm   gradient         density=0   observed landing
    //   asura   y -64..96        y~34        25
    //   preta   y 0..12          y~11         9
    //   naraka  y 0..24          y~18        18
    //   deva    y 72..100        y~94       138   (noise lifts the islands well above)
    //   brahma  y 120..148       y~146      161
    realmSpawns: {
        // Overworld surface at origin measured 68 in the current test world; 72 keeps
        // the window centred over ordinary terrain without assuming that exact value.
        human: { x: 0, y: 72, z: 0 },
        animal: { x: 0, y: 72, z: 0 }, // shares the human world
        naraka: { x: 0, y: 18, z: 0 }, // cavern floor
        preta: { x: 0, y: 11, z: 0 }, // shallow caves under a ceiling
        asura: { x: 0, y: 34, z: 0 }, // plateaus
        deva: { x: 0, y: 136, z: 0 }, // floating islands (noise sits above the crossing)
        // Sparse platforms. 150, not 156: brahma's lower gradient peaks at y=148 and
        // its upper gradient starts subtracting at y=160, so the densest band is
        // ~148-160 and 156 sat in the top third where density is already falling off.
        // Altitude was not what made brahma miss pass 1 (the +/-48 window covers
        // 108-204 either way) -- that was purely horizontal sparseness, fixed by
        // searchRadiusFor. This just centres the window on the good band.
        brahma: { x: 0, y: 150, z: 0 },
    },

    // ---- Which realms have no sky -------------------------------------------
    // A roofed or sunless realm cannot satisfy the open-sky surface test, so the
    // search skips it there and scans BOTTOM-UP instead (scanning down in a cavern
    // lands the player on the ceiling).
    //
    // Keyed by REALM, not by dimension id: a third-party override dimension then
    // inherits the right behaviour automatically. Matches has_skylight:false /
    // has_ceiling:true in each dimension_type JSON.
    cavernRealms: ['naraka', 'preta'],

    // Full height range to search per realm.
    //
    // These MUST match each dimension_type's min_y / (min_y + height), or the search
    // wastes its budget scanning y values that cannot contain blocks -- and in the
    // worst case never reaches the band where terrain actually is.
    //
    // Verified against kubejs/data/samsara/dimension_type/*.json:
    //   naraka  min_y 0,   height 128  -> 0..128
    //   preta   min_y 0,   height 128  -> 0..128
    //   asura   min_y -64, height 320  -> -64..256
    //   deva    min_y 0,   height 256  -> 0..256
    //   brahma  min_y 0,   height 256  -> 0..256
    //   overworld (human/animal)       -> -64..320
    realmScanBounds: {
        naraka: { min: 1, max: 127 },
        preta: { min: 1, max: 127 },
        asura: { min: -63, max: 255 },
        deva: { min: 1, max: 255 },
        brahma: { min: 1, max: 255 },
        human: { min: -63, max: 319 },
        animal: { min: -63, max: 319 },
        default: { min: -63, max: 319 },
    },

    // ---- Safe-spawn search tuning -------------------------------------------
    safeSpawn: {
        // How far out to spiral, in blocks. 6 = up to 169 columns.
        searchRadius: 6,

        // Per-realm override of searchRadius, because the realms differ enormously in
        // how much of their horizontal area is solid at all.
        //
        // This is driven by each realm's own final_density in
        // kubejs/data/samsara/worldgen/noise_settings/<realm>.json. Solid ground
        // exists where (y_clamped_gradient + continentalness * amplitude) > 0, so the
        // gradient's PEAK against the noise amplitude says what fraction of columns
        // can hold terrain:
        //
        //   brahma  peak +0.15 vs +/-1.1  -> needs noise > -0.14: a MINORITY of
        //                                    columns. Sparse platforms, by design.
        //   deva    peak +0.5  vs +/-1.2  -> needs noise > -0.42: most columns.
        //   asura   dense below ~y=60                 -> ordinary terrain.
        //   human/animal                              -> vanilla overworld.
        //   naraka/preta  cavern, solid by default    -> ordinary.
        //
        // Observed: brahma resolved through 'widened+-64,0' (pass 4) rather than pass
        // 1, i.e. there was no platform within 6 blocks of 0,0 and the search only
        // succeeded via the fallback meant for a built-over spawn. Pass 4 takes
        // whatever altitude it finds, so a realm that is sparse BY DESIGN must widen
        // pass 1 instead of leaning on pass 4.
        searchRadiusFor: {
            brahma: 24, // 49x49 columns; at this density a platform is near-certain
            deva: 16, // denser than brahma but still islands
            default: 6,
        },

        // Extra ORIGINS for pass 1, per realm, tried in order. Pass 1 keeps the
        // realm's altitude band and the open-sky requirement at every one of them.
        //
        // This exists because brahma's terrain is placed by
        // minecraft:continentalness, which is SEEDED: which columns hold a platform
        // changes with every new world. A radius-24 sweep around 0,0 still found
        // nothing in the test world, so brahma fell through to pass 4, which works
        // but abandons both the sky gate and the altitude band.
        //
        // The fix must not be a hardcoded offset -- x=-64 happened to work on one
        // seed and would mis-site the realm on the next. Several origins at the right
        // altitude is seed-independent.
        //
        // Offsets are deliberately modest (<=128) and FIXED, never random: the old
        // scatter-search picked random origins within +/-256 and could force chunk
        // GENERATION on the server thread.
        //
        // Realms absent here use [[0,0]] -- exactly the old single-spiral behaviour,
        // so this costs the five ordinary realms nothing.
        originOffsets: {
            brahma: [
                [0, 0],
                [-64, 0],
                [64, 0],
                [0, 64],
                [0, -64],
                [-128, 0],
                [128, 0],
            ],
            deva: [
                [0, 0],
                [-64, 0],
                [64, 0],
                [0, 64],
            ],
        },

        // Pass 1 searches realmSpawns.y +/- this window. The realm's terrain band is
        // designed around that height, so this nearly always hits -- and hits at the
        // right altitude rather than at whatever surface the full-range scan reaches
        // first.
        anchorWindow: 48,

        // Hard cap on block reads for ONE PASS of the search. Each pass gets its own
        // fresh allowance.
        //
        // This was previously shared across all passes and never reset, which broke
        // rebirth outright: a full pass-1 sweep costs ~49k of 60k, so passes 2 and 3
        // ran with a drained counter, returned null instantly, and the player was
        // dumped into the human realm. Per-pass is also the right meaning -- the cap
        // exists to stop one runaway scan, not to ration the whole resolution.
        //
        // This is the budget for the DEFAULT radius of 6 (169 columns). It is scaled
        // by column count for a wider radius -- see readBudgetPerColumn. A flat cap
        // plus a per-realm radius would reintroduce the drained-counter bug in a new
        // place: brahma at radius 24 is 2401 columns, and a full 97-block window over
        // those costs ~700k reads, so a flat 60k would make pass 1 die partway
        // through every time and brahma would be WORSE than before the widening.
        readBudget: 60000,

        // Reads allowed per column scanned, used to scale the budget when a realm
        // overrides searchRadius.
        //
        // 60000 / 169 columns = ~355, which is the default radius's effective
        // allowance per column -- so this preserves today's behaviour exactly at
        // radius 6 while letting a wider radius get a proportionally bigger budget.
        // A full 383-block overworld column costs 383*3 = ~1150 reads, so ~355 does
        // NOT fund scanning every column to its full depth; that is intentional and
        // already true today. The budget is a runaway stop, not an entitlement, and
        // the spiral checks the nearest columns first.
        readBudgetPerColumn: 355,

        // Absolute ceiling on one pass's budget, whatever the radius works out to.
        readBudgetMax: 1200000,

        // Ceiling on the reads for the WHOLE resolution, across every pass.
        //
        // The per-pass budget alone is not enough. A total failure runs all ten
        // passes (1, 2, 3, six wide offsets, last resort), so brahma's 852k per-pass
        // allowance multiplied out to ~8.5M reads -- WORSE than the ~5.3M that this
        // file's header says the original rewrite existed to eliminate, and measured
        // at 3.4 seconds in the harness. That is 68 ticks of a frozen server on the
        // one path a player cannot avoid: dying.
        //
        // Per-pass and total are both needed, and they mean different things:
        //   per-pass  stops ONE scan from running away, and must be large enough to
        //             fund a full sweep at that realm's radius or the pass dies
        //             partway and falls through for no reason;
        //   total     stops the SEQUENCE from running away when everything misses.
        //
        // 1.3M, and every digit of it is a constraint rather than a guess.
        //
        // The allocation gives each of the ten passes a floor of minPassBudget and
        // hands pass 1 the surplus. Two requirements fix the number:
        //
        //   * pass 1 must afford brahma's FULL radius-24 sweep (2401 columns x a
        //     97-block window x 3 reads = ~699k), or the wide radius is pointless;
        //   * the nine fallback passes must each keep 60k -- the per-pass budget that
        //     was already proven adequate for every realm before any of this.
        //
        // 9 x 60k = 540k held back, leaving pass 1 760k. At 1.2M pass 1 gets only
        // 660k and its sweep dies at ~ring 22; at 1.3M it completes.
        //
        // This replaces a 1M total plus a single lastResortReserve, which failed in
        // game: pass 1 took 800k of the 1M, leaving passes 2, 3 and ALL SIX wide
        // offsets with zero reads, and `/samsaraspawn brahma` went from
        // 'widened+-64,0' to NO SAFE SPOT FOUND. Reserving for one pass is not
        // enough -- every pass needs a floor.
        //
        // On timing: the harness cannot predict the in-game cost (its getBlock
        // allocates an object per call, ~465ms per 1.5M reads of pure overhead), so
        // what is claimed here is only the bound and the direction: worst case 1.3M
        // reads, against ~8.5M before any ceiling existed and the ~5.3M this file's
        // header says the original rewrite set out to eliminate.
        //
        // If a rebirth ever visibly stutters, lower this AND searchRadiusFor.brahma
        // together -- they are coupled, and lowering the total alone silently starves
        // pass 1 back down to a narrow spiral.
        totalReadBudget: 1300000,

        // Floor guaranteed to EVERY pass, so no pass can be starved to zero by an
        // earlier one. 60000 is the per-pass budget that predated the per-realm
        // radius work and was adequate for all seven realms.
        minPassBudget: 60000,

        // Pass 4 origins, tried in order when the whole neighbourhood around the
        // anchor is obstructed (e.g. a player has built over the world spawn).
        // Fixed and modest on purpose: the old version picked 8 RANDOM origins within
        // +/-256, which could force chunk generation on the server thread.
        wideOffsets: [
            [64, 0],
            [-64, 0],
            [0, 64],
            [0, -64],
            [128, 128],
            [-128, -128],
        ],

        // Used only when every pass fails and we carve a pocket at the anchor rather
        // than move the player to a different realm. Placed only if nothing solid is
        // already under their feet.
        fallbackFloorBlock: 'minecraft:stone',

        // The lowest Y a SURFACE realm's rebirth may use while a better option might
        // still exist. Cavern realms (cavernRealms) are exempt -- their whole terrain
        // is below these numbers by design.
        //
        // Why this exists: pass 3 drops the open-sky requirement, and it used to scan
        // the full range TOP-DOWN, so it descended past every ceiling and took the
        // first cave pocket it met. In a dug-out test world that put a human rebirth
        // at y=-3 and y=-2 -- technically valid (clear feet, clear head, solid floor)
        // and completely wrong. A cave at bedrock is worse than an imperfect spot near
        // the surface.
        //
        // Enforced as a PREFERENCE, not a hard gate: the sub-floor scan still runs as
        // the last resort before the carved-pocket path, because being underground
        // beats suffocating in rock.
        minSurfaceY: {
            human: 50,
            animal: 50,
            asura: 20,
            deva: 80,
            brahma: 100,
            default: 50,
        },

        // Clear blocks required ABOVE the player's head for a spot to count as "the
        // surface" on the no-sky passes. This is what distinguishes a surface under an
        // overhang or a player's roof from a cave floor, without relying on
        // getCanSeeSky. 6 rejects natural cave ceilings; much higher would reject
        // legitimate spots under built structures.
        surfaceHeadroom: 6,

        // How long a verified spawn spot stays cached, in ticks. 20 min. Rebirth
        // always lands at the realm spawn, so re-scanning per death is pure waste;
        // the cached spot is re-validated before every reuse.
        cacheTicks: 24000,
    },

    // ---- Debug toggles ------------------------------------------------------
    // Log every exit path of the preta food hook, one line per bite. On because the
    // penalty is still being verified in game: every path through that hook is a
    // silent return, and the previous version failed COMPLETELY while leaving no
    // trace in the log at all. Turn off once it is confirmed working.
    debugFood: true,

    // Log the full NBT of a tame candidate that did not resolve. Off by default:
    // taming is probabilistic, so this fires on every failed bone throw and the
    // dump is ~300 chars a line. Turn on only when investigating taming.
    debugTameChecks: false,

    // ---- Toggles ------------------------------------------------------------
    // Breeding has no dedicated event in KubeJS 6, so we approximate it by
    // rewarding whenever a baby animal spawns. This also fires for babies from
    // spawn eggs / natural spawns. Set false to disable until a cleaner hook exists.
    breedingProxyEnabled: true,

    // ---- NBT keys -----------------------------------------------------------
    // Stored inside the Forge PlayerPersisted tag (survives death + relog).
    nbt: {
        statPrefix: 'samsara_', // e.g. samsara_hatred
        birthRealm: 'samsara_birth_realm',

        // Migration bookkeeping.
        legacyKarma: 'samsara_karma', // pre-six-stat scalar; migrated then cleared
        migrated: 'samsara_migrated', // v1: scalar -> six stats
        migratedV2: 'samsara_migrated_v2', // v2: rename + rescale to 0..statCap

        // Old six-stat key names, read once by the v2 migration then zeroed.
        // virtue -> metta, meditation -> wisdom.
        legacyVirtue: 'samsara_virtue',
        legacyMeditation: 'samsara_meditation',

        // Where the player died -- the rebirth search anchors here, because by
        // respawn time player.x/y/z already describe the NEW position.
        deathX: 'samsara_death_x',
        deathY: 'samsara_death_y',
        deathZ: 'samsara_death_z',
        deathPosSet: 'samsara_death_set',

        // Ripening / death bookkeeping.
        lastDeathTick: 'samsara_last_death_tick',
        deathStreak: 'samsara_death_streak',
        everDied: 'samsara_ever_died',

        // Liberation: set once the player passes the check. Skips rebirth entirely.
        liberated: 'samsara_liberated',

        // Testing override: when set to a realm name, rebirth routing skips the
        // karma comparison entirely and sends the player there. Cleared with
        // `/karma forcerealm <player> none`.
        forcedRealm: 'samsara_forced_realm',
    },
}

console.info('[Samsara] config loaded')

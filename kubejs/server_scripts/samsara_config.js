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
    // ---- Scale (units, redesigned 2026-10-19) ------------------------------
    // ONE UNIT = striking an animal once: the smallest unwholesome act. Every value
    // below is a multiple of that, so the table reads as "how many small wrongs is
    // this worth".
    //
    // Stats are stored EXACTLY. There is no grain and no cap at 10 any more:
    //   - The old 0.05 grain rounded any change under 0.025 away. That silently killed
    //     passive decay and would have eaten any proportional mechanic after it.
    //   - The old cap at 10 made the eleventh villager murder free, and made ten
    //     murders look the same as a hundred. Dhp 121-122: "drop by drop is the water
    //     pot filled" -- of evil and of good alike. Every deed counts.
    // Routing reads SHARES, so the absolute scale does not decide realms; the
    // thresholds in config.routing (minTotal, lowerMinPoison) are what do.
    //
    // statCap is only an OVERFLOW ceiling, far above anything play reaches.
    statCap: 10000,

    // Writes are rounded to this, purely to strip float noise (0.1 + 0.2 =
    // 0.30000000000000004) so a stat cannot sit at 59.9999999 under a threshold of
    // 60. It is a million times finer than the smallest award, so unlike the old
    // grain it can never swallow a real change.
    storePrecision: 0.000001,

    // ---- Karma point values (units) ----------------------------------------
    // Each entry says: this act adds this much to this stat. Values are additive
    // and positive -- a "bad" act grows a poison, it does not shrink an antidote.
    //
    // ANTIDOTES ARE WORTH LESS PER ACT, and have fewer sources. Dhp 163: "Easy to do
    // are things that are bad and harmful to oneself. But exceedingly difficult to do
    // are things that are good and beneficial."
    karma: {
        // --- Hatred: harming living things ---
        // A HOSTILE kill is the full rate here, then falls off within a life per
        // hostileKillTiers below, and is tracked as COMBAT hatred (see that block).
        killHostile: 1,
        hurtPassive: 1, // struck a peaceful being and left it alive: THE unit
        killPassive: 3, // animals and other peaceful mobs
        killBaby: 5, // a baby animal
        killTamed: 10, // a tamed or named animal: betrayal of a bond
        // Villager-class: the gravest act in the game. Killing a human being is the
        // heaviest kind of killing in both the suttas and the Vinaya (a defeat-offence,
        // where killing an animal is a lesser one), so it is ~8x a passive kill.
        killVillager: 25,

        // --- Greed: taking what was not given ---
        // Only from an OWNER: a village container, or one another player placed.
        // Dungeon and structure loot belongs to no one -- taking what is not given
        // needs someone who did not give it. See PlayerEvents.chestOpened.
        lootContainer: 1,
        breakVillagerBlock: 3, // destroyed a villager workstation or bed

        // --- Delusion: heedlessness (moha) ---
        // Deaths are the ONLY delusion source today. For ordinary carelessness each
        // death also ripens 20% of everything, so delusion plateaus around 12 and
        // never reaches lowerMinPoison. BUT RAPID DEATH-SPAM IS UNBOUNDED: each
        // repeatDeath adds 5 while the ripening falloff shrinks toward 0, and in game
        // (2026-10-19) ~20 deaths in a minute routed to animal. Open decision -- see
        // HANDOFF section 4. Planned non-death source: intoxicants (the fifth
        // precept; heedlessness, Dhp 21), added by this mod later.
        carelessDeath: 2, // died with nobody to blame -- fall, lava, drowning
        repeatDeath: 5, // died again inside the rapid-death window

        // --- Generosity (dana) ---
        // Feeding an animal is GIVING. AN 3.57: even throwing the rinsings of a bowl
        // into a pool for the creatures there "would be a source of merit". Rate
        // limited per player (karmaAntiFarm.feedPerPlayer*), or a pen is a vending
        // machine.
        feedAnimal: 0.5,

        // --- Metta: non-hatred (adosa) ---
        // Metta comes from two sources only: meditation (phase 6, not built) and
        // NON-RETALIATION -- taking real harm from a hostile and not striking back,
        // whether by getting away or by letting it kill you. MN 21, the simile of the
        // saw: "even if bandits were to carve you up savagely, limb by limb, with a
        // two-handled saw, he among you who let his heart get angered even at that
        // would not be doing my bidding." See config.endurance and samsara_karma.js.
        //
        // RETIRED: plantCrop, tameAnimal (metta) and breedAnimal (generosity).
        // Planting for yourself is not goodwill toward a being, taming is acquiring a
        // pet, and breeding is husbandry, not giving -- and its proxy paid for any
        // baby that spawned near anyone. Retired 2026-10-19; the code is in git
        // history (the first commit) if any of them comes back.
        enduredEncounter: 2,

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
    // NOTE: metta is non-hatred, earned only by non-retaliation (and later
    // meditation). General ethical conduct -- honest trades, not stealing -- is
    // handled as the ABSENCE of greed rather than as an award.
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

        feedAnimal: 'generosity',

        enduredEncounter: 'metta',
    },

    // ---- Hostile kills: tiered per life, and tracked as COMBAT hatred ---------
    // Each tier pays `value` per kill until the hostile-kill count THIS LIFE reaches
    // `upTo`; past the last tier a hostile kill adds nothing. The counter resets at
    // death (global.SMS.resetLifeCounters). Per-life max here:
    // 10 x 1 + 10 x 0.5 + 10 x 0.25 = 17.5.
    //
    // Doctrine: killing a hostile is REAL killing -- the first precept has no
    // exception for dangerous beings, and fear-driven killing is still rooted in
    // aversion (AN 6.63: intention is kamma). But it is LIGHT: the commentaries grade
    // killing by the victim and the mind behind it, and a being that attacks you,
    // killed under threat, weighs far less than a virtuous one killed in cruelty.
    // And light deeds still add up (Dhp 121). So a life of nothing but combat tips
    // downward EVENTUALLY: dying about once an hour, combat hatred settles near
    // 17.5 / 0.2 = ~70, deliberately clear of lowerMinPoison (60) rather than on it.
    // The harness pins this: a pure fighter falls after several violent lives, and
    // one who also does modest good stays human.
    //
    // COMBAT HATRED (the sub-count samsara_hatred_combat) is the part of hatred that
    // came from hostile kills. It counts toward P and toward naraka like any hatred,
    // but routing IGNORES it when deciding (a) whether hatred leads for ASURA and
    // (b) WHICH lower realm a poison-led life falls to. Otherwise a gentle player who
    // fights zombies read as "merit corrupted by aggression" (asura), and a greedy or
    // careless player's realm depended on when the floor was crossed rather than on
    // the life. If combat hatred is the ONLY poison, it still means hatred -> naraka.
    // Asuras are defined by rivalry and envy, not by fending off attackers.
    hostileKillTiers: [
        { upTo: 10, value: 1 },
        { upTo: 20, value: 0.5 },
        { upTo: 30, value: 0.25 },
    ],

    // ---- Endurance: metta from non-retaliation ------------------------------
    // An ENCOUNTER opens when a hostile mob damages the player, and closes after
    // quietTicks with no further hostile hits, or at the player's death. It pays
    // karma.enduredEncounter (metta) if, by then:
    //   - the player took at least minDamage across it (real harm, not a scratch);
    //   - the player struck NO living thing during it, or in the quietTicks before
    //     it opened (a pre-emptive strike is still violence);
    // and the guards below allow it.
    //
    // What earns it is NOT striking back -- the death itself pays nothing extra. MN 21
    // praises the mind that does not hate under harm, not the dying.
    endurance: {
        enabled: true,

        // Damage summed across the encounter, as reported by the hurt event (before
        // armor). 4.0 = two hearts: about two zombie hits.
        minDamage: 4.0,

        // 200 ticks = 10 s without a hostile hit closes the encounter.
        quietTicks: 200,

        // ---- Anti-farm. Each bounds a different exploit; all are needed. ----

        // Mobs from a spawner (BaseSpawner) never open an encounter. Tagged at spawn
        // via EntityEvents.checkSpawn, whose getSpawner() is null for natural spawns.
        // This is what stops "stand next to a caged spawner".
        ignoreSpawnerMobs: true,

        // At most one award per this window. 6000 = 5 min.
        awardWindowTicks: 6000,

        // AGGREGATE bound: metta from endurance per life never exceeds this (four
        // encounters). Resets at death, so it bounds a life, not the whole save --
        // see blockRapidDeath for what stops dying from becoming the reset button.
        perLifeMax: 8,

        // An encounter that ends in DEATH pays only if the previous death was at
        // least ripening.cooldownTicks ago. Mob deaths add no delusion (there is an
        // attacker), and each death resets perLifeMax, so without this a player could
        // let a zombie kill them every few minutes for unbounded metta. With it, a
        // death farm pays at most once per cooldown and each death ripens 20% of
        // metta, so it converges (to ~8) instead of climbing. Harness-measured.
        blockRapidDeath: true,
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
    //   2. Net < lowerNet AND P >= lowerMinPoison
    //                       -> down; the largest NON-COMBAT poison picks the realm
    //   3. Net >= devaNet AND wisdom share of A < devaWisdomMax -> deva
    //   4. Net >= asuraNet AND non-combat hatred leads P AND its share
    //      >= asuraHatredShare -> asura
    //   5. otherwise        -> human
    routing: {
        // Rule 0. Below this much total karma (A + P), routing always returns human.
        //
        // This is what stops a brand-new player's FIRST kill from deciding their
        // next life. One hostile gives P = 1, A = 0, so Net = 0.0, which is below
        // lowerNet. 20 units = about twenty small acts before a life is judged.
        minTotal: 20,

        // Rule 2. Below this Net, the player falls. 0.40 means poison must outweigh
        // antidote by roughly 3:2 before a lower rebirth happens.
        lowerNet: 0.40,

        // Rule 2 ALSO needs this much poison in absolute terms (P). Shares alone
        // judge a life by its balance the moment minTotal is cleared, so an ordinary
        // player killing a few animals for food fell to naraka inside an hour. This
        // is the weight a life must carry before it tips downward -- AN 3.99's salt
        // crystal: a little evil does not ruin a whole river. Below it, a poison-led
        // life is still human (rules 3/4 cannot match at Net < 0.40).
        //
        // 60 units: about sixty small wrongs, or two villagers and some more.
        // Measured: an ordinary player (fights, kills a few animals for food, feeds a
        // few) first falls at ~4 h -- the agreed target. The harness pins it.
        lowerMinPoison: 60,

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

        // Values at or below this after ripening are zeroed, so stats actually reach
        // 0 instead of trailing fractions forever. Half a unit.
        floor: 0.5,
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

    // No third-party dimensions. The Aether / Undergarden overrides and the Twilight
    // Forest "lowest heaven" tier were removed 2026-10-19 along with those mods:
    // Samsara uses only the dimensions above. The lowest heaven moves into the
    // Overworld as presences (design doc 7.6).

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

    // ---- Passive karma decay: RETIRED 2026-10-19 ----------------------------
    // There is no passive decay. Karma falls only by ripening at rebirth, and is
    // diluted by antidotes (routing works on shares).
    //
    // Doctrine: Dhp 71 -- "an evil deed committed does not immediately bear fruit,
    // like milk that does not turn sour all at once; but smoldering, it follows the
    // fool like fire covered by ashes." AN 3.99 (the salt crystal) says what weakens
    // a bad deed's result is the person's DEVELOPMENT, not time.
    //
    // It was also broken and dangerous. Broken: 1% of any stat at or under 2.5 is
    // under half a grain, so quantisation rounded it straight back -- every stat
    // froze at 2.5, and wisdom (0.1%) never moved at all. Dangerous: fixing that
    // naively let wisdom's share rise while the player idled, and a measured AFK
    // player reached liberation in 11 hours. Do not reintroduce it without a test
    // that measures both.

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
        // Cap on remembered container positions per player before pruning. Keeps the
        // in-memory map bounded over a long session.
        containerMemoryMax: 512,

        // Feeding pays at most feedPerPlayerMax times per feedPerPlayerWindowTicks,
        // across ALL animals. The per-animal window below alone let a pen of twenty
        // animals pay every five minutes -- 120 units an hour. With this, the most
        // feeding can ever earn is 4 x 0.5 per 20 min = 6 units an hour.
        feedPerPlayerMax: 4,
        feedPerPlayerWindowTicks: 24000,

        // Hitting the same mob repeatedly pays hatred once per this window.
        // 1200 ticks = 1 real minute. Without it, hurtPassive would charge per swing
        // and a single cow could cap hatred.
        hurtEntityTicks: 1200,

        // Feeding the same animal pays generosity once per this window. 6000 = 5 min.
        // Without it a stack of wheat would be a merit vending machine.
        feedEntityTicks: 6000,

        // Cap on remembered entities for the two guards above, per player.
        entityMemoryMax: 256,

        // Opening the same container pays greed once per this window.
        // 24000 ticks = 20 min. Re-opening a chest you are actively looting should
        // not charge per click.
        containerPositionTicks: 24000,
    },

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

    // Log every endurance encounter as it opens, spoils and closes. On while the
    // mechanic is unverified in game: like the food hook, every path through it is a
    // silent return otherwise. Turn off once confirmed.
    debugEndurance: true,

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

        // Per-LIFE counters, zeroed at death by global.SMS.resetLifeCounters.
        lifeHostileKills: 'samsara_life_hostile_kills', // drives hostileKillTiers
        lifeEndured: 'samsara_life_endured', // metta paid by endurance this life

        // The part of hatred that came from hostile kills (see hostileKillTiers).
        // Kept <= hatred: ripening scales it with hatred, and reads clamp it.
        hatredCombat: 'samsara_hatred_combat',

        // v3: the 0..10 / 0.05-grain scale -> exact units (x10).
        migratedV3: 'samsara_migrated_v3',

        // Liberation: set once the player passes the check. Skips rebirth entirely.
        liberated: 'samsara_liberated',

        // Testing override: when set to a realm name, rebirth routing skips the
        // karma comparison entirely and sends the player there. Cleared with
        // `/karma forcerealm <player> none`.
        forcedRealm: 'samsara_forced_realm',
    },
}

console.info('[Samsara] config loaded')

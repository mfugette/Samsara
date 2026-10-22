// priority: 40
// Samsara — rebirth: on death, route the player to the realm their karma dictates and
// land them somewhere survivable.
//
// PRIORITY 40, the lowest of the gameplay files: on a player death, route + ripen
// must run LAST, after samsara_karma.js (50) has added this death's delusion and
// settled endurance -- both read the PREVIOUS death that ripening overwrites. And
// samsara_realms.js (60) must register its respawn safety net before this file's
// respawn handler. KubeJS 7 orders files by `// priority: N` (higher first), then path.
//
// REWRITTEN. The previous version had grown four layers of patches over a search that
// could cost ~5.3M block reads per death and could bake a stone platform into the
// world that then became that dimension's permanent (and wrong) spawn.
//
// The search is now built around three facts established against the jar and in game:
//
//   1. There was NO heightmap and NO collision API in KubeJS 6, so "is this solid
//      ground" is a block-id deny-list judgement and "is this the surface" is
//      getCanSeeSky. KubeJS 7's LevelBlock still has no collision API; vanilla
//      blockState methods are callable on 1.21.1, but the id predicates stay -- they
//      are what the harness models and what the in-game tests verified.
//   2. getCanSeeSky is the ONLY reliable surface test available, so for a realm with a
//      sky it is a HARD gate, never a preference that gets relaxed. Relaxing it is
//      what put a human rebirth at y=-19, inside a cave.
//   3. A scan must be bounded. The old code scanned 169 columns x 360 y x 4 reads,
//      three times over, plus 8 scattered retries at +/-256 blocks (which force chunk
//      GENERATION on the server thread). Everything here is capped and budgeted.
//
// See HANDOFF.md section 6 for the history this replaces.

global.SMS = global.SMS || {}

// ---- What counts as ground, clear space, and danger -------------------------

// Blocks that are solid but must never be stood on or in.
const DEADLY = [
    'minecraft:lava',
    'minecraft:fire',
    'minecraft:soul_fire',
    'minecraft:magma_block',
    'minecraft:campfire',
    'minecraft:soul_campfire',
    'minecraft:cactus',
    'minecraft:sweet_berry_bush',
    'minecraft:wither_rose',
    'minecraft:powder_snow',
    'minecraft:water', // would drown a player who spawns submerged
]

// Non-solid blocks that read as "not air" but cannot be stood on. There is no
// collision API, so this is a deny-list. Suffix rules below catch the families.
const NOT_GROUND = [
    'minecraft:air',
    'minecraft:cave_air',
    'minecraft:void_air',
    'minecraft:structure_void',
    'minecraft:light',
    'minecraft:barrier',
    'minecraft:torch',
    'minecraft:wall_torch',
    'minecraft:soul_torch',
    'minecraft:redstone_torch',
    'minecraft:tall_grass',
    'minecraft:grass',
    'minecraft:short_grass',
    'minecraft:fern',
    'minecraft:large_fern',
    'minecraft:dead_bush',
    'minecraft:vine',
    'minecraft:snow',
    'minecraft:rail',
    'minecraft:powered_rail',
    'minecraft:detector_rail',
    'minecraft:activator_rail',
    'minecraft:ladder',
    'minecraft:lever',
    'minecraft:tripwire',
    'minecraft:tripwire_hook',
    'minecraft:scaffolding',
    'minecraft:cobweb',
    'minecraft:lily_pad',
    'minecraft:kelp',
    'minecraft:seagrass',
    'minecraft:water',
    'minecraft:lava',
    'minecraft:bubble_column',
]

// Families that are never a floor. Checked by suffix so modded variants are caught.
const NOT_GROUND_SUFFIX = [
    '_sapling',
    '_carpet',
    '_banner',
    '_sign',
    '_pressure_plate',
    '_button',
    '_candle',
    '_flower',
    '_mushroom',
    '_coral',
    '_coral_fan',
    '_sprouts',
    '_roots',
    '_bud',
    '_pane',
]

// Read a block id as a plain JS string, or '' if unreadable.
function idOf(block) {
    try {
        return '' + block.id
    } catch (ignored) {
        return ''
    }
}

// Write a block by id. LevelBlock.set takes a Block; whether KubeJS 7 coerces a
// registry-id STRING into one is unverified, so try the string first and fall back
// to an explicit Block.getBlock lookup. Only the carved-pocket fallback writes blocks.
function setBlockId(block, id) {
    try {
        block.set(id)
        return
    } catch (ignored) {
        // no string coercion: resolve the Block ourselves
    }
    block.set(Block.getBlock(id))
}

// Best-effort chunk load. KubeJS 6 had LevelBlock.getChunk(); KubeJS 7 does not (it
// threw inside a try and silently did nothing), so call vanilla Level.getChunk(cx, cz),
// which loads or generates the chunk. The block reads of the search would fault it in
// anyway; this keeps the intent explicit.
function loadChunkAt(level, bx, bz) {
    try {
        level.getChunk(bx >> 4, bz >> 4)
    } catch (ignored) {
        // the block reads below fault it in anyway
    }
}

// Is this block empty space the body can occupy?
//
// Uses the block ID, NOT blockState.isAir(). On 1.20.1 isAir() was an SRG-named call
// unreachable from script -- it threw, every predicate's catch returned "unsafe", and
// the entire search failed into the platform fallback. It is callable on 1.21.1, but
// the id test is kept: same verdicts, and it is what the harness models.
function isClear(block) {
    var id = idOf(block)
    if (id === '') return false
    return id === 'minecraft:air' || id === 'minecraft:cave_air' || id === 'minecraft:void_air'
}

// Is this block dangerous to stand on or in?
function isDeadly(block) {
    var id = idOf(block)
    if (id === '') return true // unreadable: assume the worst
    return DEADLY.indexOf(id) !== -1
}

// Is this solid, harmless ground?
function isGround(block) {
    var id = idOf(block)
    if (id === '') return false
    if (isClear(block)) return false
    if (isDeadly(block)) return false
    if (NOT_GROUND.indexOf(id) !== -1) return false
    for (var i = 0; i < NOT_GROUND_SUFFIX.length; i++) {
        if (id.endsWith(NOT_GROUND_SUFFIX[i])) return false
    }
    // Leaves are solid enough to stand on but a rebirth on a treetop is a fall risk.
    if (id.endsWith('_leaves')) return false
    return true
}

// Does this spot see the sky? The only surface test available.
//
// Returns a tri-state: true / false / null when the accessor is unavailable, so the
// caller can decide. Never defaults to `true` -- defaulting to true is what let cave
// spots pass the gate.
function seesSky(block) {
    try {
        var v = block.canSeeSky
        if (v === true) return true
        if (v === false) return false
    } catch (ignored) {
        // fall through to the explicit getter
    }
    try {
        var g = block.getCanSeeSky()
        if (g === true) return true
        if (g === false) return false
    } catch (ignored2) {
        // accessor genuinely missing
    }
    return null
}

// Is (x,y,z) a place a player can be reborn standing up?
// `skyMode`: 'require' (surface realms), 'ignore' (cavern realms).
function isValidStand(level, x, y, z, skyMode) {
    var feet = level.getBlock(x, y, z)
    if (!isClear(feet)) return false
    if (!isClear(level.getBlock(x, y + 1, z))) return false
    if (!isGround(level.getBlock(x, y - 1, z))) return false

    if (skyMode === 'require') {
        var sky = seesSky(feet)
        // null (accessor missing) is treated as a FAILURE for the strict pass. A
        // later pass relaxes it, so a build without the accessor still works, but we
        // never silently accept a cave.
        if (sky !== true) return false
    }
    return true
}

// ---- The column scan -------------------------------------------------------

// Walk one column from yFrom toward yTo looking for a valid standing spot.
//
// `budget` is a mutable {reads, spent} counter so the whole search stays bounded.
// `reads` is this pass's allowance and counts DOWN; `spent` counts UP and is what
// the whole-search ceiling reads. `spent` is normalised here rather than trusted,
// because a caller that passes only {reads:n} would otherwise make it NaN -- and
// NaN fails every comparison silently, which is the Java-long trap (the project notes
// rule 4) reappearing in arithmetic we own.
function scanColumn(level, x, z, yFrom, yTo, skyMode, budget) {
    if (typeof budget.spent !== 'number') budget.spent = 0
    var step = yTo >= yFrom ? 1 : -1
    var y = yFrom
    while (step > 0 ? y <= yTo : y >= yTo) {
        if (budget.reads <= 0) return null
        budget.reads -= 3
        budget.spent += 3
        if (isValidStand(level, x, y, z, skyMode)) return y
        y += step
    }
    return null
}

// Walk a column top-down and return the TOPMOST valid standing spot, i.e. the
// surface, ignoring everything roofed below it.
//
// This is the no-sky surface test. `getCanSeeSky` is the better signal when it is
// available, but when it is unavailable or genuinely false everywhere (a roofed or
// built-over spawn area) the old fallback scanned top-down and took the first valid
// stand -- which is a CAVE, because it keeps descending past each ceiling until
// something happens to fit. Walking down and stopping at the first valid stand is
// correct ONLY if nothing is above it; this adds that condition by requiring a run of
// clear blocks overhead, so an enclosed pocket is rejected without needing sky.
//
// `headroom` is how many clear blocks must sit above the head. 6 is enough to reject
// every natural cave ceiling while still accepting a spot under an overhang or a
// player's roof.
function scanColumnSurface(level, x, z, yTop, yBottom, headroom, budget) {
    if (typeof budget.spent !== 'number') budget.spent = 0
    var y = yTop
    while (y >= yBottom) {
        if (budget.reads <= 0) return null
        budget.reads -= 3
        budget.spent += 3
        if (isValidStand(level, x, y, z, 'ignore')) {
            // Valid footing -- but is it the surface, or a cave floor under rock?
            var open = true
            for (var h = 2; h <= headroom + 1; h++) {
                if (budget.reads <= 0) return null
                budget.reads -= 1
                budget.spent += 1
                if (!isClear(level.getBlock(x, y + h, z))) {
                    open = false
                    break
                }
            }
            if (open) return y
            // Roofed: keep descending. Anything below is deeper, so it is only ever
            // reachable through the sub-floor last resort.
        }
        y -= 1
    }
    return null
}

// Spiral out from (bx,bz) looking for the topmost (surface) standing spot in each
// column. Used for the no-sky passes, where "first valid going down" means a cave.
function spiralSurfaceSearch(level, bx, bz, radius, yTop, yBottom, headroom, budget) {
    for (var ring = 0; ring <= radius; ring++) {
        for (var dx = -ring; dx <= ring; dx++) {
            for (var dz = -ring; dz <= ring; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
                if (budget.reads <= 0) return null
                var y = scanColumnSurface(level, bx + dx, bz + dz, yTop, yBottom, headroom, budget)
                if (y !== null) return { x: bx + dx, y: y, z: bz + dz }
            }
        }
    }
    return null
}

// Spiral out from (bx,bz) over `radius` rings, scanning each column.
// Returns {x,y,z} or null. Honours the shared read budget.
function spiralSearch(level, bx, bz, radius, yFrom, yTo, skyMode, budget) {
    for (var ring = 0; ring <= radius; ring++) {
        for (var dx = -ring; dx <= ring; dx++) {
            for (var dz = -ring; dz <= ring; dz++) {
                // perimeter of this ring only
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
                if (budget.reads <= 0) return null
                var y = scanColumn(level, bx + dx, bz + dz, yFrom, yTo, skyMode, budget)
                if (y !== null) return { x: bx + dx, y: y, z: bz + dz }
            }
        }
    }
    return null
}

// ---- Spawn resolution ------------------------------------------------------

// Resolved spawns are cached per dimension so repeated deaths do not re-scan the
// world. This replaces the old "build a platform and accidentally make it permanent"
// behaviour with an explicit, intentional cache of a spot we VERIFIED is good.
//
// Cleared on /reload (the script re-evaluates) and re-validated before every use, so
// a cached spot that has since been griefed or changed is discarded.
global.SMS.spawnCache = global.SMS.spawnCache || {}

// Find a rebirth spot in `level` for `realm`, or null if genuinely nothing exists.
//
// Strategy, cheapest and most-correct first:
//   Pass 1  anchor band, sky required   -- the configured spawn height +/- a window.
//           This is where the realm's terrain is SUPPOSED to be, so it almost always
//           hits, and it hits at the right altitude.
//   Pass 2  full range, sky required    -- terrain is elsewhere than configured.
//   Pass 3  sky ignored, SURFACE required (topmost stand with clear headroom), and
//           floored at minSurfaceY -- a roofed or built-over spawn, or a build whose
//           getCanSeeSky is unavailable. Only reached when 1 and 2 found nothing.
//   Pass 4  the same surface test at six wide offsets.
//   Pass 5  last resort: anywhere, including deep underground. Named distinctly in
//           the log because reaching it means the anchor's surroundings are bad.
//
// There is deliberately NO scattered re-origin pass and NO platform building: both
// wrote to the world and both made failure permanent.
function findRebirthSpot(level, realm, anchor, dimId) {
    const cfg = global.SMS.config
    const sp = cfg.safeSpawn
    const bounds = cfg.realmScanBounds[realm] || cfg.realmScanBounds.default

    // A roofed or sunless dimension has no sky to find, so requiring one is a bug.
    // Driven by the realm's own declaration, not a dimension-id list, so a
    // third-party override dimension inherits the right behaviour.
    const cavern = cfg.cavernRealms.indexOf(realm) !== -1

    // Clamp the anchor into the realm's legal height range.
    var ay = anchor.y
    if (ay < bounds.min) ay = bounds.min
    if (ay > bounds.max) ay = bounds.max

    const win = sp.anchorWindow
    var spot = null

    // EVERY PASS GETS ITS OWN BUDGET.
    //
    // The budget used to be created once and shared across all three passes, and
    // never reset. A full pass-1 sweep of a 97-block window costs
    // 169 columns x 97 y x 3 reads = 49,179 of the 60,000 allowance, so passes 2 and 3
    // -- which need ~194,000 reads each for the Overworld's 383-block range -- ran
    // with an already-drained counter and returned null INSTANTLY.
    //
    // Effect: whenever pass 1 missed, the realm reported "no survivable spot" and the
    // player was dumped into the human realm at the raw anchor. That is exactly the
    // `0,72,0` landings in the log, and why animal and brahma silently became human.
    //
    // A per-pass budget is also the correct semantics: the cap exists to stop ONE
    // search running away, not to ration the whole resolution.
    // Per-realm search radius. A realm whose terrain is sparse by design (brahma's
    // final_density peaks at only +0.15 against +/-1.1 of noise, so a minority of
    // columns hold any ground at all) needs a wider pass 1 rather than to fall
    // through to pass 4 -- pass 4 is the built-over-spawn fallback and takes whatever
    // altitude it happens to find, instead of the realm's intended band.
    var radius = sp.searchRadius
    if (sp.searchRadiusFor) {
        if (sp.searchRadiusFor[realm] !== undefined) {
            radius = sp.searchRadiusFor[realm]
        } else if (sp.searchRadiusFor.default !== undefined) {
            radius = sp.searchRadiusFor.default
        }
    }

    // The budget MUST scale with the column count, or widening the radius makes
    // things worse rather than better: a flat 60k over brahma's 2401 columns would
    // drain partway through pass 1 every single time, which is the same
    // drained-counter failure that once silently rerouted every realm to human.
    const columns = (2 * radius + 1) * (2 * radius + 1)
    const perCol = sp.readBudgetPerColumn !== undefined ? sp.readBudgetPerColumn : 355
    const budgetMax = sp.readBudgetMax !== undefined ? sp.readBudgetMax : 1200000
    const passBudget = Math.min(budgetMax, Math.max(sp.readBudget, columns * perCol))

    // Per-pass AND total. Both are load-bearing and they are not the same guard:
    //
    //   passBudget   stops one scan running away, and must be big enough to fund a
    //                full sweep at this realm's radius -- too small and the pass dies
    //                partway through and falls to a later pass for no reason.
    //   totalBudget  stops the SEQUENCE running away. Total failure runs all ten
    //                passes, so brahma's 852k per-pass multiplied to ~8.5M reads and
    //                3.4s in the harness -- worse than the ~5.3M this rewrite
    //                replaced, on the one path a player cannot avoid (dying).
    //
    // Each pass still gets a FRESH counter (that part was a real fix and stays), but
    // never more than the whole search has left.
    const totalBudget = sp.totalReadBudget !== undefined ? sp.totalReadBudget : 1500000
    var spentTotal = 0
    var liveBudget = null

    // EVERY pass gets a guaranteed floor, not just the last one.
    //
    // A flat shared pool does not work, and the failure was observed in game: brahma
    // at radius 24 let pass 1 take 800k of the 1,000k total, which left passes 2, 3
    // and ALL SIX wide offsets with exactly zero reads. Only the separately reserved
    // pass 5 could still run. The realm had previously resolved via pass 4
    // ('widened+-64,0'); afterwards `/samsaraspawn brahma` reported NO SAFE SPOT
    // FOUND. A working result became a total failure.
    //
    // The lesson: with a first-come pool, the WIDEST pass starves every pass behind
    // it, and the widest pass is the one most likely to find nothing on a sparse
    // realm. So the allowance must be structural, and it cannot be an EQUAL split
    // either: ten equal shares of 1M gave pass 1 only 100k, which reaches ring 9 of
    // its 24 and so threw away the entire point of the wide radius.
    //
    // Instead every pass gets a guaranteed floor, and pass 1 additionally gets the
    // whole surplus -- it is the pass searching at the realm's intended altitude, so
    // it is where extra reads are worth the most. Later passes keep their floors no
    // matter how much pass 1 used, so none can ever be starved to zero.
    // passCount must count every budget DRAW, not every conceptual pass: pass 1 now
    // draws once per origin, so a realm with 7 origins makes 7 draws there alone.
    // Getting this wrong is how the starvation bug happened -- if passCount
    // understates the draws, the later ones are handed nothing.
    const originCount = (sp.originOffsets && sp.originOffsets[realm])
        ? sp.originOffsets[realm].length
        : 1
    const passCount = originCount + 2 + (sp.wideOffsets ? sp.wideOffsets.length : 6) + 1
    const floorPerPass = sp.minPassBudget !== undefined ? sp.minPassBudget : 60000
    var passIndex = 0

    function freshBudget() {
        // Bank what the previous pass actually used before handing out the next.
        if (liveBudget !== null) spentTotal += liveBudget.spent
        passIndex++

        // Hold back a floor for each pass that has not run yet.
        var passesLeft = passCount - passIndex
        if (passesLeft < 0) passesLeft = 0
        var mustKeep = passesLeft * floorPerPass

        var available = totalBudget - spentTotal - mustKeep
        // Never below this pass's own floor, even if earlier passes overspent.
        if (available < floorPerPass) available = floorPerPass

        // ...but NEVER more than the whole search has actually got left. Without
        // this clamp the floor silently defeats the ceiling: if passCount understates
        // the real number of budget draws (e.g. it forgot that pass 1 draws once per
        // origin), every extra draw still receives its full floor and the search
        // overspends. Measured at 1.66M against a 1.3M ceiling -- a 28% overrun that
        // produced no error and no log line.
        var left = totalBudget - spentTotal
        if (left < 0) left = 0
        if (available > left) available = left
        if (available < 0) available = 0

        liveBudget = { reads: Math.min(passBudget, available), spent: 0 }
        return liveBudget
    }

    // --- Pass 1: the anchor band, at the altitude this realm is designed around.
    // Scanned DOWNWARD from the top of the window for surface realms (land on the
    // first surface at or below the intended height) and UPWARD for caverns (so a
    // ceiling is never mistaken for a floor).
    // Pass 1 may try several ORIGINS, not just the anchor column.
    //
    // Why: brahma's platforms are placed by minecraft:continentalness, which is
    // seeded from the world seed, so WHERE its terrain sits changes with every new
    // world. Even at radius 24 (2401 columns, a full 699k-read sweep) pass 1 found
    // nothing around 0,0 in the test world, and brahma resolved via pass 4
    // ('widened+-64,0') -- which works, but pass 4 drops the sky requirement and the
    // altitude band, so the realm's intended look is not guaranteed.
    //
    // Hardcoding the offset that happened to work (x=-64) would fix exactly one seed
    // and silently mis-site the realm on every other world. Trying a few origins AT
    // THE CORRECT ALTITUDE, with the sky gate still on, is seed-independent: it is
    // the same information pass 4 uses, applied while the altitude discipline is
    // still in force.
    //
    // Costs nothing for the five ordinary realms: their originOffsets list is just
    // [[0,0]], so this is literally the old single spiral.
    var hiTop = Math.min(bounds.max, ay + win)
    var loBot = Math.max(bounds.min, ay - win)

    var origins = (sp.originOffsets && sp.originOffsets[realm]) || [[0, 0]]
    for (var gi = 0; gi < origins.length; gi++) {
        var gx = anchor.x + origins[gi][0]
        var gz = anchor.z + origins[gi][1]
        if (cavern) {
            spot = spiralSearch(level, gx, gz, radius, loBot, hiTop, 'ignore', freshBudget())
        } else {
            spot = spiralSearch(level, gx, gz, radius, hiTop, loBot, 'require', freshBudget())
        }
        if (spot) {
            // Name the origin when it was not the anchor itself, so the log and
            // /samsaraspawn still say exactly where the spot came from.
            var tag = origins[gi][0] === 0 && origins[gi][1] === 0
                ? 'anchor-band'
                : 'anchor-band@' + origins[gi][0] + ',' + origins[gi][1]
            return { spot: spot, pass: tag }
        }
    }

    // --- Pass 2: the realm's whole legal height range, sky rules unchanged.
    if (cavern) {
        spot = spiralSearch(level, anchor.x, anchor.z, radius, bounds.min, bounds.max, 'ignore', freshBudget())
    } else {
        spot = spiralSearch(level, anchor.x, anchor.z, radius, bounds.max, bounds.min, 'require', freshBudget())
    }
    if (spot) return { spot: spot, pass: 'full-range' }

    // --- Pass 3: drop the sky requirement, but still demand the SURFACE.
    // Reached when a surface realm's spawn column is genuinely roofed -- which happens
    // for real: a player who builds over the world spawn roofs the search area, and
    // then NOTHING with open sky exists within the radius. Also covers a build whose
    // getCanSeeSky is unavailable.
    //
    // This used to be a plain top-down spiralSearch with skyMode 'ignore', and that
    // was the y=-3 bug: "first valid stand scanning down" descends past every cave
    // ceiling until a pocket fits, so dropping the sky rule silently became
    // "teleport into the deepest available cave". spiralSurfaceSearch takes the
    // TOPMOST valid stand with clear headroom instead, which is the surface whether
    // or not canSeeSky works.
    //
    // Floored at the realm's minSurfaceY so a surface realm cannot land underground
    // while any above-floor option remains.
    const floorY = (sp.minSurfaceY && (sp.minSurfaceY[realm] !== undefined))
        ? sp.minSurfaceY[realm]
        : (sp.minSurfaceY ? sp.minSurfaceY.default : bounds.min)
    const surfaceFloor = cavern ? bounds.min : Math.max(bounds.min, floorY)
    const headroom = sp.surfaceHeadroom !== undefined ? sp.surfaceHeadroom : 6

    spot = spiralSurfaceSearch(
        level, anchor.x, anchor.z, radius,
        bounds.max, surfaceFloor, headroom, freshBudget()
    )
    if (spot) return { spot: spot, pass: 'no-sky-surface' }

    // --- Pass 4: widen the search area.
    // The spiral only covers +/-6 blocks. If the whole neighbourhood is built over or
    // obstructed, step outward in big jumps and retry the full range with no sky
    // requirement. Reads are bounded per probe, so this stays cheap.
    //
    // This replaces the old random scatter-search, which picked 8 random origins
    // within +/-256 and so could force chunk GENERATION on the server thread. These
    // offsets are fixed and modest, and a realm's spawn should be near its anchor.
    for (var oi = 0; oi < sp.wideOffsets.length; oi++) {
        var off = sp.wideOffsets[oi]
        spot = spiralSurfaceSearch(
            level,
            anchor.x + off[0],
            anchor.z + off[1],
            radius,
            bounds.max,
            surfaceFloor,
            headroom,
            freshBudget()
        )
        if (spot) return { spot: spot, pass: 'widened+' + off[0] + ',' + off[1] }
    }

    // --- Pass 5: last resort -- anywhere at all, including below minSurfaceY.
    //
    // Only reached when no surface spot exists at the anchor OR at any of the six
    // wide offsets. At that point underground beats the alternative, which is the
    // carved-pocket path in pickDestination (a player sealed in a hole in rock).
    // Kept as a SEPARATE pass so the floor above is a real preference rather than a
    // hard gate, and so the log names this case distinctly -- 'deep-last-resort' in a
    // rebirth line means the world around that anchor needs looking at.
    if (!cavern) {
        spot = spiralSearch(
            level, anchor.x, anchor.z, radius,
            bounds.max, bounds.min, 'ignore', freshBudget()
        )
        if (spot) return { spot: spot, pass: 'deep-last-resort' }
    }

    return null
}

// ---- Anchor ----------------------------------------------------------------

// Where to search around. Rebirth means losing your place in the world, so this is
// always the realm's configured spawn -- never the death position, which made a
// same-realm death indistinguishable from a vanilla respawn.
global.SMS.rebirthAnchor = (player, realm) => {
    const cfg = global.SMS.config
    try {
        var c = cfg.realmSpawns ? cfg.realmSpawns[realm] : null
        if (c) return { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }
    } catch (ignored) {
        // fall through
    }
    console.warn(`[Samsara] no realmSpawns entry for '${realm}'; using origin`)
    return { x: 0, y: 64, z: 0 }
}

// ---- Destination -----------------------------------------------------------

// Resolve the full rebirth destination: realm name, dimension, level, and a verified
// safe {x,y,z}. Returns null only if the dimension itself cannot be resolved.
//
// Result is cached per (dimension) for `cacheTicks`, because the realm spawn is a
// fixed point: two deaths in a row should not re-scan the world. The cached spot is
// re-validated before reuse.
global.SMS.pickDestination = player => {
    const cfg = global.SMS.config
    const server = player.server

    const stats = global.SMS.getStats(player)

    // routeFor() handles liberation and returns { realm, rule, liberated }.
    // A liberated player has no rebirth destination at all -- the caller must not
    // teleport them. A forced realm (testing) overrides everything.
    const forced = global.SMS.forcedRealmOf(player)
    var realm, rule
    if (forced) {
        realm = forced
        rule = 'forced (testing override)'
    } else {
        var route = global.SMS.routeFor(player)
        if (route.liberated) {
            return { liberated: true, rule: route.rule, stats: stats }
        }
        realm = route.realm
        rule = route.rule
    }

    const dimId = global.SMS.dimensionForRealm(realm, stats, server)

    var level = null
    try {
        level = server.getLevel(dimId)
    } catch (ignored) {
        level = null
    }
    if (!level) {
        console.warn(`[Samsara] cannot resolve dimension ${dimId} for realm ${realm}`)
        return null
    }

    const anchor = global.SMS.rebirthAnchor(player, realm)

    // Vanilla Nether is 1:8; Samsara's own dimensions are all 1:1.
    var bx = anchor.x
    var bz = anchor.z
    if (dimId === 'minecraft:the_nether') {
        bx = Math.floor(bx / 8)
        bz = Math.floor(bz / 8)
    }
    const searchAnchor = { x: bx, y: anchor.y, z: bz }

    // Force the anchor chunk to load. An unloaded chunk reads as all air, so every
    // column looks empty and the search finds nothing.
    loadChunkAt(level, bx, bz)

    const cavern = cfg.cavernRealms.indexOf(realm) !== -1
    const skyMode = cavern ? 'ignore' : 'require'

    // --- Cache hit? Re-validate before trusting it.
    var cacheKey = realm + '@' + dimId
    var cached = global.SMS.spawnCache[cacheKey]
    if (cached) {
        // `|| 0` because samsara_decay.js owns tickClock and load order between
        // server_scripts files is not guaranteed; an undefined clock must not make
        // this NaN (every comparison against NaN is false, which silently disables
        // the cache -- the same class of bug as the long-reads-as-NaN trap).
        var fresh = (global.SMS.tickClock || 0) - cached.at
        if (fresh >= 0 && fresh < cfg.safeSpawn.cacheTicks) {
            if (isValidStand(level, cached.x, cached.y, cached.z, skyMode)) {
                return {
                    realm: realm,
                    dimId: dimId,
                    level: level,
                    spot: { x: cached.x, y: cached.y, z: cached.z },
                    stats: stats,
                    rule: rule,
                    cached: true,
                }
            }
        }
        // stale or no longer valid
        delete global.SMS.spawnCache[cacheKey]
    }

    const found = findRebirthSpot(level, realm, searchAnchor, dimId)

    if (!found) {
        // Nothing survivable anywhere in the searched volume.
        //
        // THE REALM DOES NOT CHANGE. This used to fall back to the human realm, which
        // was wrong on its own terms: karma (or a forcerealm override) decided the
        // destination, and a placement failure is OUR problem, not grounds to overrule
        // it. In the log this showed up as "forcerealm animal" and "forcerealm brahma"
        // silently reborn as human -- the realm the player was sentenced to was simply
        // discarded, and `birthRealm` was then written as 'human' so they got no
        // penalties either.
        //
        // Instead: stay in the realm, place the player at the anchor, and CARVE a
        // pocket of air so they are not suffocating inside rock.
        //
        // Carving is not the old self-perpetuating platform problem. That bug was a
        // 3x3 stone platform the NEXT search would find and reuse forever, making the
        // first failure permanent. This writes air, not ground, at a known-bad
        // location we are already committed to -- and because the spot is never
        // cached, a later rebirth re-searches from scratch.
        console.warn(
            `[Samsara] no survivable spot in ${dimId} near ${bx},${anchor.y},${bz}` +
                ` (realm ${realm}); staying in ${realm} and carving a pocket at the anchor`
        )

        var fb = cfg.realmScanBounds[realm] || cfg.realmScanBounds.default
        var py = anchor.y
        if (py < fb.min + 1) py = fb.min + 1
        if (py > fb.max - 3) py = fb.max - 3

        try {
            // Floor under the feet only if there is nothing solid there, so we do not
            // replace real terrain.
            var floorBlock = level.getBlock(bx, py - 1, bz)
            if (!isGround(floorBlock)) {
                setBlockId(floorBlock, cfg.safeSpawn.fallbackFloorBlock)
            }
            // Clear the body space and a little headroom.
            for (var cy = 0; cy <= 2; cy++) {
                setBlockId(level.getBlock(bx, py + cy, bz), 'minecraft:air')
            }
        } catch (e) {
            console.warn(`[Samsara] could not carve a fallback pocket: ${e}`)
        }

        return {
            realm: realm,
            dimId: dimId,
            level: level,
            spot: { x: bx, y: py, z: bz },
            stats: stats,
            rule: rule,
            degraded: true,
        }
    }

    // Cache the verified spot so the next death in this realm is nearly free.
    global.SMS.spawnCache[cacheKey] = {
        x: found.spot.x,
        y: found.spot.y,
        z: found.spot.z,
        at: global.SMS.tickClock || 0,
    }

    return {
        realm: realm,
        dimId: dimId,
        level: level,
        spot: found.spot,
        stats: stats,
        rule: rule,
        pass: found.pass,
    }
}

// ---- Test seam -------------------------------------------------------------
//
// The spawn search is the one part of this file with no in-game assertion available:
// a bad spot looks like a normal rebirth. These exports let the offline harness drive
// the REAL search against a synthetic level (roofed world, cave-riddled world, high
// terrain), which is how the y=-3 cave-spawn bug is regression-tested.
//
// Exported deliberately, not incidentally. Nothing in production reads these.
global.SMS.debugSpawn = {
    findRebirthSpot: findRebirthSpot,
    isValidStand: isValidStand,
    scanColumnSurface: scanColumnSurface,
    spiralSurfaceSearch: spiralSurfaceSearch,
    seesSky: seesSky,
    isClear: isClear,
    isGround: isGround,
}

// ---- Liberation ------------------------------------------------------------

// Mark a player liberated and announce it.
//
// DELIBERATELY A STUB. The design doc (section 14) retired the original "world
// becomes permanently unusable" ending in favour of the liberated player continuing
// to play, and the project notes record that decision -- so there is no existing endgame
// behaviour for this to invoke. What liberation DOES, beyond leaving the cycle, is
// still the user's call.
//
// What is implemented and safe:
//   - the flag, which makes every karma system skip this player (decay, ripening,
//     routing, rebirth);
//   - vanilla respawn behaviour from here on.
//
// What is NOT implemented and must not be improvised:
//   - Mara's assault, the Bodhi seat, parinibbana and credits (design doc 10/14);
//   - turning off luck, aging, craving and realm penalties (those systems do not
//     exist yet);
//   - anything that touches the save. The project notes: NEVER delete or corrupt save
//     files. That rule is absolute and liberation does not get an exception.
global.SMS.grantLiberation = (player, reason) => {
    try {
        global.SMS.persistedTag(player).putBoolean(global.SMS.config.nbt.liberated, true)
    } catch (e) {
        console.warn(`[Samsara] could not mark ${player.profile.name} liberated: ${e}`)
        return false
    }

    console.info(`[Samsara] LIBERATION: ${player.profile.name} has left the cycle -- ${reason}`)

    try {
        player.tell(Text.gold('The cycle releases you.'))
        player.tell(Text.gray('  Karma no longer binds you. You are reborn no more.'))
        // Say plainly that the endgame content is unbuilt, rather than implying a
        // finished ending that does not exist.
        player.tell(Text.darkGray('  (Liberation endgame content is not yet implemented.)'))
    } catch (ignored) {
        // tell() unavailable; the log line above is enough
    }

    return true
}

// ---- Death: route, aim the respawn at the destination, then ripen -----------
//
// Pointing the vanilla respawn position AT the rebirth destination is what removes the
// bed flicker: vanilla places the player there itself, so there is no frame at the bed
// to see. setSpawnLocation(LevelBlock) calls the real setter, setRespawnPosition(dim,
// pos, angle, forced = true, ...), verified in the KubeJS 6 and 7 jars.
//
// Editing SpawnX/SpawnY/SpawnZ NBT does NOT work -- that is only the serialized form.
EntityEvents.death(event => {
    const player = event.entity
    if (!player || !player.isPlayer()) return

    // A liberated player is outside the cycle: death is an ordinary Minecraft death
    // and vanilla handles the respawn (their bed, or world spawn). Nothing here runs.
    try {
        if (global.SMS.isLiberated(player)) {
            console.info(`[Samsara] ${player.profile.name} is liberated; ordinary respawn, no rebirth`)
            return
        }
    } catch (ignored) {
        // fall through and treat as unliberated
    }

    // ORDERING. Routing is resolved BEFORE ripening, and ripening runs after.
    //
    // This is the reverse of the old flat death burn, which ran first so the realm
    // reflected post-burn stats. It has to change because ripening is
    // realm-specific: spending "the dominant poison" or "a deva's merit" is only
    // defined once the destination is known. So:
    //
    //   1. pickDestination  -- decides the realm from the karma of the life just ended
    //   2. ripenKarma       -- spends the karma that caused that destination
    //
    // The realm therefore reflects the life as it was LIVED, and the ripening is the
    // consequence. That is also the doctrinally correct order: the karma ripens into
    // a birth, and is thereby spent.
    //
    // Resolve the destination once and stash it, so PlayerEvents.respawned does not
    // repeat the whole search. The old code ran pickDestination in BOTH hooks: two
    // full world scans per death.
    try {
        var dest = global.SMS.pickDestination(player)

        // Liberation reached at the moment of death: no rebirth, no ripening.
        if (dest && dest.liberated) {
            global.SMS.grantLiberation(player, dest.rule)
            return
        }

        if (dest) {
            global.SMS.pendingRebirth = global.SMS.pendingRebirth || {}

            // Drop stale entries first. A player who dies and then quits without
            // respawning leaves their entry behind forever, so without this the map
            // grows for the life of the server.
            var pend = global.SMS.pendingRebirth
            var nowT = global.SMS.tickClock || 0
            var pkeys = Object.keys(pend)
            for (var pi = 0; pi < pkeys.length; pi++) {
                var age = nowT - pend[pkeys[pi]].at
                if (age < 0 || age > 24000) delete pend[pkeys[pi]]
            }

            pend['' + player.uuid] = {
                realm: dest.realm,
                dimId: dest.dimId,
                x: dest.spot.x,
                y: dest.spot.y,
                z: dest.spot.z,
                at: nowT,
                // Carried so the respawn log can name HOW the spot was chosen. The
                // respawn handler has no access to the destination object on this
                // path, and a bad placement is undiagnosable without it.
                how: dest.degraded
                    ? 'DEGRADED (no spot found; carved at anchor)'
                    : (dest.cached ? 'cached' : 'pass=' + (dest.pass || '?')),
            }
            player.setSpawnLocation(dest.level.getBlock(dest.spot.x, dest.spot.y, dest.spot.z))

            if (dest.degraded) {
                console.warn(
                    `[Samsara] ${player.profile.name}: no searchable spot in ${dest.realm};` +
                        ` placed at the carved anchor ${dest.spot.x},${dest.spot.y},${dest.spot.z}.` +
                        ` The realm is UNCHANGED -- check that realm's realmSpawns entry.`
                )
            }

            // Ripen the karma that produced this birth, now that the destination is
            // known. Replaces the old flat 25% death burn.
            //
            // In its OWN try/catch: a ripening failure must not cost the player their
            // already-resolved destination. The respawn point is set above, so even if
            // this throws the rebirth still lands correctly -- the player just keeps
            // karma they should have spent, which is recoverable. The reverse (losing
            // the destination) would dump them in the wrong realm.
            try {
                global.SMS.ripenKarma(player, dest.realm)
            } catch (e2) {
                console.warn(`[Samsara] ripening failed for ${player.profile.name}: ${e2}`)
            }
        }
    } catch (e) {
        console.warn(`[Samsara] could not pre-set respawn point: ${e}`)
    }
})

// ---- Respawn: place the player and record the birth realm ------------------
PlayerEvents.respawned(event => {
    const player = event.entity
    const cfg = global.SMS.config

    // CRITICAL: this event also fires when a player returns from the End through the
    // exit portal. Without this guard, walking out of the End teleported the player to
    // their karma realm and overwrote birthRealm, with no death and no karma burn: a
    // free rebirth and a way to reroll your realm.
    //
    // KubeJS 7: PlayerRespawnedKubeEvent carries `endConquered` (isEndConquered()).
    // There is no `keepData` any more -- reading it gives undefined, which is falsy, so
    // the 1.20.1 guard would silently never fire. (Port doc 07, jar fact J13.)
    var endReturn = false
    try {
        endReturn = event.endConquered === true
    } catch (ignored) {
        endReturn = false
    }
    if (endReturn) {
        console.info('[Samsara] respawn after the End (endConquered): not a rebirth, leaving player alone')
        return
    }

    // A liberated player respawns like any vanilla player -- at their bed, or world
    // spawn. No realm, no teleport, no birthRealm write. Checked here as well as in
    // the death hook because this handler also runs when no pendingRebirth exists
    // (server restarted between death and respawn), and that path would otherwise
    // re-route them into the cycle.
    try {
        if (global.SMS.isLiberated(player)) {
            console.info(`[Samsara] ${player.profile.name} is liberated; vanilla respawn`)
            return
        }
    } catch (ignored) {
        // fall through
    }

    // Prefer the destination resolved at death: the stats have since ripened and
    // re-routing here could disagree with the respawn point already set.
    var pending = null
    try {
        var key = '' + player.uuid
        if (global.SMS.pendingRebirth && global.SMS.pendingRebirth[key]) {
            pending = global.SMS.pendingRebirth[key]
            delete global.SMS.pendingRebirth[key]
        }
    } catch (ignored) {
        pending = null
    }

    var realm, dimId, spot, stats, how
    if (pending) {
        realm = pending.realm
        dimId = pending.dimId
        spot = { x: pending.x, y: pending.y, z: pending.z }
        stats = global.SMS.getStats(player)
        how = pending.how || '?'
    } else {
        // No stashed destination (server restarted between death and respawn, or the
        // death hook failed). Resolve now.
        var dest = global.SMS.pickDestination(player)
        if (!dest) {
            console.warn('[Samsara] respawn: no destination resolved; leaving player in place')
            return
        }

        // Liberation resolved on this path instead of at death. Ripening is
        // deliberately NOT run here: this branch only happens when the death hook
        // did not, so there is no double-spend risk, and a liberated player never
        // ripens anyway.
        if (dest.liberated) {
            global.SMS.grantLiberation(player, dest.rule)
            return
        }
        realm = dest.realm
        dimId = dest.dimId
        spot = dest.spot
        stats = dest.stats
        how = dest.degraded
            ? 'DEGRADED (no spot found; carved at anchor)'
            : (dest.cached ? 'cached' : 'pass=' + (dest.pass || '?')) + ' (late-resolve)'
    }

    // Only one teleportTo overload exists:
    //   kjs$teleportTo(ResourceLocation dim, double x, double y, double z, float yaw, float pitch)
    // All six args are required.
    //
    // Rotation IS readable, contrary to an earlier note in the handoff: EntityMixin
    // carries @RemapForJS m_146908_ -> getYaw and m_146909_ -> getPitch, so
    // `player.yaw` / `player.pitch` work. The earlier attempt used player.yRot, the
    // raw obfuscated FIELD, which is genuinely unreadable. Preserving the facing means
    // a rebirth no longer snaps everyone to due south.
    var yaw = 0
    var pitch = 0
    try {
        var y = Number(player.yaw)
        if (isFinite(y)) yaw = y
    } catch (ignored) {
        yaw = 0
    }
    try {
        var p = Number(player.pitch)
        if (isFinite(p)) pitch = p
    } catch (ignored) {
        pitch = 0
    }

    // +0.5 centres the player on the block. y is the feet position already.
    player.teleportTo(dimId, spot.x + 0.5, spot.y, spot.z + 0.5, yaw, pitch)

    // Record the realm this life began in. Realm PENALTIES follow birthRealm, never the
    // dimension the player happens to stand in.
    global.SMS.persistedTag(player).putString(cfg.nbt.birthRealm, realm)

    // Apply the new realm's penalties NOW, immediately after writing birthRealm.
    //
    // We cannot rely on samsara_realms.js's own PlayerEvents.respawned handler for
    // this: samsara_realms.js loads BEFORE this file (priority 60 > 40, and it sorted
    // first alphabetically on 1.20.1 too), so it runs first -- it would read the
    // previous life's birthRealm and apply the wrong effects. That is why dying into
    // naraka once left the player on full health.
    //
    // Calling it here removes the dependency on load order entirely.
    try {
        global.SMS.applyRealmEffects(player)
    } catch (e) {
        console.warn(`[Samsara] applyRealmEffects after rebirth failed: ${e}`)
    }

    // `how` is the placement provenance (which pass matched / cached / degraded),
    // set in both branches above and carried through pendingRebirth on the normal
    // path. Logged because without it a bad spawn cannot be diagnosed from the log at
    // all -- the y=-3 human rebirth needed a source read to attribute, when
    // `pass=no-sky-fallback` in this line would have named the cause outright.
    console.info(
        `[Samsara] rebirth: ${player.profile.name} -> ${realm} (${dimId})` +
            ` @ ${spot.x},${spot.y},${spot.z} [${how}]` +
            ` [poisons g=${stats.greed} h=${stats.hatred} d=${stats.delusion}` +
            ` antidotes gen=${stats.generosity} met=${stats.metta} wis=${stats.wisdom}]`
    )
})

// ---- Debug command ---------------------------------------------------------
//
// Resolves and reports a rebirth spot WITHOUT killing the player, so spawn placement
// can be tested per realm without dying and without a world reset.
ServerEvents.commandRegistry(event => {
    const C = event.commands
    const A = event.arguments

    event.register(
        C.literal('samsaraspawn')
            .requires(src => src.hasPermission(2))
            .then(C.argument('realm', A.STRING.create(event))
                .executes(ctx => {
                    const player = ctx.source.player
                    // Coerced: the argument is a Java String, which would miss every
                    // JS key it is used to index.
                    const realm = '' + A.STRING.getResult(ctx, 'realm')
                    const cfg = global.SMS.config

                    if (!global.SMS.isRealm(realm)) {
                        ctx.source.sendFailure(
                            Text.red(`Unknown realm '${realm}'. Valid: ${Object.keys(cfg.realmDimensions).join(', ')}`)
                        )
                        return 1
                    }

                    const stats = global.SMS.getStats(player)
                    const dimId = global.SMS.dimensionForRealm(realm, stats, player.server)
                    var level = null
                    try {
                        level = player.server.getLevel(dimId)
                    } catch (ignored) {
                        level = null
                    }
                    if (!level) {
                        ctx.source.sendFailure(Text.red(`Dimension ${dimId} did not resolve.`))
                        return 1
                    }

                    // Bypass the cache so this always measures a real search.
                    delete global.SMS.spawnCache[realm + '@' + dimId]

                    const anchor = global.SMS.rebirthAnchor(player, realm)
                    var bx = anchor.x
                    var bz = anchor.z
                    if (dimId === 'minecraft:the_nether') {
                        bx = Math.floor(bx / 8)
                        bz = Math.floor(bz / 8)
                    }
                    loadChunkAt(level, bx, bz)

                    const found = findRebirthSpot(level, realm, { x: bx, y: anchor.y, z: bz }, dimId)
                    if (!found) {
                        ctx.source.sendFailure(Text.red(`${realm} (${dimId}): NO SAFE SPOT FOUND near ${bx},${bz}`))
                        return 1
                    }

                    const s = found.spot
                    const sky = seesSky(level.getBlock(s.x, s.y, s.z))
                    ctx.source.sendSuccess(
                        Text.green(
                            `${realm} (${dimId}) -> ${s.x},${s.y},${s.z}` +
                                `  [pass: ${found.pass}, sky: ${sky}]`
                        ),
                        false
                    )
                    ctx.source.sendSuccess(
                        Text.gray(`  floor: ${idOf(level.getBlock(s.x, s.y - 1, s.z))}`),
                        false
                    )
                    return 1
                })))
})

console.info('[Samsara] rebirth handler registered')

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

// Would a player standing at (x,y,z) -- floor at y-1 -- be over the void? (decided
// 2026-10-25, the user: "make sure that we never spawn over a void, even with the stone
// block platform".) Two tests, both from config.safeSpawn:
//   groundDepth  the floor and the blocks under it, that many in all, are not air -- a
//                one-block sliver of an island (or the old fallback's lone stone block in
//                mid-air) fails;
//   edgeDrop     each of the four neighbouring columns holds something within edgeDrop
//                blocks under the floor's level -- the lip of an island, or a pillar,
//                fails; ordinary ground, a slope, a step or a lake shore passes (water is
//                not air).
// Only air counts as nothing: this asks "is there anything under me", not "is it good".
function overVoid(level, x, y, z) {
    const sp = global.SMS.config.safeSpawn
    var depth = sp.groundDepth || 0
    for (var d = 2; d <= depth; d++) {
        if (isClear(level.getBlock(x, y - d, z))) return true
    }
    var drop = sp.edgeDrop || 0
    if (drop <= 0) return false
    var sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    for (var i = 0; i < sides.length; i++) {
        var held = false
        for (var k = 1; k <= drop + 1; k++) {
            if (!isClear(level.getBlock(x + sides[i][0], y - k, z + sides[i][1]))) {
                held = true
                break
            }
        }
        if (!held) return true
    }
    return false
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
    // Last, so it costs reads only for a spot that is otherwise good.
    if (overVoid(level, x, y, z)) return false
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

// The cache key carries the ANCHOR column, not just the realm: a birth at its grave
// (graveAnchor) has a different anchor per player, and keyed by realm alone the next
// preta would have been born at the first one's grave.
function spawnCacheKey(realm, dimId, anchor) {
    return realm + '@' + dimId + '@' + anchor.x + ',' + anchor.z
}

// Drop entries past cacheTicks, so per-player grave anchors cannot pile up.
function pruneSpawnCache() {
    const ttl = global.SMS.config.safeSpawn.cacheTicks
    const now = global.SMS.tickClock || 0
    const keys = Object.keys(global.SMS.spawnCache)
    for (var i = 0; i < keys.length; i++) {
        var age = now - global.SMS.spawnCache[keys[i]].at
        if (age < 0 || age >= ttl) delete global.SMS.spawnCache[keys[i]]
    }
}

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

// The last HUMAN death (config.nbt.humanDeath*): where Tombstone leaves the grave, and
// where a realm in config.graves.bornAtGrave is born. Recorded by the death handler below,
// from the DYING life's birthRealm -- the respawn handler writes the new one only later.
// Overwritten only by the next human death, so it survives any number of other births.
// Explicit getters (N9): getX/Y/Z, and KubeJS's getLevel().getDimension() -- NOT vanilla's
// level(): KubeJS's `level` bean shadows that method, and calling it threw "Cannot call
// property level" on every death in game (2026-10-24), so no human death was recorded.
global.SMS.recordHumanDeath = player => {
    if (global.SMS.birthRealmOf(player) !== 'human') return false
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    tag.putDouble(nbt.humanDeathX, Math.floor(Number(player.getX())))
    tag.putDouble(nbt.humanDeathY, Math.floor(Number(player.getY())))
    tag.putDouble(nbt.humanDeathZ, Math.floor(Number(player.getZ())))
    tag.putString(nbt.humanDeathDim, '' + player.getLevel().getDimension())
    tag.putBoolean(nbt.humanDeathSet, true)
    return true
}

// Where a birth into `realm` is anchored when it is born at its grave: the last human
// death, if `realm` is in config.graves.bornAtGrave and that death was in the realm's own
// dimension (a preta haunts the human world, so a human who last died in the Nether
// leaves nothing in the Overworld to haunt). Otherwise null. Pretas haunt "their old
// homes" (Khp 7, the Tirokudda; design doc 7.4).
global.SMS.graveAnchor = (player, realm) => {
    const cfg = global.SMS.config
    const born = (cfg.graves && cfg.graves.bornAtGrave) || []
    if (born.indexOf('' + realm) === -1) return null
    const nbt = cfg.nbt
    const tag = global.SMS.persistedTag(player)
    if (!tag.getBoolean(nbt.humanDeathSet)) return null
    if (global.SMS.nbtString(tag, nbt.humanDeathDim) !== '' + global.SMS.dimensionForRealm(realm)) return null
    var x = Number(tag.getDouble(nbt.humanDeathX))
    var y = Number(tag.getDouble(nbt.humanDeathY))
    var z = Number(tag.getDouble(nbt.humanDeathZ))
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null
    return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
}

// Vanilla classes the anchors use, loaded once (read from the 1.21.1 jars, 2026-10-25;
// net.minecraft is open to scripts, J47). Each is null when it cannot be loaded, and its
// user falls back and says so.
function loadAnchorClass(name) {
    try {
        return Java.loadClass(name)
    } catch (e) {
        console.warn(`[Samsara] could not load ${name}: ${e}`)
        return null
    }
}
const HeightmapTypes = loadAnchorClass('net.minecraft.world.level.levelgen.Heightmap$Types')
const BlockPosClass = loadAnchorClass('net.minecraft.core.BlockPos')
const TagKeyClass = loadAnchorClass('net.minecraft.tags.TagKey')
const RegistriesClass = loadAnchorClass('net.minecraft.core.registries.Registries')
const AnchorResourceLocation = loadAnchorClass('net.minecraft.resources.ResourceLocation')

// The world's own spawn: Level.getSharedSpawnPos(), where vanilla put the world's first
// spawn -- on land (it searches for it). Read from the Overworld; null if unreadable.
// In game 2026-10-25 it was -272,123,384 while 0,0 -- the old human anchor -- was ocean,
// and every Overworld birth fell through to a cave at y -15.
global.SMS.worldSpawn = server => {
    try {
        var p = server.getLevel('minecraft:overworld').getSharedSpawnPos()
        var x = Number(p.getX())
        var y = Number(p.getY())
        var z = Number(p.getZ())
        if (isFinite(x) && isFinite(y) && isFinite(z)) return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
    } catch (e) {
        console.warn(`[Samsara] the world spawn is unreadable; using realmSpawns: ${e}`)
    }
    return null
}

// The surface at x,z: the first open block above the highest motion-blocking one (vanilla
// heightmap MOTION_BLOCKING_NO_LEAVES -- water counts, leaves do not), so a birth found by
// biome starts its search where the ground is. Loads the chunk, as the search would.
function surfaceY(level, x, z) {
    if (!HeightmapTypes) return null
    try {
        var h = Number(level.getHeight(HeightmapTypes.MOTION_BLOCKING_NO_LEAVES, x, z))
        return isFinite(h) ? Math.floor(h) : null
    } catch (e) {
        return null
    }
}

// One biome condition, as config strings write them: 'ns:id', '#ns:tag', '!' in front to
// negate (the animal homes' format, samsara_animal_homes.js). Returns a test on a
// Holder<Biome>: getRegisteredName() for an id, is(TagKey) for a tag.
function biomeCondition(spec) {
    var s = '' + spec
    var neg = s.charAt(0) === '!'
    if (neg) s = s.substring(1)
    var tag = null
    if (s.charAt(0) === '#') {
        tag = TagKeyClass.create(RegistriesClass.BIOME, AnchorResourceLocation.parse(s.substring(1)))
    }
    var id = s
    return holder => {
        var hit = tag !== null ? holder.is(tag) === true : ('' + holder.getRegisteredName()) === id
        return neg ? !hit : hit
    }
}

// A test over GROUPS: any group may match, every condition in it must hold.
function biomeGroupsTest(groups) {
    var built = []
    for (var i = 0; i < groups.length; i++) {
        var conds = []
        for (var j = 0; j < groups[i].length; j++) conds.push(biomeCondition(groups[i][j]))
        built.push(conds)
    }
    return holder => {
        for (var g = 0; g < built.length; g++) {
            var all = true
            for (var c = 0; c < built[g].length; c++) {
                if (!built[g][c](holder)) {
                    all = false
                    break
                }
            }
            if (all) return true
        }
        return false
    }
}

// Where an animal body's creature lives (config.animalBirth.homes, generated from Alex's
// Mobs' spawn config), as a biome test; null for a body with no home listed.
global.SMS.homeBiomeTest = form => {
    var homes = (global.SMS.config.animalBirth || {}).homes || {}
    var groups = homes['' + form]
    if (!groups || groups.length === 0) return null
    return biomeGroupsTest(groups)
}

// The nearest biome passing `test` to `from`, by vanilla's /locate biome search
// (ServerLevel.findClosestBiome3d: the biome source sampled outward in a spiral, so the
// first hit is the nearest -- for a large biome, its edge). {x, z, biome} or null.
//
// Cached by `key` -- which names the dimension -- and origin: biomes are fixed by the
// seed, so only the first birth of a kind pays. Cleared when a world loads (ServerEvents.loaded, below): a new world in the
// same session has a new seed.
global.SMS.biomeAnchorCache = global.SMS.biomeAnchorCache || {}
function nearestBiome(level, test, key, from) {
    var ck = '' + key + '@' + from.x + ',' + from.z
    var cache = global.SMS.biomeAnchorCache
    if (cache[ck] !== undefined) return cache[ck]
    var bs = global.SMS.config.biomeSearch
    var found = null
    try {
        var pair = level.findClosestBiome3d(holder => test(holder), new BlockPosClass(from.x, from.y, from.z),
            bs.radius, bs.horizontalStep, bs.verticalStep)
        if (pair) {
            var bp = pair.getFirst()
            found = {
                x: Math.floor(Number(bp.getX())),
                z: Math.floor(Number(bp.getZ())),
                biome: '' + pair.getSecond().getRegisteredName(),
            }
        }
    } catch (e) {
        console.warn(`[Samsara] biome search '${key}' failed: ${e}`)
    }
    cache[ck] = found
    return found
}

ServerEvents.loaded(event => {
    global.SMS.biomeAnchorCache = {}
})

// Where a birth into `realm` is anchored (config.birthPlace; decided 2026-10-25, the
// user): {x, y, z, how}. `level` is the realm's dimension; `form` is an animal birth's
// body. Rebirth means losing your place in the world, so it is never where the player
// died. The cases, first match:
//   a preta's grave (graveAnchor) -- the last HUMAN death, a different life's place;
//   'worldSpawn'  the world's own spawn;
//   'homeBiome'   the nearest of the body's home biomes to the world's spawn;
//   'biome'       the nearest of birthPlace.biomes to realmSpawns[realm];
//   otherwise, or when a search finds nothing, the world's spawn for a 'worldSpawn' /
//   'homeBiome' realm and realmSpawns[realm] for the rest.
// A birth found by biome starts at that column's surface (heightmap).
global.SMS.birthAnchor = (player, realm, level, form) => {
    const cfg = global.SMS.config
    try {
        var grave = global.SMS.graveAnchor(player, realm)
        if (grave) return { x: grave.x, y: grave.y, z: grave.z, how: 'at-grave' }
    } catch (e) {
        console.warn(`[Samsara] grave anchor unreadable for ${player.profile.name}; using the realm's anchor: ${e}`)
    }
    var place = (cfg.birthPlace || {})['' + realm] || {}
    var c = (cfg.realmSpawns || {})['' + realm] || { x: 0, y: 64, z: 0 }
    var dimId = '' + global.SMS.dimensionForRealm(realm)
    var a = null
    if (place.anchor === 'worldSpawn' || place.anchor === 'homeBiome') {
        var ws = global.SMS.worldSpawn(player.server)
        if (place.anchor === 'homeBiome' && ws) {
            var test = global.SMS.homeBiomeTest(form)
            var hit = test ? nearestBiome(level, test, dimId + '|home:' + form, ws) : null
            if (hit) a = { x: hit.x, y: ws.y, z: hit.z, how: 'home-biome ' + hit.biome }
        }
        if (!a && ws) a = { x: ws.x, y: ws.y, z: ws.z, how: 'world-spawn' }
    } else if (place.anchor === 'biome' && place.biomes && place.biomes.length > 0) {
        var groups = []
        for (var i = 0; i < place.biomes.length; i++) groups.push([place.biomes[i]])
        var hit2 = nearestBiome(level, biomeGroupsTest(groups), dimId + '|biomes:' + place.biomes.join(','), c)
        if (hit2) a = { x: hit2.x, y: c.y, z: hit2.z, how: 'biome ' + hit2.biome }
    }
    if (!a) return { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z), how: 'realm-spawn' }
    if (a.how !== 'world-spawn') {
        var sy = surfaceY(level, a.x, a.z)
        if (sy !== null) a.y = sy
    }
    return a
}

// ---- A human's home: the bed or respawn anchor it set (birthPlace.human.home) ----
//
// Decided 2026-10-25 (the user): "unless a player has set a spawn point as a human via a
// bed or respawn anchor, in which case they should respawn wherever they set it, but only
// as a human" -- and it is KEPT through other lives (asked and answered).
//
// Recorded from NeoForge's PlayerSetSpawnEvent, which ServerPlayer.setRespawnPosition
// posts every time (read from neoforge-21.1.264): a bed or an anchor sets it with
// forced = false; KubeJS's setSpawnLocation -- Samsara's own aim at each birth -- and
// /spawnpoint set it with forced = true, so those are not homes. A null position is a
// spawn being cleared. Only a living human's counts ("as a human").
global.SMS.onSpawnSet = event => {
    if (event.isForced()) return false
    var pos = event.getNewSpawn()
    if (pos === null || pos === undefined) return false
    var player = event.getEntity()
    if (!player || !player.isPlayer()) return false
    if ('' + global.SMS.birthRealmOf(player) !== 'human') return false
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    tag.putDouble(nbt.homeX, Math.floor(Number(pos.getX())))
    tag.putDouble(nbt.homeY, Math.floor(Number(pos.getY())))
    tag.putDouble(nbt.homeZ, Math.floor(Number(pos.getZ())))
    tag.putString(nbt.homeDim, '' + event.getSpawnLevel().location())
    tag.putBoolean(nbt.homeSet, true)
    return true
}

// The registration is in a try: a top-level throw here would abort the rest of this file.
try {
    NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.event.entity.player.PlayerSetSpawnEvent'), event => {
        try {
            global.SMS.onSpawnSet(event)
        } catch (e) {
            console.warn(`[Samsara] could not record a set spawn point: ${e}`)
        }
    })
} catch (e) {
    console.error(`[Samsara] could not register the home hook -- humans will not return to their beds: ${e}`)
}

// The recorded home, {x, y, z, dim}, or null.
global.SMS.homeOf = player => {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    if (!tag.getBoolean(nbt.homeSet)) return null
    var dim = global.SMS.nbtString(tag, nbt.homeDim)
    var x = Number(tag.getDouble(nbt.homeX))
    var y = Number(tag.getDouble(nbt.homeY))
    var z = Number(tag.getDouble(nbt.homeZ))
    if (dim === '' || !isFinite(x) || !isFinite(y) || !isFinite(z)) return null
    return { x: x, y: y, z: z, dim: dim }
}

global.SMS.forgetHome = player => {
    global.SMS.persistedTag(player).putBoolean(global.SMS.config.nbt.homeSet, false)
}

// Point the vanilla respawn at the home, NOT forced -- so vanilla decides, as for any
// bed: a missing or obstructed bed, or an empty anchor, fails ("You have no home bed or
// charged respawn anchor"), and a working anchor spends a charge
// (ServerPlayer.findRespawnAndUseSpawnBlock, read from the jar). setRespawnPosition takes
// a ResourceKey; LevelBlock.getDimensionKey() gives it -- the level's own dimension() is
// shadowed by KubeJS's getDimension() bean (the N13 trap).
function aimAtHome(player, home) {
    var lvl = player.server.getLevel(home.dim)
    if (!lvl) return false
    var b = lvl.getBlock(home.x, home.y, home.z)
    player.setRespawnPosition(b.getDimensionKey(), b.getPos(), 0, false, false)
    return true
}

// After a respawn aimed at the home: did vanilla put the player there? A bed's or an
// anchor's stand-up spot is beside it.
function standsAtHome(player, home) {
    if (('' + player.getLevel().getDimension()) !== home.dim) return false
    return Math.abs(Number(player.getX()) - (home.x + 0.5)) <= 3 &&
        Math.abs(Number(player.getY()) - home.y) <= 3 &&
        Math.abs(Number(player.getZ()) - (home.z + 0.5)) <= 3
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
    var forced = global.SMS.forcedRealmOf(player)
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

    // An animal birth's BODY is chosen first: where it is born follows the body (its
    // creature's home biome). Chosen from the stats that routed it, before ripening.
    const form = animalFormAtDeath(player, realm, global.SMS.tickClock || 0)
    const anchor = global.SMS.birthAnchor(player, realm, level, form)
    // Born at the grave (a preta at its last human death)? Named in the rebirth line.
    var atGrave = anchor.how === 'at-grave'
    // A human with a home (the bed or anchor it set as a human) is reborn there if vanilla
    // still finds it; the spot below is the fallback.
    var home = null
    if ('' + realm === 'human' && ((cfg.birthPlace || {}).human || {}).home) {
        try {
            home = global.SMS.homeOf(player)
        } catch (ignored) {
            home = null
        }
    }

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

    // Everything a destination carries, whichever way its spot was found.
    function destination(spot, extra) {
        var d = {
            realm: realm,
            dimId: dimId,
            level: level,
            spot: spot,
            stats: stats,
            rule: rule,
            atGrave: atGrave,
            form: form,
            home: home,
            anchorHow: anchor.how,
        }
        var ks = Object.keys(extra)
        for (var i = 0; i < ks.length; i++) d[ks[i]] = extra[ks[i]]
        return d
    }

    // --- Cache hit? Re-validate before trusting it.
    var cacheKey = spawnCacheKey(realm, dimId, searchAnchor)
    var cached = global.SMS.spawnCache[cacheKey]
    if (cached) {
        // `|| 0` because samsara_decay.js owns tickClock and load order between
        // server_scripts files is not guaranteed; an undefined clock must not make
        // this NaN (every comparison against NaN is false, which silently disables
        // the cache -- the same class of bug as the long-reads-as-NaN trap).
        var fresh = (global.SMS.tickClock || 0) - cached.at
        if (fresh >= 0 && fresh < cfg.safeSpawn.cacheTicks) {
            if (isValidStand(level, cached.x, cached.y, cached.z, skyMode)) {
                return destination({ x: cached.x, y: cached.y, z: cached.z }, { cached: true })
            }
        }
        // stale or no longer valid
        delete global.SMS.spawnCache[cacheKey]
    }

    var found = findRebirthSpot(level, realm, searchAnchor, dimId)
    // Nothing near the anchor -- and nothing UNDER it either? Then the land is elsewhere:
    // ask the generator where (brahma's seeded islands).
    if (!found) found = probeForLand(level, realm, searchAnchor, dimId)

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
        // Instead: stay in the realm, at the anchor, on real footing (lastResortSpot).
        // Never cached, so a later rebirth re-searches from scratch.
        var fb = cfg.realmScanBounds[realm] || cfg.realmScanBounds.default
        var last = lastResortSpot(level, bx, anchor.y, bz, fb)
        console.warn(
            `[Samsara] no survivable spot in ${dimId} near ${bx},${anchor.y},${bz}` +
                ` (realm ${realm}); staying in ${realm}: ${last.how} at ${last.x},${last.y},${last.z}`
        )
        return destination({ x: last.x, y: last.y, z: last.z }, { degraded: true, lastResort: last.how })
    }

    // Cache the verified spot so the next death in this realm is nearly free.
    pruneSpawnCache()
    global.SMS.spawnCache[cacheKey] = {
        x: found.spot.x,
        y: found.spot.y,
        z: found.spot.z,
        at: global.SMS.tickClock || 0,
    }

    return destination(found.spot, { pass: found.pass })
}

// ---- When the anchor has no land near it ---------------------------------------

// Is the column at x,z void all the way down (brahma between its islands)? Read from the
// terrain generator -- ChunkGenerator.getBaseHeight walks the noise column, generating no
// chunk -- and treated as "has terrain" whenever that cannot be read, so a realm whose
// generator is unreadable keeps the old behaviour rather than probing blind.
function terrainProbeTools(level) {
    if (!HeightmapTypes) return null
    try {
        var cs = level.getChunkSource()
        return { gen: cs.getGenerator(), rs: cs.randomState() }
    } catch (e) {
        return null
    }
}
function baseHeight(level, tools, x, z) {
    try {
        var h = Number(tools.gen.getBaseHeight(x, z, HeightmapTypes.WORLD_SURFACE_WG, level, tools.rs))
        return isFinite(h) ? h : null
    } catch (e) {
        return null
    }
}

// No standable spot near the anchor, and NO TERRAIN under it: ask the generator where
// land is, in rings `terrainProbe.step` apart out to `radius`, and search at the first
// `tries` columns that hold some. Returns findRebirthSpot's result with its pass named
// 'probe@dx,dz/<pass>', or null. Not run while the anchor has terrain under it -- a
// roofed or flooded spot is the ordinary passes' business, and four more full searches
// there would be pure cost.
function probeForLand(level, realm, anchor, dimId) {
    const cfg = global.SMS.config
    const pr = cfg.safeSpawn.terrainProbe
    if (!pr) return null
    const tools = terrainProbeTools(level)
    if (!tools) return null
    const bounds = cfg.realmScanBounds[realm] || cfg.realmScanBounds.default
    var here = baseHeight(level, tools, anchor.x, anchor.z)
    if (here === null || here > bounds.min + 1) return null
    var rings = Math.floor(pr.radius / pr.step)
    var tries = 0
    for (var ring = 1; ring <= rings; ring++) {
        for (var dx = -ring; dx <= ring; dx++) {
            for (var dz = -ring; dz <= ring; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
                var x = anchor.x + dx * pr.step
                var z = anchor.z + dz * pr.step
                var h = baseHeight(level, tools, x, z)
                if (h === null) return null
                if (h <= bounds.min + 1) continue
                loadChunkAt(level, x, z)
                var r = findRebirthSpot(level, realm, { x: x, y: Math.floor(h), z: z }, dimId)
                if (r) return { spot: r.spot, pass: 'probe@' + dx * pr.step + ',' + dz * pr.step + '/' + r.pass }
                tries++
                if (tries >= pr.tries) return null
            }
        }
    }
    return null
}

// The very last resort, at the anchor column -- and NEVER a block in mid-air (the user,
// 2026-10-25). Walks down from the anchor to the first block that is not air:
//   found  -> footing: the player stands on it (made stone if it was lava or water) with
//             three blocks carved clear above -- a pocket in the ground, nothing to fall
//             through;
//   none   -> the column is void to the bottom of the realm. Only a realm with no terrain
//             within the probe's reach comes here -- a broken datapack -- and it gets an
//             ISLAND (islandRadius out, islandDepth thick), not the single stone block that
//             stood at brahma's 0,150,0 on 2026-10-25.
// Returns {x, y, z, how}.
function lastResortSpot(level, bx, by, bz, bounds) {
    const sp = global.SMS.config.safeSpawn
    var py = by
    if (py < bounds.min + 1) py = bounds.min + 1
    if (py > bounds.max - 3) py = bounds.max - 3
    var fy = null
    for (var y = py - 1; y >= bounds.min; y--) {
        if (!isClear(level.getBlock(bx, y, bz))) {
            fy = y
            break
        }
    }
    try {
        if (fy !== null) {
            var floorBlock = level.getBlock(bx, fy, bz)
            if (!isGround(floorBlock)) setBlockId(floorBlock, sp.fallbackFloorBlock)
            for (var cy = 1; cy <= 3; cy++) setBlockId(level.getBlock(bx, fy + cy, bz), 'minecraft:air')
            return { x: bx, y: fy + 1, z: bz, how: 'carved' }
        }
        console.error(`[Samsara] NO TERRAIN under or near ${bx},${bz} -- the realm's datapack is broken; building an island`)
        var r = sp.islandRadius || 2
        var depth = sp.islandDepth || 3
        for (var ix = -r; ix <= r; ix++) {
            for (var iz = -r; iz <= r; iz++) {
                for (var iy = 1; iy <= depth; iy++) setBlockId(level.getBlock(bx + ix, py - iy, bz + iz), sp.fallbackFloorBlock)
                for (var ay = 0; ay <= 2; ay++) setBlockId(level.getBlock(bx + ix, py + ay, bz + iz), 'minecraft:air')
            }
        }
    } catch (e) {
        console.warn(`[Samsara] could not prepare the last-resort spot: ${e}`)
    }
    return { x: bx, y: fy !== null ? fy + 1 : py, z: bz, how: fy !== null ? 'carved' : 'island' }
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
    overVoid: overVoid,
    probeForLand: probeForLand,
    lastResortSpot: lastResortSpot,
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
//   - turning off luck and craving (those systems do not exist yet). Realm penalties
//     and Aging DO turn off: applyRealmEffects below lifts them, and a liberated
//     player no longer ages (samsara_realms.js);
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

    // Lift the realm's penalties NOW: the player's own body back, out of Adventure
    // mode, no preta clock. Until 2026-10-22 only the flag was set, so `/karma
    // liberate` on an animal-born player left them in the creature body until their
    // next death -- found by the in-game test (row 18).
    try {
        global.SMS.applyRealmEffects(player)
    } catch (e) {
        console.warn(`[Samsara] liberation: applyRealmEffects failed: ${e}`)
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
//
// The one exception is a human with a home (2026-10-25): the respawn is aimed at the
// home, NOT forced, so vanilla itself checks the bed or anchor (aimAtHome above).
//
// The body an animal birth gets: '' for any other realm, and '' when nothing is
// configured (applyRealmEffects then leaves the player in their own body).
function animalFormAtDeath(player, realm, nowT) {
    if ('' + realm !== 'animal') return ''
    var pick = global.SMS.animalFormFor(global.SMS.getStats(player), '' + player.uuid + ':' + nowT)
    return pick ? pick.form : ''
}

// HOW a destination's spot was chosen, for the rebirth log line: the pass (or the cache,
// or the last resort) and where the search was anchored.
function describeHow(dest) {
    var how = dest.degraded
        ? 'DEGRADED (no spot found; ' + (dest.lastResort || '?') + ' at anchor)'
        : (dest.cached ? 'cached' : 'pass=' + (dest.pass || '?'))
    if (dest.anchorHow) how += ' from ' + dest.anchorHow
    if (dest.home) how += ' home?'
    return how
}

EntityEvents.death(event => {
    const player = event.entity
    if (!player || !player.isPlayer()) return

    // A liberated player is outside the cycle: death is an ordinary Minecraft death
    // and vanilla handles the respawn (their bed, or world spawn). Nothing here runs --
    // but a home the player set as a human is handed back to vanilla first: Samsara's
    // births since then aimed the vanilla respawn elsewhere.
    try {
        if (global.SMS.isLiberated(player)) {
            var libHome = global.SMS.homeOf(player)
            if (libHome) aimAtHome(player, libHome)
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
    //
    // FIRST record a human death: it is where Tombstone leaves this life's grave, and
    // the anchor of a preta birth -- including the one this very death may route to.
    try {
        global.SMS.recordHumanDeath(player)
    } catch (e) {
        console.warn(`[Samsara] could not record the human death of ${player.profile.name}: ${e}`)
    }
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
                // An animal birth's BODY, chosen by pickDestination from the stats that
                // routed it -- ripening below changes them (it halves delusion), and the
                // diet must follow the karma that caused the birth, as the realm does.
                form: dest.form || '',
                // A human's home (the bed or anchor it set as a human), or null. The
                // respawn handler checks whether vanilla found it.
                home: dest.home || null,
                // Carried so the respawn log can name HOW the spot was chosen. The
                // respawn handler has no access to the destination object on this
                // path, and a bad placement is undiagnosable without it.
                how: describeHow(dest),
            }
            var aimedHome = false
            if (dest.home) {
                try {
                    aimedHome = aimAtHome(player, dest.home)
                } catch (eh) {
                    console.warn(`[Samsara] could not aim ${player.profile.name}'s respawn at their home: ${eh}`)
                }
            }
            if (!aimedHome) player.setSpawnLocation(dest.level.getBlock(dest.spot.x, dest.spot.y, dest.spot.z))

            if (dest.degraded) {
                console.warn(
                    `[Samsara] ${player.profile.name}: no searchable spot in ${dest.realm};` +
                        ` placed by the last resort (${dest.lastResort}) at ${dest.spot.x},${dest.spot.y},${dest.spot.z}.` +
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
            //
            // A death by OLD AGE (Aging ran out; samsara_realms.js marks it for the length
            // of the blow, which is when this runs) ripens at full rate and is recorded as
            // no rapid-death streak (ripenKarma, opts.oldAge).
            try {
                var oldAge = !!(global.SMS.diesOfOldAge && global.SMS.diesOfOldAge(player))
                global.SMS.ripenKarma(player, dest.realm, { oldAge: oldAge })
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

    var realm, dimId, spot, stats, how, form, home
    if (pending) {
        realm = pending.realm
        dimId = pending.dimId
        spot = { x: pending.x, y: pending.y, z: pending.z }
        stats = global.SMS.getStats(player)
        how = pending.how || '?'
        form = pending.form || ''
        home = pending.home || null
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
        how = describeHow(dest) + ' (late-resolve)'
        // Nothing ripened on this path, so the stats are still the ones that routed it.
        form = dest.form || ''
        home = dest.home || null
    }

    // A human aimed at its home: if vanilla found the bed or anchor, the player already
    // stands beside it -- born there, no teleport. If not (broken, obstructed, an empty
    // anchor), vanilla has said so ("You have no home bed...") and put the player at the
    // world spawn; the home is forgotten and the birth goes to the searched spot.
    if (home) {
        var atHome = false
        try {
            atHome = standsAtHome(player, home)
        } catch (e) {
            atHome = false
        }
        if (atHome) {
            global.SMS.placeBirth(player, {
                realm: realm,
                dimId: home.dim,
                spot: { x: Math.floor(Number(player.getX())), y: Math.floor(Number(player.getY())), z: Math.floor(Number(player.getZ())) },
                stats: stats,
                how: 'home ' + home.x + ',' + home.y + ',' + home.z,
                form: form,
                stay: true,
            }, 'rebirth')
            return
        }
        global.SMS.forgetHome(player)
        how += ' (home gone)'
    }

    global.SMS.placeBirth(player, { realm: realm, dimId: dimId, spot: spot, stats: stats, how: how, form: form }, 'rebirth')
})

// ---- A birth: put the player in the new life ---------------------------------
//
// Teleport to the spot, record the birth realm and the body, apply the realm's rules,
// say what they are, and log it. `label` names it in the log ('rebirth'). (Shared with
// the deva's fall, a birth without a death, from 2026-10-24 until Aging retired the fall
// on 2026-10-25.)
global.SMS.placeBirth = (player, birth, label) => {
    const cfg = global.SMS.config
    const realm = birth.realm
    const dimId = birth.dimId
    const spot = birth.spot
    const stats = birth.stats
    const form = birth.form || ''
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

    // +0.5 centres the player on the block. y is the feet position already. A birth at
    // the player's home (`stay`) is where vanilla already put them.
    if (!birth.stay) player.teleportTo(dimId, spot.x + 0.5, spot.y, spot.z + 0.5, yaw, pitch)

    // Record the realm this life began in. Realm PENALTIES follow birthRealm, never the
    // dimension the player happens to stand in. The body is recorded with it ('' for
    // any realm but animal), and applyRealmEffects below puts the player in it.
    global.SMS.persistedTag(player).putString(cfg.nbt.birthRealm, realm)
    global.SMS.persistedTag(player).putString(cfg.nbt.animalForm, form)

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
    // A birth, so say what this life's rules are (samsara_realms.js).
    try {
        if (global.SMS.tellBirthRules) global.SMS.tellBirthRules(player)
    } catch (ignored) {
        // messaging is best-effort
    }

    // `how` is the placement provenance (which pass matched / cached / degraded),
    // set in both branches above and carried through pendingRebirth on the normal
    // path. Logged because without it a bad spawn cannot be diagnosed from the log at
    // all -- the y=-3 human rebirth needed a source read to attribute, when
    // `pass=no-sky-fallback` in this line would have named the cause outright.
    console.info(
        `[Samsara] ${label}: ${player.profile.name} -> ${realm} (${dimId})` +
            ` @ ${spot.x},${spot.y},${spot.z} [${birth.how}]` +
            (form ? ` [body ${form}]` : '') +
            ` [poisons g=${stats.greed} h=${stats.hatred} d=${stats.delusion}` +
            ` antidotes gen=${stats.generosity} met=${stats.metta} wis=${stats.wisdom}]`
    )
}

// ---- The deva's fall: RETIRED 2026-10-25 ----------------------------------------------
//
// From 2026-10-24 a deva whose radiance faded FELL: a rebirth by karma without a death,
// routed with rule 3 skipped. Aging replaced it (the user, 2026-10-25): every life ends in
// death by old age, and a deva's is routed normally -- "No, route normally" -- so it may be
// a deva again at once if its merit allows. git history has global.SMS.fallFromHeaven.

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

                    // Anchored as a birth would be (an animal: a body picked from the
                    // player's stats now, and its home biome).
                    const form = animalFormAtDeath(player, realm, global.SMS.tickClock || 0)
                    const anchor = global.SMS.birthAnchor(player, realm, level, form)
                    var bx = anchor.x
                    var bz = anchor.z
                    if (dimId === 'minecraft:the_nether') {
                        bx = Math.floor(bx / 8)
                        bz = Math.floor(bz / 8)
                    }
                    // Bypass the cache so this always measures a real search.
                    delete global.SMS.spawnCache[spawnCacheKey(realm, dimId, { x: bx, z: bz })]
                    loadChunkAt(level, bx, bz)

                    var found = findRebirthSpot(level, realm, { x: bx, y: anchor.y, z: bz }, dimId)
                    if (!found) found = probeForLand(level, realm, { x: bx, y: anchor.y, z: bz }, dimId)
                    ctx.source.sendSuccess(
                        Text.gray(`  anchor: ${bx},${anchor.y},${bz} (${anchor.how})` + (form ? ` body ${form}` : '')),
                        false
                    )
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

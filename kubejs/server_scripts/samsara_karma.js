// Samsara — Three Poisons / Three Antidotes: storage, rebirth routing, and the
// events that change karma.
//
// Storage: stats are kept in the player's Forge "PlayerPersisted" NBT sub-tag.
// That sub-tag is the one Forge copies to the new player entity on death, so values
// survive both death and relog. The root persistentData does NOT survive death,
// which is why we must use the sub-tag.
//
// Stats are NON-NEGATIVE and capped at config.statCap. Routing works entirely on
// SHARES of the total, so the absolute scale never matters -- only the balance.

global.SMS = global.SMS || {}

const PERSISTED = 'PlayerPersisted'

// Returns the live PlayerPersisted CompoundTag, creating it if missing.
// getCompound() returns the live nested tag when present, or a fresh empty one when
// absent; putting it back stores that reference so later writes persist.
global.SMS.persistedTag = player => {
    const root = player.persistentData
    const sub = root.getCompound(PERSISTED)
    root.put(PERSISTED, sub)
    return sub
}

// ---- Stat storage ----------------------------------------------------------

const statKey = stat => global.SMS.config.nbt.statPrefix + stat

// Round to a multiple of config.statGrain.
//
// THE SINGLE QUANTISATION SEAM. Award values are all drawn from
// {0.1, 0.25, 0.5, 0.75, 1.0}, but ripening and passive decay multiply, so they
// produce values like 1.125 or 2.4750000000000001. Every write goes through
// setStat, and setStat calls this, so no code path can store a trailing decimal.
//
// Math.round(v / grain) * grain reintroduces float error of its own (0.05 is not
// exact in binary), so the result is rounded to 2 decimal places afterwards. At
// grain 0.05 two places is exact.
global.SMS.quantize = value => {
    const grain = global.SMS.config.statGrain
    if (!grain || grain <= 0) return value
    var steps = Math.round(value / grain)
    return Math.round(steps * grain * 100) / 100
}

global.SMS.getStat = (player, stat) => global.SMS.persistedTag(player).getDouble(statKey(stat))

// Clamp to [0, statCap], quantise, store.
global.SMS.setStat = (player, stat, value) => {
    const cap = global.SMS.config.statCap
    var v = Number(value)
    if (!isFinite(v)) v = 0
    if (v < 0) v = 0
    if (v > cap) v = cap
    v = global.SMS.quantize(v)
    global.SMS.persistedTag(player).putDouble(statKey(stat), v)
    return v
}

global.SMS.addStat = (player, stat, delta) =>
    global.SMS.setStat(player, stat, global.SMS.getStat(player, stat) + delta)

// All six stats as a plain object.
global.SMS.getStats = player => {
    const out = {}
    const stats = global.SMS.STATS
    for (let i = 0; i < stats.length; i++) {
        out[stats[i]] = global.SMS.getStat(player, stats[i])
    }
    return out
}

global.SMS.isStat = name => global.SMS.STATS.indexOf('' + name) !== -1

// ---- Derived values --------------------------------------------------------
//
// Nothing here is stored. P, A, Net and the shares are always recomputed, so there
// is no possibility of a cached derived value drifting out of sync with the stats.

function sumOf(stats, keys) {
    var sum = 0
    for (var i = 0; i < keys.length; i++) {
        var v = Number(stats[keys[i]])
        if (isFinite(v)) sum += v
    }
    return sum
}

// Everything routing and the readout need, in one object.
//
//   P      poison total      (greed + hatred + delusion)
//   A      antidote total    (generosity + metta + wisdom)
//   total  A + P
//   net    A / total, or 0.5 when total is 0 (a new player is balanced)
//   share  per-stat share of total; all zero when total is 0
global.SMS.derive = stats => {
    const P = sumOf(stats, global.SMS.POISONS)
    const A = sumOf(stats, global.SMS.ANTIDOTES)
    const total = A + P

    const share = {}
    const all = global.SMS.STATS
    for (var i = 0; i < all.length; i++) {
        share[all[i]] = total > 0 ? stats[all[i]] / total : 0
    }

    return {
        P: P,
        A: A,
        total: total,
        // Both sides at zero means perfectly balanced, not "all poison". This is
        // what makes a brand-new player route to human with no special case.
        net: total > 0 ? A / total : 0.5,
        share: share,
    }
}

// ---- Migration -------------------------------------------------------------

// v1: the original build stored one signed "samsara_karma" double.
// Negative became hatred, positive became metta (what was then called virtue).
function migrateLegacyScalar(player) {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    if (tag.getBoolean(nbt.migrated)) return

    const legacy = tag.getDouble(nbt.legacyKarma)
    if (legacy < 0) {
        global.SMS.addStat(player, 'hatred', -legacy)
    } else if (legacy > 0) {
        global.SMS.addStat(player, 'metta', legacy)
    }

    tag.putDouble(nbt.legacyKarma, 0)
    tag.putBoolean(nbt.migrated, true)

    if (legacy !== 0) {
        console.info(`[Samsara] v1 migration: folded legacy karma ${legacy} for ${player.profile.name}`)
    }
}

// v2: the Poisons/Antidotes rename, plus the rescale onto 0..statCap.
//
// Two renames and one rescale, all additive -- nothing is wiped:
//
//   samsara_virtue     -> metta    (sila -> loving-kindness)
//   samsara_meditation -> wisdom   (bhavana -> panna)
//
// greed / hatred / delusion / generosity keep their keys and need no move.
//
// RESCALE. The old scale was unbounded with killVillager at 25 points; the new one
// caps every stat at 10. Old values are divided by `legacyScale` so a player who
// had accumulated a meaningful amount does not instantly sit at the cap. 5 is
// chosen so the old neutralBand of 50 maps to 10 -- i.e. a player who was exactly
// at the old "decisive" threshold lands at the top of the new scale.
function migrateRenameAndRescale(player) {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    if (tag.getBoolean(nbt.migratedV2)) return

    const legacyScale = 5.0
    const stats = global.SMS.STATS
    var touched = false

    // Fold the two renamed keys into their new homes BEFORE rescaling, so the
    // rescale below catches them too.
    var oldVirtue = tag.getDouble(nbt.legacyVirtue)
    if (oldVirtue > 0) {
        // Raw put, not addStat: addStat would cap at statCap before the rescale and
        // silently throw away everything above 10.
        tag.putDouble(statKey('metta'), tag.getDouble(statKey('metta')) + oldVirtue)
        tag.putDouble(nbt.legacyVirtue, 0)
        touched = true
    }

    var oldMeditation = tag.getDouble(nbt.legacyMeditation)
    if (oldMeditation > 0) {
        tag.putDouble(statKey('wisdom'), tag.getDouble(statKey('wisdom')) + oldMeditation)
        tag.putDouble(nbt.legacyMeditation, 0)
        touched = true
    }

    // Now rescale every stat onto the new 0..statCap scale.
    for (var i = 0; i < stats.length; i++) {
        var raw = tag.getDouble(statKey(stats[i]))
        if (raw > 0) {
            global.SMS.setStat(player, stats[i], raw / legacyScale)
            touched = true
        }
    }

    tag.putBoolean(nbt.migratedV2, true)

    if (touched) {
        console.info(
            `[Samsara] v2 migration: renamed virtue->metta, meditation->wisdom and` +
                ` rescaled /${legacyScale} for ${player.profile.name}`
        )
    }
}

global.SMS.migrateKarma = player => {
    try {
        migrateLegacyScalar(player)
    } catch (e) {
        console.warn(`[Samsara] v1 migration failed: ${e}`)
    }
    try {
        migrateRenameAndRescale(player)
    } catch (e) {
        console.warn(`[Samsara] v2 migration failed: ${e}`)
    }
}

PlayerEvents.loggedIn(event => {
    global.SMS.migrateKarma(event.player)
})

// ---- Dominance / tie-breaking ----------------------------------------------

// Name of the largest stat among `keys`.
//
// TIE HANDLING. A strict > comparison makes ties fall to whichever key happens to
// be first in the array, so an evenly-spread 1/1/1 poison total routed to naraka
// purely because 'hatred' is listed first. That is an arbitrary verdict on a player
// who is not especially hateful.
//
// Ties resolve through config.routing.tieBreak, an explicit least-to-most-severe
// order, so a tie lands on the GENTLER outcome.
global.SMS.dominantOf = (stats, keys) => {
    const order = global.SMS.config.routing.tieBreak || []
    var best = keys[0]
    for (var i = 1; i < keys.length; i++) {
        var k = keys[i]
        if (stats[k] > stats[best]) {
            best = k
        } else if (stats[k] === stats[best]) {
            // Equal: prefer whichever appears EARLIER in tieBreak (the gentler one).
            var ik = order.indexOf(k)
            var ib = order.indexOf(best)
            if (ik !== -1 && (ib === -1 || ik < ib)) best = k
        }
    }
    return best
}

// ---- Liberation ------------------------------------------------------------

// Does this player's karma satisfy the exit conditions?
//
// Returns { pass: bool, reason: string } so the debug readout can say WHICH
// condition failed rather than just "no".
//
// DESIGN PRINCIPLE: generosity and metta improve the quality of a rebirth, but only
// wisdom unlocks the exit. Because wisdomShareMin is a share of A + P (not of A),
// piling up generosity actively pushes wisdom's share DOWN -- so liberation demands
// restraint across the board, not accumulation. Maxing the other two antidotes
// lands you in deva.
global.SMS.liberationCheck = stats => {
    const cfg = global.SMS.config.liberation
    if (!cfg.enabled) return { pass: false, reason: 'liberation disabled' }

    const d = global.SMS.derive(stats)

    // With no karma at all there is nothing to liberate -- a fresh player is not an
    // arahant. The wisdom test below would fail anyway (share 0), but saying so
    // explicitly keeps the reason legible.
    if (d.total <= 0) return { pass: false, reason: 'no karma accumulated' }

    if (d.share.wisdom < cfg.wisdomShareMin) {
        return {
            pass: false,
            reason: `wisdom share ${fmt(d.share.wisdom)} < ${cfg.wisdomShareMin}`,
        }
    }
    if (d.share.delusion > cfg.delusionShareMax) {
        return {
            pass: false,
            reason: `delusion share ${fmt(d.share.delusion)} > ${cfg.delusionShareMax}`,
        }
    }
    if (d.share.greed > cfg.greedShareMax) {
        return { pass: false, reason: `greed share ${fmt(d.share.greed)} > ${cfg.greedShareMax}` }
    }
    if (d.share.hatred > cfg.hatredShareMax) {
        return { pass: false, reason: `hatred share ${fmt(d.share.hatred)} > ${cfg.hatredShareMax}` }
    }

    return { pass: true, reason: 'all conditions met' }
}

// Two decimal places without .toFixed().
//
// java.lang.Double has no toFixed under Rhino, and values summed out of NBT come
// back as Java doubles -- calling .toFixed() on one throws at the END of an
// otherwise successful handler, so the work lands and only the log line vanishes.
function fmt(v) {
    return Math.round(Number(v) * 100) / 100
}
global.SMS.fmt = fmt

// Is this player eligible to even be checked for liberation?
// Only from the realms in config.liberation.realms -- human by default, which is
// what makes a human birth "precious".
global.SMS.liberationEligible = player => {
    const cfg = global.SMS.config.liberation
    if (!cfg.enabled) return false
    try {
        var born = global.SMS.birthRealmOf(player)
        return cfg.realms.indexOf('' + born) !== -1
    } catch (ignored) {
        return false
    }
}

global.SMS.isLiberated = player => {
    try {
        return global.SMS.persistedTag(player).getBoolean(global.SMS.config.nbt.liberated)
    } catch (ignored) {
        return false
    }
}

// ---- Rebirth routing -------------------------------------------------------

// Decide which realm a player is reborn into, from stats alone.
//
// Returns { realm, rule } -- `rule` names the branch that matched, so the debug
// command can explain the verdict instead of just stating it.
//
// Rules are evaluated in order and the FIRST match wins. Liberation (rule 1) is not
// handled here: it needs the player's birthRealm, not just their stats, so the
// caller checks it first via global.SMS.routeFor.
//
//   0. total < minTotal                        -> human
//   2. net < lowerNet                          -> largest poison picks the realm
//   3. net >= devaNet, wisdom/A < devaWisdomMax -> deva
//   4. net >= asuraNet, hatred leads P,
//      hatred share >= asuraHatredShare         -> asura
//   5. otherwise                               -> human
//
// BRAHMA IS ABSENT ON PURPOSE. In the source cosmology the brahma realms are
// reached only by jhana attainment, never by accumulated merit, so there is no
// karma branch that leads there. Phase 6's jhana gate will be its sole entrance.
global.SMS.realmFor = stats => {
    const cfg = global.SMS.config.routing
    const d = global.SMS.derive(stats)

    // Rule 0. Not enough karma to judge a life by. This is what stops a new
    // player's first kill from deciding their next birth: one hostile gives
    // P = 0.1, A = 0, net = 0.0, which would otherwise route to the animal realm.
    if (d.total < cfg.minTotal) {
        return { realm: 'human', rule: `minTotal (total ${fmt(d.total)} < ${cfg.minTotal})` }
    }

    // Rule 2. The poisons outweigh the antidotes: the player falls, and the
    // dominant poison decides where.
    if (d.net < cfg.lowerNet) {
        // `var`, not `const`: Rhino scopes const/let per FUNCTION, not per block, so
        // a const inside a nested block throws "redeclaration of var" the SECOND
        // time that block runs. This has cost this project three debugging rounds --
        // see the project notes. Inside any try/if/loop body, use var.
        var lead = global.SMS.dominantOf(stats, global.SMS.POISONS)
        var realm = lead === 'hatred' ? 'naraka' : lead === 'greed' ? 'preta' : 'animal'
        return { realm: realm, rule: `lower (net ${fmt(d.net)} < ${cfg.lowerNet}, ${lead} leads)` }
    }

    // Rule 3. Deva: real merit with no insight. Virtue without wisdom is the deva
    // trap -- a pleasant birth that burns through its own merit and falls again.
    //
    // The wisdom test is a share of the ANTIDOTE total (A), not of A + P: the
    // question is what KIND of merit this is, and mixing the poisons into that
    // denominator would let a poisonous life read as "wise" merely by having little
    // merit of any kind.
    if (d.net >= cfg.devaNet) {
        var wisdomOfA = d.A > 0 ? stats.wisdom / d.A : 0
        if (wisdomOfA < cfg.devaWisdomMax) {
            return {
                realm: 'deva',
                rule: `deva (net ${fmt(d.net)} >= ${cfg.devaNet}, wisdom/A ${fmt(wisdomOfA)} < ${cfg.devaWisdomMax})`,
            }
        }
    }

    // Rule 4. Asura: merit corrupted by aggression. Checked AFTER deva, so a wise,
    // peaceful, high-merit player is never dragged here.
    //
    // Both gates are SHARE-based, which is what fixes the old absolute-floor cliff:
    // under the previous rule one hatred point flipped human -> asura at a fixed
    // threshold, and no amount of merit ever bought you out. Now merit dilutes
    // hatred's share proportionally, so it does.
    if (d.net >= cfg.asuraNet && d.P > 0) {
        var leadP = global.SMS.dominantOf(stats, global.SMS.POISONS)
        if (leadP === 'hatred' && d.share.hatred >= cfg.asuraHatredShare) {
            return {
                realm: 'asura',
                rule: `asura (net ${fmt(d.net)} >= ${cfg.asuraNet}, hatred leads, share ${fmt(d.share.hatred)} >= ${cfg.asuraHatredShare})`,
            }
        }
    }

    // Rule 5. Everything else, including a high-net player with strong wisdom.
    //
    // That is INTENTIONAL and canonical: the source gives human rebirth as
    // "virtue and wisdom development", and the human realm is the only one
    // liberation is reachable from. Landing here with high wisdom is the reward,
    // not a failure to place.
    return { realm: 'human', rule: `human (net ${fmt(d.net)}, no other rule matched)` }
}

// Full routing decision for a player, liberation included.
//
// Returns { realm, rule, liberated }. When `liberated` is true the caller must skip
// rebirth entirely -- there is no realm to go to.
global.SMS.routeFor = player => {
    const stats = global.SMS.getStats(player)

    // Already liberated: nothing further to decide.
    if (global.SMS.isLiberated(player)) {
        return { realm: null, rule: 'already liberated', liberated: true, stats: stats }
    }

    // Rule 1. Liberation, checked only from an eligible realm (human by default).
    if (global.SMS.liberationEligible(player)) {
        var lib = global.SMS.liberationCheck(stats)
        if (lib.pass) {
            return { realm: null, rule: `liberation (${lib.reason})`, liberated: true, stats: stats }
        }
    }

    const r = global.SMS.realmFor(stats)
    return { realm: r.realm, rule: r.rule, liberated: false, stats: stats }
}

// The realm a player would be reborn into RIGHT NOW.
//
// A forced realm (set by /karma forcerealm, for testing) overrides the karma
// comparison entirely. Note this is distinct from birthRealm, which is the realm
// the player currently LIVES under and drives penalties.
// CompoundTag.getString returns a JAVA String, not a JS string.
//
// Two things break on that, and both bit at once:
//
//   1. Indexing a JS object with a Java String does not match its JS keys, so
//      `config.realmDimensions[forced]` was undefined for a perfectly valid realm.
//   2. `===` against a JS string literal is false for a Java String.
//
// Everything read out of NBT is normalised to a real JS string here, once, so no
// caller has to think about it.
global.SMS.nbtString = (tag, key) => {
    try {
        var raw = tag.getString(key)
        if (raw === null || raw === undefined) return ''
        return ('' + raw).trim()
    } catch (ignored) {
        return ''
    }
}

// Is this a realm name this pack knows about? Coerces first, so a Java String works.
global.SMS.isRealm = name => {
    if (!name) return false
    var key = '' + name
    // hasOwnProperty rather than truthiness: a realm whose dimension id were ever
    // empty would otherwise read as unknown.
    return Object.prototype.hasOwnProperty.call(global.SMS.config.realmDimensions, key)
}

global.SMS.forcedRealmOf = player => {
    try {
        var forced = global.SMS.nbtString(global.SMS.persistedTag(player), global.SMS.config.nbt.forcedRealm)
        if (forced && global.SMS.isRealm(forced)) return forced
    } catch (ignored) {
        // none set
    }
    return null
}

global.SMS.realmOf = player => global.SMS.forcedRealmOf(player) || global.SMS.routeFor(player).realm

// Does this dimension actually exist in the running game?
//
// This is what makes third-party integrations optional rather than required: an
// override naming a dimension from an uninstalled mod simply does not resolve, and
// Samsara falls back to its own.
global.SMS.dimensionExists = (server, dimId) => {
    if (!server || !dimId) return false
    try {
        return !!server.getLevel(dimId)
    } catch (ignored) {
        return false
    }
}

// Map a realm name to a dimension id.
//
// Resolution order, lowest priority first:
//   1. config.realmDimensions -- Samsara's own dimensions, always present.
//   2. config.realmOverrides  -- third-party dimensions, applied only when they
//      actually resolve. Later entries win, so pack authors can reorder.
//   3. Deva tiering: Twilight Forest as the lowest heaven for a modest deva.
global.SMS.dimensionForRealm = (realm, stats, server) => {
    const cfg = global.SMS.config

    // Coerce before indexing: a Java String (or any non-primitive) would miss every
    // JS key here and silently fall back to the human dimension.
    var realmKey = realm ? '' + realm : ''
    var chosen = cfg.realmDimensions[realmKey] || cfg.realmDimensions.human

    // Third-party overrides, if allowed and actually installed.
    if (!cfg.forceOwnDimensions && server && cfg.realmOverrides) {
        for (let i = 0; i < cfg.realmOverrides.length; i++) {
            var entry = cfg.realmOverrides[i]
            if (entry.realm !== realmKey) continue
            if (global.SMS.dimensionExists(server, entry.dimension)) {
                chosen = entry.dimension
            }
        }
    }

    // Deva tiering: a barely-deva player gets the lesser heaven when it exists.
    if (realmKey === 'deva' && stats) {
        var tiers = cfg.devaTiers
        if (tiers && stats.generosity < tiers.generosityThreshold) {
            if (!cfg.forceOwnDimensions && global.SMS.dimensionExists(server, tiers.lowestHeaven)) {
                chosen = tiers.lowestHeaven
            }
        }
    }

    return chosen
}

// ---- Victim classification -------------------------------------------------

// villager | hostile | passive.
//
// isMonster() alone is not enough. It maps to vanilla's Monster/Enemy type, and
// several mobs sit on the wrong side of that line for this mod's purposes:
//
//   - HOGLIN is an Animal in vanilla, so isMonster() is false. Killing hoglins for
//     food -- a normal Nether activity -- was charging the passive rate for an
//     animal that attacks on sight.
//   - IRON GOLEM / SNOW GOLEM are neither Monster nor Animal, so they fell through
//     to "passive" like a cow.
//   - WANDERING TRADER is an NPC a player trades with, but it was not special-cased.
//
// Explicit config lists are checked FIRST, then isMonster(), then the KubeJS animal
// helpers, and only then the passive default.
global.SMS.classifyVictim = victim => {
    const cfg = global.SMS.config

    var type = ''
    try {
        type = '' + victim.type
    } catch (ignored) {
        type = ''
    }

    // 1. Explicitly villager-class: the heaviest category.
    if (cfg.villagerLikeEntities.indexOf(type) !== -1) return 'villager'

    // 2. Explicitly hostile, overriding vanilla's type hierarchy.
    if (cfg.hostileEntities.indexOf(type) !== -1) return 'hostile'

    // 3. Vanilla's own notion of a monster.
    try {
        if (victim.isMonster()) return 'hostile'
    } catch (ignored) {
        // helper missing for this entity; keep going
    }

    // 4. Anything the game calls an animal, water creature or ambient creature is
    //    passive. Being explicit here means an unrecognised modded mob does NOT
    //    silently land in the most expensive bracket it qualifies for.
    try {
        if (victim.isAnimal() || victim.isWaterCreature() || victim.isAmbientCreature()) return 'passive'
    } catch (ignored) {
        // helpers missing; fall through
    }

    // 5. Default. Unknown mobs are treated as passive, which is the cautious
    //    reading: it charges the player for a life taken rather than waving it
    //    through.
    return 'passive'
}

// Is this entity tamed or named? Either makes it a being the player had a bond with,
// so killing it is the heaviest animal kill in the game.
//
// There is no isTamed() on EntityKJS in this build, so read the NBT: vanilla stores
// an `Owner` UUID on tameable mobs and `CustomName` on named ones.
// IMPORTANT -- `Owner` IS NOT A STRING in 1.20.1.
//
// Vanilla's TamableAnimal writes the owner as a UUID, which serialises as an
// INT_ARRAY tag (4 ints), not a string. `getString('Owner')` on an int-array
// returns "" , so a string-only check reported every tamed wolf as un-tamed and
// taming never awarded metta. (Pre-1.16 it was a string, which is why so much
// old example code reads it that way.)
//
// `contains(key)` is the type-agnostic test and is the right tool here: we only
// need to know whether an owner EXISTS, never who it is. Falls back to the string
// read for any mod that still stores it the old way, and to getCompound for the
// odd wrapper case.
function isBondedAnimal(entity) {
    try {
        var nbt = entity.nbt
        if (!nbt) return false

        // 1. Type-agnostic presence check. Covers the 1.20.1 int-array UUID.
        try {
            if (nbt.contains('Owner')) return true
        } catch (ignored2) {
            // contains() unavailable on this binding; fall through to the reads
        }

        // 2. Legacy / modded string owner.
        var owner = '' + (nbt.getString('Owner') || '')
        if (owner.trim().length > 0) return true

        // 3. A named animal is bonded even if nobody tamed it.
        var name = '' + (nbt.getString('CustomName') || '')
        if (name.trim().length > 0) return true
    } catch (ignored) {
        return false
    }
    return false
}

// Diagnostic: dump an entity's tame-related NBT so the real shape is visible in the
// log instead of being guessed at. Called from the tame queue when a check fails.
// Costs nothing unless a tame candidate does not resolve.
function describeTameNbt(entity) {
    var parts = []
    try {
        var nbt = entity.nbt
        if (!nbt) return 'nbt unreadable'
        try {
            parts.push('contains(Owner)=' + nbt.contains('Owner'))
        } catch (e1) {
            parts.push('contains() threw')
        }
        try {
            parts.push("getString(Owner)='" + nbt.getString('Owner') + "'")
        } catch (e2) {
            parts.push('getString(Owner) threw')
        }
        try {
            // Whole tag as a string is the surest way to see what is actually there.
            parts.push('tag=' + ('' + nbt).slice(0, 300))
        } catch (e3) {
            parts.push('toString threw')
        }
    } catch (e) {
        return 'nbt access threw: ' + e
    }
    return parts.join('  ')
}

// Is this a baby? Vanilla keeps a negative `Age` on young animals. There is no
// isBaby() anywhere in this KubeJS build -- grepping the whole jar finds none, not
// on EntityKJS, not on LivingEntityKJS, not as a @RemapForJS rename.
function isBabyAnimal(entity) {
    try {
        var nbt = entity.nbt
        if (!nbt) return false
        var age = Number(nbt.getDouble('Age'))
        return isFinite(age) && age < 0
    } catch (ignored) {
        return false
    }
}

// ---- Kill attribution ------------------------------------------------------

// Resolve the player responsible for a death, or null.
//
// IMPORTANT (KubeJS 6 / Rhino): these are Java bean properties injected by
// KubeJS's DamageSourceMixin (kjs$getPlayer, and @RemapForJS getActual /
// getImmediate). They are only reachable with DOT notation. Bracket access
// like source['player'] returns undefined -- Rhino does not route dynamic
// keys through the bean-property lookup.
//
// This is also the owner-lookup seam that indirect kills (spells, minions,
// machine fake players, altars) will extend -- see design doc 11 and 13.
//
// A FakePlayer is the automation stand-in that machines use to act "as a player".
// Attributing karma to one is wrong twice over: there is no real person to hold
// responsible, and its persistent data is discarded, so the karma vanishes while
// the kill still counted.
function isRealPlayer(entity) {
    if (!entity) return false
    try {
        if (!entity.isPlayer()) return false
    } catch (ignored) {
        return false
    }
    try {
        if (entity.isFake()) return false
    } catch (ignored) {
        // isFake unavailable: assume real
    }
    return true
}

global.SMS.resolveKiller = source => {
    if (!source) return null

    // Direct player kill: the common case and the cheapest check.
    try {
        var p = source.player
        if (p && isRealPlayer(p)) return p
    } catch (ignored) {
        // property absent for this damage type
    }

    // Indirect: projectile / minion / machine. `actual` is the owner behind the
    // immediate damage dealer, so it is checked first.
    try {
        var actual = source.actual
        if (isRealPlayer(actual)) return actual
    } catch (ignored) {
        // not present / not entity-like
    }

    try {
        var immediate = source.immediate
        if (isRealPlayer(immediate)) return immediate
    } catch (ignored) {
        // not present / not entity-like
    }

    return null
}

// ---- Award -----------------------------------------------------------------

// Award an act by name, reading both its value and its target stat from config.
global.SMS.award = (player, act) => {
    const cfg = global.SMS.config
    const amount = cfg.karma[act]
    const stat = cfg.karmaStat[act]
    if (amount === undefined || !stat) {
        console.warn(`[Samsara] unknown karma act '${act}'`)
        return null
    }
    const before = global.SMS.getStat(player, stat)
    const newTotal = global.SMS.addStat(player, stat, amount)
    return { stat: stat, amount: amount, total: newTotal, capped: newTotal === before }
}

// ---- Generic anti-farm memory ----------------------------------------------
//
// Several hooks need "did this player already get paid for this thing recently?".
// One shared implementation, keyed by a bucket name so the hooks cannot interfere
// with each other.
//
// Stored in memory rather than NBT: this only needs to outlast a play session, and
// keeping it out of player data avoids unbounded NBT growth.
const recentMarks = {}

function playerKey(player) {
    try {
        return '' + player.uuid
    } catch (ignored) {
        return '' + player.profile.name
    }
}

// Returns true if this (player, bucket, id) was already paid inside `windowTicks`.
// Otherwise records it and returns false.
function alreadyPaid(player, bucket, id, windowTicks, maxEntries) {
    const now = global.SMS.tickClock || 0
    const key = playerKey(player) + '|' + bucket

    var seen = recentMarks[key]
    if (!seen) {
        seen = {}
        recentMarks[key] = seen
    }

    var at = seen[id]
    if (at !== undefined && now - at >= 0 && now - at < windowTicks) {
        return true
    }

    seen[id] = now

    // Prune so a long session cannot grow this without bound.
    var keys = Object.keys(seen)
    if (keys.length > maxEntries) {
        for (var i = 0; i < keys.length; i++) {
            var t = seen[keys[i]]
            if (now - t >= windowTicks || now < t) delete seen[keys[i]]
        }
        // Still too big even after pruning: reset rather than leak.
        if (Object.keys(seen).length > maxEntries) {
            recentMarks[key] = {}
            recentMarks[key][id] = now
        }
    }
    return false
}

function entityId(entity) {
    try {
        return '' + entity.uuid
    } catch (ignored) {
        return null
    }
}

// Would an animal-born player's action be cancelled anyway? Then do not pay for it.
// samsara_realms.js cancels block placing for them, and handler order between files
// is not guaranteed.
function blockedByAnimalRealm(player, effect) {
    try {
        return !!global.SMS.effectsFor(global.SMS.birthRealmOf(player))[effect]
    } catch (ignored) {
        // realms script not loaded; fall through and treat as allowed
        return false
    }
}

// ---- Hatred: killing ------------------------------------------------------

EntityEvents.death(event => {
    const victim = event.entity
    if (!victim || !victim.isLiving()) return

    // A player death is handled by the delusion hook further down, not here.
    if (victim.isPlayer()) return

    const killer = global.SMS.resolveKiller(event.source)
    if (!killer) return

    const kind = global.SMS.classifyVictim(victim)

    // Pick the heaviest applicable act. A tamed villager-class mob is impossible,
    // so these are checked most-specific first and only among animals.
    var act
    if (kind === 'villager') {
        act = 'killVillager'
    } else if (kind === 'hostile') {
        act = 'killHostile'
    } else if (isBondedAnimal(victim)) {
        // Tamed or named: a bond betrayed. Heaviest animal kill.
        act = 'killTamed'
    } else if (isBabyAnimal(victim)) {
        act = 'killBaby'
    } else {
        act = 'killPassive'
    }

    const r = global.SMS.award(killer, act)
    if (!r) return
    console.info(
        `[Samsara] ${killer.profile.name} killed ${victim.type} (${kind}/${act}):` +
            ` +${r.amount} ${r.stat} -> ${r.total}`
    )
})

// Hurting a peaceful mob and leaving it alive still grows hatred -- the intention
// was there. Guarded per entity so a single cow cannot be farmed by repeated hits,
// and skipped entirely when the hit kills (EntityEvents.death charges the full rate).
EntityEvents.hurt(event => {
    const victim = event.entity
    if (!victim || !victim.isLiving() || victim.isPlayer()) return

    const attacker = global.SMS.resolveKiller(event.source)
    if (!attacker) return

    // Only peaceful mobs: hitting hostiles is ordinary play and already priced
    // through killHostile.
    if (global.SMS.classifyVictim(victim) === 'hostile') return

    const cfg = global.SMS.config.karmaAntiFarm
    const id = entityId(victim)
    if (!id) return
    if (alreadyPaid(attacker, 'hurt', id, cfg.hurtEntityTicks, cfg.entityMemoryMax)) return

    const r = global.SMS.award(attacker, 'hurtPassive')
    if (!r) return
    console.info(`[Samsara] ${attacker.profile.name} struck ${victim.type}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// ---- Greed: taking what was not given -------------------------------------
//
// A container the player did not place is someone else's -- a village chest, a
// structure's loot, another player's storage. Opening it is the taking.
//
// Containers the player placed themselves are tracked so their own base does not
// charge them. That set is in memory only: on a server restart a player's own
// chests read as unknown and charge once each. Accepted deliberately -- persisting
// a placed-block set per player would grow NBT without bound, and the 20-minute
// window keeps the cost to a one-off trickle rather than a per-click drain.
const placedContainers = {}

// Position key for a BlockContainerJS.
//
// BlockContainerJS exposes getX/getY/getZ and getDimension directly (verified in
// the jar) -- there is no `.pos` bean to destructure, and no collision API at all.
// getDimension returns the dimension ResourceLocation, which is what makes this key
// unique across realms sharing coordinates (human and animal both use the
// Overworld, but naraka at 0,18,0 must not collide with it).
function containerPosKey(block) {
    try {
        var dim = '' + block.dimension
        return dim + ':' + block.x + ',' + block.y + ',' + block.z
    } catch (ignored) {
        return null
    }
}

BlockEvents.placed(event => {
    const placer = event.entity
    if (!placer || !placer.isPlayer()) return
    try {
        var id = '' + event.block.id
        var suffixes = global.SMS.config.containerBlockSuffixes
        var isContainer = false
        for (var i = 0; i < suffixes.length; i++) {
            if (id.endsWith(suffixes[i])) {
                isContainer = true
                break
            }
        }
        if (!isContainer) return
        var key = containerPosKey(event.block)
        if (key) placedContainers[key] = true
    } catch (ignored) {
        // cannot read the block; nothing to record
    }
})

// ChestEventJS.getBlock() is @Nullable -- verified in the jar. A chest opened
// through anything other than a world block (an ender chest, a mod's portable
// inventory, a minecart chest) has no block at all, so the null case is normal and
// must fail open rather than charge greed on a guess.
PlayerEvents.chestOpened(event => {
    const player = event.player
    if (!player) return

    var posKey = null
    try {
        var block = event.block
        if (!block) return
        posKey = containerPosKey(block)
    } catch (ignored) {
        // No readable position: cannot tell whose container this is, so charging
        // would be a guess. Fail open.
        return
    }
    if (!posKey) return

    // Their own container.
    if (placedContainers[posKey]) return

    const cfg = global.SMS.config.karmaAntiFarm
    if (alreadyPaid(player, 'container', posKey, cfg.containerPositionTicks, cfg.plantMemoryMax)) return

    const r = global.SMS.award(player, 'lootContainer')
    if (!r) return
    console.info(`[Samsara] ${player.profile.name} opened a container they did not place: +${r.amount} ${r.stat} -> ${r.total}`)
})

// net.minecraft.world.phys.AABB, loaded once at script load.
//
// getEntitiesWithin requires a real AABB (jar signature:
// kjs$getEntitiesWithin(Lnet/minecraft/world/phys/AABB;)) and KubeJS 6 ships NO
// AABB binding -- dev/latvian/mods/kubejs/bindings/ has BlockWrapper, ItemWrapper,
// TextWrapper, KMath and friends, but nothing for AABB. So `AABB.of(...)` does not
// exist and Java.loadClass is the only route.
//
// Loaded at load time rather than per-call: Java.loadClass is not free, and the
// broken-block hook can fire many times a second while a player mines.
var AABBClass = null
try {
    AABBClass = Java.loadClass('net.minecraft.world.phys.AABB')
} catch (e) {
    console.warn(`[Samsara] could not load AABB; village-block greed is disabled: ${e}`)
}

// Destroying a village's infrastructure. Charged only when a villager is actually
// nearby, so dismantling an abandoned structure is free.
BlockEvents.broken(event => {
    const breaker = event.entity
    if (!breaker || !breaker.isPlayer()) return

    const cfg = global.SMS.config
    var id = ''
    try {
        id = '' + event.block.id
    } catch (ignored) {
        return
    }
    if (cfg.villagerBlocks.indexOf(id) === -1) return

    if (!AABBClass) return

    // Is a villager watching?
    //
    // BlockContainerJS has NO collision API and no bounding box -- verified in the
    // jar, and noted in the project notes. The search box is therefore built from the
    // block's own x/y/z, which it DOES expose (getX/getY/getZ, confirmed in the
    // jar), using the 6-double AABB constructor.
    //
    // getEntitiesWithin returns a Java List (EntityArrayList), not a JS array:
    // Java 21's getFirst() is NOT available on it under Rhino, so use size()/get(i).
    var villagerNear = false
    try {
        // NOT named `r`: the award result below is `const r`, and Rhino scopes
        // const per FUNCTION, so a `var r` anywhere in this handler collides with
        // it. Node caught this as "Identifier 'r' has already been declared";
        // in Rhino it would have been a runtime "redeclaration of var".
        var rad = cfg.villagerBlockRadius
        var bx = event.block.x
        var by = event.block.y
        var bz = event.block.z
        var box = new AABBClass(bx - rad, by - rad, bz - rad, bx + rad + 1, by + rad + 1, bz + rad + 1)
        var near = event.level.getEntitiesWithin(box)
        for (var i = 0; i < near.size(); i++) {
            var e = near.get(i)
            if (cfg.villagerLikeEntities.indexOf('' + e.type) !== -1) {
                villagerNear = true
                break
            }
        }
    } catch (e2) {
        // Cannot determine proximity: do not charge on a guess.
        console.warn(`[Samsara] villager-proximity check failed: ${e2}`)
        return
    }
    if (!villagerNear) return

    const r = global.SMS.award(breaker, 'breakVillagerBlock')
    if (!r) return
    console.info(`[Samsara] ${breaker.profile.name} broke village block ${id}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// ---- Metta: goodwill toward beings ----------------------------------------

// Planting a crop: tending life rather than taking it.
//
// ANTI-FARM. Without a uniqueness check, breaking and replanting the SAME seed in
// the SAME block paid every time, and click speed trivially outruns passive decay.
BlockEvents.placed(event => {
    const placer = event.entity
    if (!placer || !placer.isPlayer()) return
    if (!global.SMS.config.cropBlocks.includes(event.block.id)) return

    // An animal-born player cannot place blocks at all (samsara_realms.js cancels
    // this same event). Handler order between files is not guaranteed, so check here
    // too rather than award metta for a placement that gets cancelled.
    if (blockedByAnimalRealm(placer, 'noBlockPlacing')) return

    const cfg = global.SMS.config.karmaAntiFarm
    try {
        var p = event.block.pos
        var id = p.x + ',' + p.y + ',' + p.z
        if (alreadyPaid(placer, 'plant', id, cfg.plantPositionTicks, cfg.plantMemoryMax)) return
    } catch (ignored) {
        // cannot read the position: fall through and award (fail open, once)
    }

    const r = global.SMS.award(placer, 'plantCrop')
    if (!r) return
    console.info(`[Samsara] ${placer.profile.name} planted ${event.block.id}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// Feeding and taming, both through ItemEvents.entityInteracted.
//
// Verified present in this build: ItemEntityInteractedEventJS exposes player,
// entity (getTarget), hand and getItem.
//
// Taming is detected as "this animal had no Owner before the interaction and has
// one after". The NBT is read on the next tick because the tame happens during
// vanilla's own handling of the interaction, after this event fires.
ItemEvents.entityInteracted(event => {
    // CAREFUL: on THIS event, `entity` is the PLAYER and `target` is the animal.
    //
    // ItemEntityInteractedEventJS extends PlayerEventJS, so it inherits
    // getEntity() -> the player ("The player that interacted with the entity"), and
    // adds getTarget() -> "The entity that was interacted with". Both strings are in
    // the jar verbatim.
    //
    // This is the OPPOSITE of every other handler in this file, where event.entity
    // is the mob (EntityEvents.death/hurt) or the actor (BlockEvents.placed/broken).
    // Reading event.entity as the animal here made target.isAnimal() false for a
    // player, so the handler returned immediately and neither taming nor feeding
    // ever awarded metta -- silently, with no error in the log.
    const player = event.player
    const target = event.target
    if (!player || !target) return

    // isAnimal() maps to vanilla's Animal type. A WOLF is a TamableAnimal, which
    // extends Animal, so it should pass -- but `isAnimal`'s implementation could not
    // be located in the jar (it is an interface method with no findable mixin body),
    // so its exact semantics here are UNVERIFIED. Rather than gate taming on an
    // unverified predicate and fail closed again, the check is diagnostic: if it
    // says no, log that fact and carry on to the explicit tameable list below.
    var saysAnimal = false
    try {
        saysAnimal = target.isAnimal() === true
    } catch (ignored) {
        saysAnimal = false
    }

    // Explicit tameable list, independent of isAnimal(). These are the vanilla mobs
    // that can gain an Owner, so they are the ones taming can ever apply to.
    const TAMEABLE = [
        'minecraft:wolf',
        'minecraft:cat',
        'minecraft:ocelot',
        'minecraft:parrot',
        'minecraft:horse',
        'minecraft:donkey',
        'minecraft:mule',
        'minecraft:skeleton_horse',
        'minecraft:zombie_horse',
        'minecraft:llama',
        'minecraft:trader_llama',
        'minecraft:camel',
        'minecraft:sniffer',
        'minecraft:axolotl',
        'minecraft:fox',
    ]
    var targetType = ''
    try {
        targetType = '' + target.type
    } catch (ignored) {
        targetType = ''
    }
    const isTameable = TAMEABLE.indexOf(targetType) !== -1

    if (!saysAnimal && !isTameable) return

    if (!saysAnimal && isTameable) {
        // Worth knowing: it means isAnimal() does NOT cover tameables in this build,
        // and the explicit list is doing the work.
        console.info(`[Samsara] note: isAnimal() returned false for ${targetType} (using tameable list)`)
    }

    // An unreadable or empty hand must NOT abort the handler: a horse is tamed by
    // right-clicking it with an EMPTY hand, so returning here would make horses
    // untameable for karma purposes. Default to '' and let the food check below
    // simply find no match.
    var heldId = ''
    try {
        heldId = '' + event.item.id
    } catch (ignored) {
        heldId = ''
    }

    const cfg = global.SMS.config
    const farm = cfg.karmaAntiFarm
    const id = entityId(target)
    if (!id) return

    // Taming: did this interaction give the animal an owner?
    const hadOwner = isBondedAnimal(target)

    // Is the held item animal food?
    var isFood = false
    for (var i = 0; i < cfg.animalFoodSuffixes.length; i++) {
        if (heldId.endsWith(cfg.animalFoodSuffixes[i])) {
            isFood = true
            break
        }
    }

    // TAMING. The tame happens inside vanilla's handling of this interaction, which
    // runs AFTER this event, so the Owner NBT is not set yet and cannot be read here.
    //
    // NOT done with scheduleInTicks. That method lives on MinecraftEnvironmentKJS
    // with signature (J, ScheduledEvents$Callback) -- a Java `long` plus a functional
    // interface, and the project notes record both as Rhino traps: longs do not coerce
    // (trap 4) and arrow functions are NOT coerced into Java functional interfaces
    // (trap 3, which stringifies the lambda). It would have failed silently.
    //
    // Instead the candidate is queued and checked by the tick handler below, using
    // the pure-JS tick clock this project already maintains.
    // Only queue mobs that can actually BE tamed, so right-clicking a cow with
    // wheat does not add a pointless entry (and a pointless log line) every time.
    if (!hadOwner && isTameable) {
        global.SMS.pendingTames.push({
            playerUuid: playerKey(player),
            player: player,
            target: target,
            entityId: id,
            at: global.SMS.tickClock || 0,
        })
    }

    // Feeding: only pays for actual food, and only once per animal per window.
    // Breeding already pays separately via breedAnimal, so without the window a
    // stack of wheat would be a merit vending machine.
    if (!isFood) return
    if (alreadyPaid(player, 'feed', id, farm.feedEntityTicks, farm.entityMemoryMax)) return

    const r = global.SMS.award(player, 'feedAnimal')
    if (!r) return
    console.info(`[Samsara] ${player.profile.name} fed ${target.type}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// Pending tame checks, drained by the tick handler below.
//
// On global.SMS so it survives /reload rather than orphaning in-flight entries.
global.SMS.pendingTames = global.SMS.pendingTames || []

// Resolve queued tame candidates a few ticks after the interaction.
//
// An animal gets its Owner NBT during vanilla's handling of the right-click, after
// ItemEvents.entityInteracted has already run. Waiting a couple of ticks and then
// re-reading the NBT is what turns "player right-clicked a wolf with a bone" into
// "the wolf is now owned", which is the only reliable tame signal available --
// there is no tame event and no isTamed() on EntityKJS in this build.
// 10 ticks (half a second), not 2. The tame is applied during vanilla's handling of
// the interaction, so 2 ticks is usually enough -- but a wolf tame also triggers
// particles, a sound, and a goal-selector rebuild, and leaving a wider margin costs
// nothing (the queue is empty the rest of the time). Taming is probabilistic, so
// most bone throws genuinely fail and will log "not owned"; that is expected.
const TAME_CHECK_DELAY = 10
const TAME_QUEUE_MAX = 64

ServerEvents.tick(event => {
    const queue = global.SMS.pendingTames
    if (!queue || queue.length === 0) return

    const now = global.SMS.tickClock || 0
    const farm = global.SMS.config.karmaAntiFarm

    // Walk backwards so splicing does not skip entries.
    for (var i = queue.length - 1; i >= 0; i--) {
        var q = queue[i]

        // A negative age means the tick clock restarted (server restart); drop it
        // rather than keeping it forever.
        var age = now - q.at
        if (age < 0) {
            queue.splice(i, 1)
            continue
        }
        if (age < TAME_CHECK_DELAY) continue

        queue.splice(i, 1)

        try {
            if (!isBondedAnimal(q.target)) {
                // Not tamed, which is the NORMAL case: taming is probabilistic, so
                // most bone throws fail. Verified in game on 2026-10-18 -- an
                // untamed wolf has no `Owner` key at all (contains(Owner)=false),
                // and the key appears only once the tame actually lands.
                //
                // Deliberately NOT logged. This fires on every failed attempt, and
                // the full-NBT dump that proved the behaviour was ~300 chars per
                // line. Set config.debugTameChecks true to bring it back when
                // investigating a taming problem.
                if (global.SMS.config.debugTameChecks) {
                    console.info(
                        `[Samsara] tame check: ${q.target.type} not owned after ${age} ticks` +
                            ` -- ${describeTameNbt(q.target)}`
                    )
                }
                continue
            }

            // Pays once per animal, EVER: an animal can only be tamed once, so the
            // window is effectively infinite.
            if (alreadyPaid(q.player, 'tame', q.entityId, 2147483647, farm.entityMemoryMax)) continue

            var tr = global.SMS.award(q.player, 'tameAnimal')
            if (!tr) continue
            console.info(
                `[Samsara] ${q.player.profile.name} tamed ${q.target.type}:` +
                    ` +${tr.amount} ${tr.stat} -> ${tr.total}`
            )
        } catch (ignored) {
            // Entity despawned, player logged out, or NBT unreadable. Nothing to award.
        }
    }

    // Safety valve: if something ever stops draining this, do not grow without bound.
    if (queue.length > TAME_QUEUE_MAX) queue.splice(0, queue.length - TAME_QUEUE_MAX)
})

// ---- Generosity: breeding -------------------------------------------------

// Breeding proxy: reward when a baby animal appears near a player.
//
// KubeJS 6 has no dedicated breed event, so this approximates it. Two bugs had to
// be fixed here, and together they meant the proxy awarded nothing at all:
//
//   1. `isBaby()` DOES NOT EXIST anywhere in the jar. The call threw, the
//      surrounding catch returned, and the handler exited every single time.
//      Age is readable through NBT instead.
//
//   2. EntityEvents.spawned FIRES ON CHUNK LOAD. Its own javadoc says "This event
//      also fires for existing entities when they are loaded from a save." So every
//      pass over a farm re-awarded generosity for the same animals. Each animal is
//      now marked once in its own persistent data, so a given baby pays out once.
EntityEvents.spawned(event => {
    if (!global.SMS.config.breedingProxyEnabled) return
    const baby = event.entity
    if (!baby) return

    try {
        if (!baby.isAnimal()) return
    } catch (ignored) {
        return
    }

    if (!isBabyAnimal(baby)) return

    // Pay out at most once per animal, EVER. Without this, chunk reloads re-award.
    const MARK = 'samsara_counted'
    try {
        var pd = baby.persistentData
        if (pd.getBoolean(MARK)) return
        pd.putBoolean(MARK, true)
    } catch (ignored) {
        // Cannot mark it, so cannot guarantee once-only. Skip rather than risk a farm.
        return
    }

    // NOTE: this is a Java List (EntityArrayList), not a JS array. Java 21's
    // getFirst() is NOT available on it under Rhino. Use size()/get(0).
    var players = null
    try {
        players = baby.level.getEntitiesWithin(baby.boundingBox.inflate(16)).filter(e => e.isPlayer())
    } catch (ignored) {
        return
    }
    if (!players || players.size() === 0) return
    const parent = players.get(0)

    const r = global.SMS.award(parent, 'breedAnimal')
    if (!r) return
    console.info(`[Samsara] baby ${baby.type} near ${parent.profile.name}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// ---- Delusion: heedlessness ----------------------------------------------
//
// Dying with nobody to blame is moha -- walking into lava, falling off a cliff,
// drowning. The karma is the carelessness, not the death.
//
// This registers a SECOND EntityEvents.death handler on purpose: the kill handler
// above returns early for players, and keeping the two concerns separate is clearer
// than one branching handler.
//
// Repeat deaths inside the ripening cooldown charge more: the first careless death
// is an accident, the fifth in five minutes is a pattern. The streak counter is the
// same one ripening uses, read BEFORE ripening updates it (handler order within the
// same event is registration order, and samsara_karma.js loads before
// samsara_rebirth.js alphabetically).
EntityEvents.death(event => {
    const player = event.entity
    if (!player || !player.isPlayer()) return

    // Was anyone responsible? If a mob or player killed them, this is not
    // carelessness -- it is the ordinary risk of the world.
    var killer = null
    try {
        killer = global.SMS.resolveKiller(event.source)
    } catch (ignored) {
        killer = null
    }
    if (killer) return

    // Any living attacker at all (a mob, not just a player) also rules out
    // carelessness.
    try {
        var actual = event.source.actual
        if (actual && actual.isLiving()) return
    } catch (ignored) {
        // no attacker; genuinely environmental
    }

    const nbt = global.SMS.config.nbt
    const rip = global.SMS.config.ripening
    const tag = global.SMS.persistedTag(player)
    const now = global.SMS.tickClock || 0

    // Is this a repeat inside the rapid-death window?
    var act = 'carelessDeath'
    try {
        var last = Number(tag.getDouble(nbt.lastDeathTick))
        var ever = tag.getBoolean(nbt.everDied)
        var since = now - last
        if (ever && since >= 0 && since < rip.cooldownTicks) act = 'repeatDeath'
    } catch (ignored) {
        act = 'carelessDeath'
    }

    const r = global.SMS.award(player, act)
    if (!r) return
    console.info(`[Samsara] ${player.profile.name} died carelessly (${act}): +${r.amount} ${r.stat} -> ${r.total}`)
})

console.info('[Samsara] karma hooks registered')

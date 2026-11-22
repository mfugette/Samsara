// priority: 50
// Samsara — Three Poisons / Three Antidotes: storage, rebirth routing, and the
// events that change karma.
//
// PRIORITY 50: this file's death handlers (endurance, delusion) must run BEFORE
// samsara_rebirth.js's route + ripen (priority 40), because they read the PREVIOUS
// death that ripening is about to overwrite. KubeJS 7 orders files by
// `// priority: N` (higher first), then path -- not by file name alone.
//
// Storage: stats are kept in a "PlayerPersisted" sub-tag of player.persistentData.
// On KubeJS 7 persistentData is KubeJS's OWN tag (saved as KubeJSPersistentData in
// the entity NBT), and KubeJS copies the whole tag to the new player on every clone
// -- death and End return alike -- so values survive death and relog. The sub-tag
// is kept for continuity: it was what Forge copied on 1.20.1, and every key, the
// harness and the migrations already live under it. Inspect it in game with
// /data get entity @s KubeJSPersistentData.PlayerPersisted
//
// Stats are NON-NEGATIVE and capped at config.statCap. Routing works entirely on
// SHARES of the total, so the absolute scale never matters -- only the balance.

const PERSISTED = 'PlayerPersisted'

// Returns the live PlayerPersisted CompoundTag, creating it if missing.
// getCompound() returns the live nested tag when present, or a fresh empty one when
// absent; putting it back stores that reference so later writes persist. Never write
// Samsara keys into player.forgePersistentData (NeoForge's tag): two stores, two truths.
global.SMS.persistedTag = player => {
    const root = player.persistentData
    const sub = root.getCompound(PERSISTED)
    root.put(PERSISTED, sub)
    return sub
}

// ---- Stat storage ----------------------------------------------------------

const statKey = stat => global.SMS.config.nbt.statPrefix + stat

// Strip float noise (config.storePrecision) before a write.
//
// THIS IS NOT A GRAIN. The old seam rounded every write to 0.05, which silently
// swallowed any change under 0.025 -- it killed passive decay outright. This only
// removes binary-float residue (0.1 + 0.2 = 0.30000000000000004) so a stat cannot
// sit a hair under a threshold; at 1e-6 it is a million times finer than the
// smallest award and can never eat a real change. Rounds via an integer inverse,
// because dividing by 1e-6 reintroduces the very residue it exists to remove.
global.SMS.roundStore = value => {
    const prec = global.SMS.config.storePrecision
    if (!prec || prec <= 0) return value
    const inv = Math.round(1 / prec)
    return Math.round(value * inv) / inv
}

global.SMS.getStat = (player, stat) => global.SMS.persistedTag(player).getDouble(statKey(stat))

// Clamp to [0, statCap] (an overflow ceiling, not a design cap), round, store.
global.SMS.setStat = (player, stat, value) => {
    const cap = global.SMS.config.statCap
    var v = Number(value)
    if (!isFinite(v)) v = 0
    if (v < 0) v = 0
    if (v > cap) v = cap
    v = global.SMS.roundStore(v)
    global.SMS.persistedTag(player).putDouble(statKey(stat), v)
    return v
}

global.SMS.addStat = (player, stat, delta) =>
    global.SMS.setStat(player, stat, global.SMS.getStat(player, stat) + delta)

// ---- Combat hatred: the part of hatred that came from hostile kills -----------
//
// Counted in hatred like any other, but routing ignores it when deciding asura and
// WHICH lower realm a life falls to (config.hostileKillTiers explains why). Always
// read clamped to hatred: an admin `/karma set <p> hatred 0`, or ripening, must
// never leave a sub-count larger than the stat it is part of.
global.SMS.getCombatHatred = player => {
    var c = Number(global.SMS.persistedTag(player).getDouble(global.SMS.config.nbt.hatredCombat))
    if (!isFinite(c) || c < 0) c = 0
    var h = Number(global.SMS.getStat(player, 'hatred'))
    return c > h ? h : c
}

global.SMS.setCombatHatred = (player, value) => {
    var v = Number(value)
    if (!isFinite(v) || v < 0) v = 0
    var h = Number(global.SMS.getStat(player, 'hatred'))
    if (v > h) v = h
    v = global.SMS.roundStore(v)
    global.SMS.persistedTag(player).putDouble(global.SMS.config.nbt.hatredCombat, v)
    return v
}

global.SMS.addCombatHatred = (player, delta) =>
    global.SMS.setCombatHatred(player, global.SMS.getCombatHatred(player) + delta)

// All six stats as a plain object, plus `hatredCombat` (part of hatred, not a
// seventh stat -- derive() sums POISONS/ANTIDOTES only, so it never double-counts).
//
// Runs the migrations first if this player has not had them. They normally run at
// login, but a player who is online across a /reload never logs in again, and
// without this their old-scale stats would mix with new-unit awards.
global.SMS.getStats = player => {
    global.SMS.ensureMigrated(player)
    const out = {}
    const stats = global.SMS.STATS
    for (let i = 0; i < stats.length; i++) {
        out[stats[i]] = global.SMS.getStat(player, stats[i])
    }
    out.hatredCombat = global.SMS.getCombatHatred(player)
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

// 1.21.1: no save carries pre-v3 data (the realms need a new world), so on this
// version the three migrations find nothing, set their flags and log nothing. Kept
// for the harness and as a record of the scale history.

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

// v3: the 0..10 scale in 0.05 steps -> exact UNITS (one unit = striking an animal
// once). Every old award value was a tenth of its new one (killHostile 0.1 -> 1,
// killPassive 0.25 -> ~3), so x10 maps an old ledger onto the new scale with its
// balance intact -- routing reads shares, so the verdict does not move.
//
// The per-life endurance total was stored in old units; it is zeroed rather than
// rescaled, which can cost at most one life's endurance cap. The combat sub-count
// did not exist before v3, so existing hatred is all treated as non-combat.
function migrateToUnits(player) {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    if (tag.getBoolean(nbt.migratedV3)) return

    const factor = 10
    const stats = global.SMS.STATS
    var touched = false
    for (var i = 0; i < stats.length; i++) {
        var raw = tag.getDouble(statKey(stats[i]))
        if (raw > 0) {
            global.SMS.setStat(player, stats[i], raw * factor)
            touched = true
        }
    }
    tag.putDouble(nbt.lifeEndured, 0)
    tag.putBoolean(nbt.migratedV3, true)

    if (touched) console.info(`[Samsara] v3 migration: rescaled x${factor} to units for ${player.profile.name}`)
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
    try {
        migrateToUnits(player)
    } catch (e) {
        console.warn(`[Samsara] v3 migration failed: ${e}`)
    }
}

// Cheap guard: one boolean read once migrated. See getStats for why it exists.
global.SMS.ensureMigrated = player => {
    try {
        if (global.SMS.persistedTag(player).getBoolean(global.SMS.config.nbt.migratedV3)) return
    } catch (ignored) {
        return
    }
    global.SMS.migrateKarma(player)
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

// The poisons as routing JUDGES them: hatred minus its combat sub-count. Used to
// decide which lower realm a life falls to, and whether hatred makes an asura.
// P and Net still use the full hatred (derive), so combat counts toward the floor.
global.SMS.judgedPoisons = stats => {
    var hatred = Number(stats.hatred) || 0
    var combat = Number(stats.hatredCombat) || 0
    if (combat > hatred) combat = hatred
    if (combat < 0) combat = 0
    return {
        greed: Number(stats.greed) || 0,
        hatred: hatred - combat,
        delusion: Number(stats.delusion) || 0,
    }
}

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
    const judged = global.SMS.judgedPoisons(stats)

    // Rule 0. Not enough karma to judge a life by. This is what stops a new
    // player's first kill from deciding their next birth: one hostile gives
    // P = 1, A = 0, net = 0.0, which would otherwise route to a lower realm.
    if (d.total < cfg.minTotal) {
        return { realm: 'human', rule: `minTotal (total ${fmt(d.total)} < ${cfg.minTotal})` }
    }

    // Rule 2. The poisons outweigh the antidotes AND carry real weight: the player
    // falls, and the dominant poison decides where. Under lowerMinPoison a
    // poison-led life falls through to rule 5 (human): rules 3 and 4 need Net of at
    // least 0.50, so they cannot match here.
    if (d.net < cfg.lowerNet && d.P < (cfg.lowerMinPoison || 0)) {
        return {
            realm: 'human',
            rule: `human (net ${fmt(d.net)} < ${cfg.lowerNet}, but poison ${fmt(d.P)} < lowerMinPoison ${cfg.lowerMinPoison})`,
        }
    }
    if (d.net < cfg.lowerNet) {
        // `var`, not `const`: Rhino scopes const/let per FUNCTION, not per block, so
        // a const inside a nested block throws "redeclaration of var" the SECOND
        // time that block runs. This has cost this project three debugging rounds --
        // see the project notes. Inside any try/if/loop body, use var.
        //
        // WHICH realm is decided without combat hatred (config.hostileKillTiers): a
        // greedy or careless life should read as greed or delusion, not as whatever
        // the zombie count happened to be when the floor was crossed. If combat
        // hatred is the ONLY poison, it still means hatred.
        var judgedSum = judged.greed + judged.hatred + judged.delusion
        var lead = judgedSum > 0 ? global.SMS.dominantOf(judged, global.SMS.POISONS) : 'hatred'
        var realm = lead === 'hatred' ? 'naraka' : lead === 'greed' ? 'preta' : 'animal'
        var why = judgedSum > 0 ? `${lead} leads` : 'only combat hatred'
        return { realm: realm, rule: `lower (net ${fmt(d.net)} < ${cfg.lowerNet}, poison ${fmt(d.P)}, ${why})` }
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
    //
    // Both gates read NON-COMBAT hatred: a gentle player who fights zombies is not
    // "merit corrupted by aggression". Asuras are defined by rivalry and envy.
    if (d.net >= cfg.asuraNet && d.P > 0) {
        var leadP = global.SMS.dominantOf(judged, global.SMS.POISONS)
        var hatredShare = d.total > 0 ? judged.hatred / d.total : 0
        if (judged.hatred > 0 && leadP === 'hatred' && hatredShare >= cfg.asuraHatredShare) {
            return {
                realm: 'asura',
                rule: `asura (net ${fmt(d.net)} >= ${cfg.asuraNet}, non-combat hatred leads, share ${fmt(hatredShare)} >= ${cfg.asuraHatredShare})`,
            }
        }
    }

    // Rule 5. Everything else, including a high-net player with strong wisdom.
    //
    // That is a DESIGN CHOICE with doctrinal support, not a canonical rule: the
    // source lists "virtue and wisdom development" for human rebirth, but wise lay
    // followers are also reborn as devas (Anathapindika, a stream-enterer, in Tusita:
    // MN 143). Keeping the wise human is what keeps liberation, reachable only from
    // the human realm, within reach.
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

// Map a realm name to a dimension id: config.realmDimensions, Samsara's own
// dimensions. No third-party overrides (removed 2026-10-19 with those mods).
//
// `stats` and `server` are unused now but kept so the five callers need not change;
// tiering inside a realm will want the stats again (design doc 3 / 7.6).
global.SMS.dimensionForRealm = (realm, stats, server) => {
    const cfg = global.SMS.config
    // Coerce before indexing: a Java String (or any non-primitive) would miss every
    // JS key here and silently fall back to the human dimension.
    var realmKey = realm ? '' + realm : ''
    return cfg.realmDimensions[realmKey] || cfg.realmDimensions.human
}

// ---- The animal body: its diet follows the karma --------------------------------
//
// Which creature an animal birth is drawn as (config.animalBirth). Worse karma, a
// carnivore: the diet is the first tier whose minNet <= Net, tiers listed gentlest
// first. Pure -- no player, no world -- so the same numbers that routed the birth
// decide it, and the harness can pin the boundaries. `seed` (any string) picks the
// creature inside the tier; the same seed always gives the same creature.
//
// Returns { diet, form }, or null when no tier has a creature for this Net.
//
// codePointAt, NEVER charCodeAt (N12): on Rhino 2101 charCodeAt returns a raw
// java.lang.Character, so `h * 31 + s.charCodeAt(i)` is NaN -- and even `typeof` on it
// throws. That made every index NaN and gave every animal birth an undefined body in
// the first in-game test (2026-10-22). Probed against the installed Rhino jar:
// codePointAt returns a number. Node returns a number for both, so only the harness
// lint can catch a charCodeAt offline.
function animalSeedIndex(seed, n) {
    var h = 7
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.codePointAt(i)) % 2147483647
    return h % n
}

global.SMS.animalFormFor = (stats, seed) => {
    const tiers = (global.SMS.config.animalBirth || {}).tiers || []
    const net = global.SMS.derive(stats).net
    for (var i = 0; i < tiers.length; i++) {
        var tier = tiers[i]
        if (net >= tier.minNet && tier.forms.length > 0) {
            return { diet: tier.diet, form: tier.forms[animalSeedIndex('' + seed, tier.forms.length)] }
        }
    }
    return null
}

// The diet of a configured creature, or null for anything not in a tier -- which is
// also how a stored body that has since been removed from the config is recognised.
global.SMS.animalDietOf = form => {
    const key = form ? '' + form : ''
    const tiers = (global.SMS.config.animalBirth || {}).tiers || []
    for (var i = 0; i < tiers.length; i++) {
        if (tiers[i].forms.indexOf(key) !== -1) return tiers[i].diet
    }
    return null
}

// ---- Victim classification -------------------------------------------------

// villager | hostile | passive.
//
// The KubeJS helpers are MobCategory tests (read from the jar, identical in KubeJS 6
// and 7): isMonster() is true only for MONSTER; isAnimal() for CREATURE *and* MISC --
// villagers, golems, players; isWaterCreature / isAmbientCreature for their own
// categories. Category alone puts some mobs on the wrong side for this mod:
//
//   - IRON GOLEM and WANDERING TRADER are MISC, so isAnimal() calls them animals.
//     They are beings a player lives alongside, so the villager list claims them.
//   - Hoglins, slimes and bosses are listed hostile so the verdict never depends on
//     a modded category change.
//
// Explicit config lists are checked FIRST, then isMonster(), then the KubeJS animal
// helpers, and only then the passive default. A modded mob with an unusual category
// (an Alex's Mobs predator in CREATURE, say) therefore classifies as passive.
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
// Read from the NBT: vanilla stores an `Owner` UUID on tameable mobs and
// `CustomName` on named ones. On 1.21.1 vanilla isTame() is callable too, but only
// on TamableAnimal -- horses are AbstractHorse, with isTamed() instead -- and both
// families save `Owner`, so the NBT test covers every tameable mob in one place.
// IMPORTANT -- `Owner` IS NOT A STRING (1.20.1 and 1.21.1 alike).
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

// Is this a baby? Vanilla keeps a negative `Age` on young animals. getDouble reads
// that INT tag correctly (CompoundTag.getDouble accepts any numeric tag -- read from
// the jar). Vanilla isBaby() is callable on 1.21.1 as well; the NBT read is kept
// because it is the path the harness and the 1.20.1 tests verified.
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
// IMPORTANT (KubeJS 6 and 7 / Rhino): these are Java bean properties injected by
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

// An animal-born player's own killing is free (config.animalBirth.freeActs).
function freeForAnimal(player, act) {
    const free = (global.SMS.config.animalBirth || {}).freeActs || []
    if (free.indexOf(act) === -1) return false
    try {
        return global.SMS.birthRealmOf(player) === 'animal'
    } catch (ignored) {
        return false
    }
}

// Award an act by name, reading both its value and its target stat from config.
// `amountOverride` replaces the configured value (hostile kills use it for their
// per-life tiers); the stat always comes from config.
//
// The animal exemption is checked HERE, at the one seam every hook goes through, so
// no hook can forget it. It returns null like any unpaid act, which every caller
// already reads as "nothing happened".
global.SMS.award = (player, act, amountOverride) => {
    const cfg = global.SMS.config
    const amount = amountOverride !== undefined ? amountOverride : cfg.karma[act]
    const stat = cfg.karmaStat[act]
    if (amount === undefined || !stat) {
        console.warn(`[Samsara] unknown karma act '${act}'`)
        return null
    }
    if (freeForAnimal(player, act)) {
        console.info(`[Samsara] ${player.profile.name}: ${act} is free (born animal)`)
        return null
    }
    global.SMS.ensureMigrated(player)
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

// ---- Hatred: killing ------------------------------------------------------

// The hatred a hostile kill adds, per config.hostileKillTiers, counting this kill.
// Increments the per-life counter, so call it once per kill. 0 past the last tier.
global.SMS.hostileKillAmount = player => {
    const cfg = global.SMS.config
    const tag = global.SMS.persistedTag(player)
    var n = Number(tag.getDouble(cfg.nbt.lifeHostileKills))
    if (!isFinite(n) || n < 0) n = 0
    n = n + 1
    tag.putDouble(cfg.nbt.lifeHostileKills, n)
    var tiers = cfg.hostileKillTiers || []
    for (var i = 0; i < tiers.length; i++) {
        if (n <= tiers[i].upTo) return tiers[i].value
    }
    return 0
}

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

    // Hostile kills fall off within a life (config.hostileKillTiers).
    var amount = undefined
    if (act === 'killHostile') {
        amount = global.SMS.hostileKillAmount(killer)
        if (amount <= 0) return // past the per-life tiers: no further hatred this life
    }

    const r = global.SMS.award(killer, act, amount)
    if (!r) return
    // Combat hatred: counted in hatred, ignored for asura and lower-realm choice.
    if (act === 'killHostile') global.SMS.addCombatHatred(killer, r.amount)
    console.info(
        `[Samsara] ${killer.profile.name} killed ${victim.type} (${kind}/${act}):` +
            ` +${r.amount} ${r.stat} -> ${r.total}`
    )
})

// Hurting a peaceful mob and leaving it alive still grows hatred -- the intention
// was there. Guarded per entity so a single cow cannot be farmed by repeated hits.
//
// Called from the ONE damage hook (global.SMS.onIncomingDamage, under endurance
// below), which sees every swing at its raw damage, as 1.20.1's EntityEvents.hurt
// did. KubeJS 7 has no EntityEvents.hurt -- and calling a missing event name throws
// at load, which aborts the REST OF THIS FILE: every handler registered after it
// would silently not exist.
function hurtPassiveFrom(victim, source) {
    if (!victim || !victim.isLiving() || victim.isPlayer()) return

    const attacker = global.SMS.resolveKiller(source)
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
}

// ---- Greed: taking what was not given -------------------------------------
//
// Taking what is not given needs an OWNER who did not give it. So opening a
// container charges greed only when it belongs to someone:
//   - another player placed it (tracked below), or
//   - it sits in a living village (a villager within villagerBlockRadius).
// Dungeon, ruin and structure loot belongs to no one and is free.
//
// Placements are tracked in memory, keyed by position, valued by the PLACER. On a
// server restart that map is empty: a player's own chest then reads as unknown,
// which is free unless it stands in a village. Known limit: a co-op friend's chest
// charges greed, because shared permission is not detectable.
const placedContainers = {}

// net.minecraft.world.phys.AABB, loaded once at script load.
//
// getEntitiesWithin requires a real AABB (jar signature:
// kjs$getEntitiesWithin(Lnet/minecraft/world/phys/AABB;)). KubeJS 6 shipped no AABB
// binding, so Java.loadClass was the only route; KubeJS 7 adds `AABB.of(...)`, but
// the loaded class works on both and is what the harness models.
//
// Loaded at load time rather than per-call: Java.loadClass is not free, and the
// broken-block hook can fire many times a second while a player mines.
var AABBClass = null
try {
    AABBClass = Java.loadClass('net.minecraft.world.phys.AABB')
} catch (e) {
    console.warn(`[Samsara] could not load AABB; village-block greed is disabled: ${e}`)
}

// Is a villager-class being within villagerBlockRadius of x/y/z?
// Returns null when it cannot tell, so callers can decline to charge on a guess.
//
// The block wrapper (BlockContainerJS on KubeJS 6, LevelBlock on 7) has no bounding
// box -- verified in both jars.
// The search box is built from the block's own x/y/z with the 6-double AABB
// constructor. getEntitiesWithin returns a Java List (EntityArrayList), not a JS
// array: Java 21's getFirst() is NOT available on it under Rhino, so size()/get(i).
function villagerNear(level, x, y, z) {
    if (!AABBClass || !level) return null
    const cfg = global.SMS.config
    try {
        var rad = cfg.villagerBlockRadius
        var box = new AABBClass(x - rad, y - rad, z - rad, x + rad + 1, y + rad + 1, z + rad + 1)
        var near = level.getEntitiesWithin(box)
        for (var i = 0; i < near.size(); i++) {
            if (cfg.villagerLikeEntities.indexOf('' + near.get(i).type) !== -1) return true
        }
        return false
    } catch (e) {
        console.warn(`[Samsara] villager-proximity check failed: ${e}`)
        return null
    }
}

// Position key for a block wrapper (LevelBlock on KubeJS 7).
//
// It exposes getX/getY/getZ and getDimension directly (verified in both jars), so
// `block.dimension` / `.x` / `.y` / `.z` are beans; no collision API at all.
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
        if (key) placedContainers[key] = playerKey(placer)
    } catch (ignored) {
        // cannot read the block; nothing to record
    }
})

// The chest event's getBlock() is @Nullable -- verified in both jars. A chest opened
// through anything other than a world block (an ender chest, a mod's portable
// inventory, a minecart chest) has no block at all, so the null case is normal and
// must fail open rather than charge greed on a guess.
//
// KNOWN LIMIT (KubeJS 6 and 7 alike): chestOpened fires only for a ChestMenu, and
// getBlock() is non-null only when the menu's container is a block entity. Single
// chests and barrels charge; DOUBLE chests (a CompoundContainer), shulker boxes,
// hoppers and modded menus never do.
PlayerEvents.chestOpened(event => {
    const player = event.player
    if (!player) return

    var posKey = null
    var block = null
    try {
        block = event.block
        if (!block) return
        posKey = containerPosKey(block)
    } catch (ignored) {
        // No readable position: cannot tell whose container this is, so charging
        // would be a guess. Fail open.
        return
    }
    if (!posKey) return

    // Whose is it?
    var placer = placedContainers[posKey]
    if (placer === playerKey(player)) return // their own
    var owner = null
    if (placer) {
        owner = 'another player'
    } else {
        // Jar-verified: the block wrapper's getLevel().
        var village = null
        try {
            village = villagerNear(block.level, block.x, block.y, block.z)
        } catch (ignored) {
            village = null
        }
        if (village === true) owner = 'a village'
    }
    if (!owner) return // ownerless loot, or proximity unknown: nothing was stolen

    const cfg = global.SMS.config.karmaAntiFarm
    if (alreadyPaid(player, 'container', posKey, cfg.containerPositionTicks, cfg.containerMemoryMax)) return

    const r = global.SMS.award(player, 'lootContainer')
    if (!r) return
    console.info(`[Samsara] ${player.profile.name} opened ${owner}'s container: +${r.amount} ${r.stat} -> ${r.total}`)
})

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

    // Is a villager watching? null (cannot tell) is treated as no: never charge on
    // a guess.
    var watched = null
    try {
        watched = villagerNear(event.level, event.block.x, event.block.y, event.block.z)
    } catch (ignored) {
        watched = null
    }
    if (watched !== true) return

    const r = global.SMS.award(breaker, 'breakVillagerBlock')
    if (!r) return
    console.info(`[Samsara] ${breaker.profile.name} broke village block ${id}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// ---- Generosity: feeding animals -------------------------------------------

// Per-player feeding budget: at most feedPerPlayerMax paid feedings in any
// feedPerPlayerWindowTicks, across all animals. In memory; a restart forgives it.
global.SMS.feedLog = global.SMS.feedLog || {}

function feedRecent(player) {
    const farm = global.SMS.config.karmaAntiFarm
    const now = global.SMS.tickClock || 0
    const key = playerKey(player)
    var log = global.SMS.feedLog[key] || []
    var kept = []
    for (var i = 0; i < log.length; i++) {
        var age = now - log[i]
        if (age >= 0 && age < farm.feedPerPlayerWindowTicks) kept.push(log[i])
    }
    global.SMS.feedLog[key] = kept
    return kept
}

function feedRateOk(player) {
    return feedRecent(player).length < global.SMS.config.karmaAntiFarm.feedPerPlayerMax
}

function feedRateRecord(player) {
    feedRecent(player).push(global.SMS.tickClock || 0)
}
//
// Feeding is GIVING. AN 3.57: even throwing the rinsings of a bowl into a pool for
// the creatures living there "would be a source of merit".
//
// Verified present in both builds: the entity-interacted event exposes player,
// entity, target, hand and item (ItemEntityInteractedEventJS on KubeJS 6,
// ItemEntityInteractedKubeEvent on 7). Feeding was verified in game 2026-10-18
// (then as metta).
ItemEvents.entityInteracted(event => {
    // CAREFUL: on THIS event, `entity` is the PLAYER and `target` is the animal.
    //
    // The event is a player event, so getEntity() is the player ("The player that
    // interacted with the entity"), and getTarget() is "The entity that was
    // interacted with". Both strings are in the jar verbatim, on 6 and 7.
    //
    // This is the OPPOSITE of every other handler in this file, where event.entity
    // is the mob (EntityEvents.death/hurt) or the actor (BlockEvents.placed/broken).
    // Reading event.entity as the animal here made target.isAnimal() false for a
    // player, so the handler returned immediately and feeding never awarded --
    // silently, with no error in the log.
    const player = event.player
    const target = event.target
    if (!player || !target) return

    // isAnimal() is KubeJS's MobCategory test: CREATURE *and* MISC (read from the
    // jar). So feeding a villager or an iron golem bread pays generosity too --
    // pre-existing on 1.20.1, a design question, not changed by the port. The
    // explicit list backs isAnimal() up for modded tameables in other categories.
    var saysAnimal = false
    try {
        saysAnimal = target.isAnimal() === true
    } catch (ignored) {
        saysAnimal = false
    }

    const KNOWN_ANIMALS = [
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
    if (!saysAnimal && KNOWN_ANIMALS.indexOf(targetType) === -1) return

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

    var isFood = false
    for (var i = 0; i < cfg.animalFoodSuffixes.length; i++) {
        if (heldId.endsWith(cfg.animalFoodSuffixes[i])) {
            isFood = true
            break
        }
    }
    if (!isFood) return

    // Per PLAYER rate limit first (a pen of animals is otherwise a vending machine),
    // and it must come BEFORE alreadyPaid: that records a payment whenever it
    // returns false, so checking it first would mark an animal paid that never was.
    if (!feedRateOk(player)) return
    // Once per animal per window.
    if (alreadyPaid(player, 'feed', id, farm.feedEntityTicks, farm.entityMemoryMax)) return
    feedRateRecord(player)

    const r = global.SMS.award(player, 'feedAnimal')
    if (!r) return
    console.info(`[Samsara] ${player.profile.name} fed ${target.type}: +${r.amount} ${r.stat} -> ${r.total}`)
})

// ---- Metta: endurance (non-retaliation) ------------------------------------
//
// MN 21, the simile of the saw: "even if bandits were to carve you up savagely,
// limb by limb, with a two-handled saw, he among you who let his heart get angered
// even at that would not be doing my bidding." Metta here is NOT striking back at a
// being that harms you -- by getting away, or by letting it kill you.
//
// AN ENCOUNTER opens when a hostile mob damages the player and closes after
// config.endurance.quietTicks with no further hostile hit, or at the player's
// death. It pays karma.enduredEncounter if the player took at least minDamage and
// struck NO living thing during it (or in the quietTicks before it opened).
//
// What earns it is the restraint, so a death pays exactly what an escape pays.
//
// ANTI-FARM, one guard per exploit -- see config.endurance for why each exists:
//   spawner mobs never count        (the caged-spawner AFK)
//   one award per awardWindowTicks  (rapid repeats)
//   perLifeMax per life             (the aggregate bound)
//   no pay for a rapid repeat death (dying as the reset button for perLifeMax)
//
// State is in memory: an encounter only needs to outlast a few seconds. The
// per-life total is in NBT, so a relog cannot reset it.
//
// Exposed on global.SMS.endurance so the offline harness drives the real logic.

const SPAWNER_MARK = 'samsara_from_spawner'

global.SMS.encounters = global.SMS.encounters || {}
global.SMS.lastViolence = global.SMS.lastViolence || {}

function enduranceLog(msg) {
    if (global.SMS.config.debugEndurance) console.info('[Samsara] endurance: ' + msg)
}

function isSpawnerMob(entity) {
    try {
        return entity.persistentData.getBoolean(SPAWNER_MARK) === true
    } catch (ignored) {
        return false
    }
}

// Zero the per-life counters. Called at death, once the dying life's encounter
// has been settled.
global.SMS.resetLifeCounters = player => {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    tag.putDouble(nbt.lifeHostileKills, 0)
    tag.putDouble(nbt.lifeEndured, 0)
    // Aging belongs to that life (samsara_realms.js starts a full span at the next birth).
    // Without this, a player who died some other way would carry the leftover clock into
    // the next life -- a deva killed after five hours, reborn human, would have one hour.
    tag.putDouble(nbt.agingLeft, 0)
    tag.putDouble(nbt.agingHalveArmed, 0)
}

// Is this death a rapid repeat -- inside ripening.cooldownTicks of the previous one?
// lastDeathTick still holds the PREVIOUS death while karma's death handlers run:
// ripening (samsara_rebirth.js) writes it, and that file's priority (40) is below this
// one's (50), so its death handler runs after these.
function deathInsideCooldown(player) {
    const cfg = global.SMS.config
    const tag = global.SMS.persistedTag(player)
    var since = (global.SMS.tickClock || 0) - Number(tag.getDouble(cfg.nbt.lastDeathTick))
    return tag.getBoolean(cfg.nbt.everDied) && since >= 0 && since < cfg.ripening.cooldownTicks
}

// Decide whether a closed encounter pays, and pay it. Returns the award or null.
function settleEncounter(player, enc, how, isDeath) {
    const cfg = global.SMS.config
    const end = cfg.endurance
    const name = player.profile.name

    if (enc.spoiled) {
        enduranceLog(`${name} ${how}: spoiled (struck back) -- nothing`)
        return null
    }
    if (enc.damage < end.minDamage) {
        enduranceLog(`${name} ${how}: only ${fmt(enc.damage)} damage < ${end.minDamage} -- nothing`)
        return null
    }
    if (global.SMS.isLiberated(player)) return null

    const tag = global.SMS.persistedTag(player)

    // A death inside the ripening cooldown is a rapid repeat (see deathInsideCooldown).
    if (isDeath && end.blockRapidDeath && deathInsideCooldown(player)) {
        enduranceLog(`${name} ${how}: rapid repeat death -- nothing`)
        return null
    }

    // Aggregate bound, checked BEFORE the window: alreadyPaid records a payment
    // whenever it returns false, so it must be the last gate.
    const amount = cfg.karma.enduredEncounter
    var paidThisLife = Number(tag.getDouble(cfg.nbt.lifeEndured))
    if (!isFinite(paidThisLife) || paidThisLife < 0) paidThisLife = 0
    if (paidThisLife + amount > end.perLifeMax + 1e-9) {
        enduranceLog(`${name} ${how}: per-life cap ${end.perLifeMax} reached -- nothing`)
        return null
    }
    if (alreadyPaid(player, 'endure', 'award', end.awardWindowTicks, 4)) {
        enduranceLog(`${name} ${how}: inside the award window -- nothing`)
        return null
    }

    const r = global.SMS.award(player, 'enduredEncounter')
    if (!r) return null
    tag.putDouble(cfg.nbt.lifeEndured, paidThisLife + amount)
    console.info(
        `[Samsara] ${name} endured (${how}, ${fmt(enc.damage)} damage, no retaliation):` +
            ` +${r.amount} ${r.stat} -> ${r.total}`
    )
    return r
}

global.SMS.endurance = {
    // A hostile `attacker` damaged `player` for `damage`.
    onThreat: (player, attacker, damage) => {
        const end = global.SMS.config.endurance
        if (!end.enabled || !player || !attacker) return
        try {
            if (attacker.isPlayer()) return // PvP never counts: friends could farm it
        } catch (ignored) {
            return
        }
        if (global.SMS.classifyVictim(attacker) !== 'hostile') return
        if (end.ignoreSpawnerMobs && isSpawnerMob(attacker)) {
            enduranceLog(`${player.profile.name} hit by spawner mob ${attacker.type} -- ignored`)
            return
        }

        var dmg = Number(damage)
        if (!isFinite(dmg) || dmg <= 0) return

        const key = playerKey(player)
        const now = global.SMS.tickClock || 0
        var enc = global.SMS.encounters[key]
        if (!enc) {
            // A strike shortly BEFORE the hit is still violence.
            var lastV = global.SMS.lastViolence[key]
            var preemptive = lastV !== undefined && now - lastV >= 0 && now - lastV < end.quietTicks
            enc = { damage: 0, spoiled: preemptive, opened: now, lastHit: now }
            global.SMS.encounters[key] = enc
            enduranceLog(`${player.profile.name} encounter opened by ${attacker.type}` + (preemptive ? ' (already spoiled)' : ''))
        }
        enc.damage += dmg
        enc.lastHit = now
    },

    // `player` struck a living thing.
    onViolence: player => {
        if (!player) return
        const key = playerKey(player)
        global.SMS.lastViolence[key] = global.SMS.tickClock || 0
        var enc = global.SMS.encounters[key]
        if (enc && !enc.spoiled) {
            enc.spoiled = true
            enduranceLog(`${player.profile.name} struck back -- encounter spoiled`)
        }
    },

    // `player` died: settle any open encounter, then start the next life's counters.
    onDeath: player => {
        const key = playerKey(player)
        var enc = global.SMS.encounters[key]
        delete global.SMS.encounters[key]
        delete global.SMS.lastViolence[key]
        var r = null
        if (enc) r = settleEncounter(player, enc, 'death', true)
        global.SMS.resetLifeCounters(player)
        return r
    },

    // Close every encounter that has gone quiet. `players` is the online list --
    // a Java List in game (size/get), a JS array in the harness. Settling uses the
    // ONLINE player object, never a stored one, which goes stale on relog.
    drain: players => {
        const end = global.SMS.config.endurance
        const now = global.SMS.tickClock || 0
        const keys = Object.keys(global.SMS.encounters)
        var settled = []
        for (var i = 0; i < keys.length; i++) {
            var enc = global.SMS.encounters[keys[i]]
            var age = now - enc.lastHit
            if (age >= 0 && age < end.quietTicks) continue
            delete global.SMS.encounters[keys[i]]
            if (age < 0) continue // tick clock restarted; drop it

            var online = null
            var n = players ? (players.size ? players.size() : players.length) : 0
            for (var j = 0; j < n; j++) {
                var p = players.get ? players.get(j) : players[j]
                if (playerKey(p) === keys[i]) {
                    online = p
                    break
                }
            }
            if (!online) continue // logged out mid-encounter: nothing to pay
            settled.push(settleEncounter(online, enc, 'escaped', false))
        }
        return settled
    },
}

// Tag spawner-born mobs so they can never open an encounter.
//
// KubeJS 7: checkSpawn is NeoForge's FinalizeSpawnEvent -- it fires for natural
// spawns, spawn eggs, /summon, breeding and conversion too -- and event.spawner is
// NEVER null (WrappedSpawner.of(null) returns WrappedSpawner(null, null)), so its
// truthiness says nothing. On 1.20.1 it was null for natural spawns; ported as
// written, every mob would carry the mark and endurance would never pay. Decide by
// event.type, the MobSpawnType (its toString() is the enum name, e.g. 'SPAWNER').
//
// Never cancel this event: it would cancel the spawn.
EntityEvents.checkSpawn(event => {
    const end = global.SMS.config.endurance
    if (!end.ignoreSpawnerMobs) return
    var type = ''
    try {
        type = '' + event.type
    } catch (ignored) {
        type = ''
    }
    if ((end.spawnerSpawnTypes || []).indexOf(type) === -1) return
    try {
        event.entity.persistentData.putBoolean(SPAWNER_MARK, true)
    } catch (ignored2) {
        // cannot tag it: it will count as natural, which only loosens one guard
    }
})

// Both halves of an encounter come through the damage hook below.
function enduranceFrom(victim, source, amount) {
    if (!victim) return

    // 1. Violence: a real player struck a living thing (not themselves).
    var striker = null
    try {
        striker = global.SMS.resolveKiller(source)
    } catch (ignored) {
        striker = null
    }
    if (striker && playerKey(striker) !== playerKey(victim)) {
        global.SMS.endurance.onViolence(striker)
    }

    // 2. Threat: a hostile mob hurt a real player.
    if (!isRealPlayer(victim)) return
    var attacker = null
    try {
        attacker = source.actual
    } catch (ignored) {
        attacker = null
    }
    if (!attacker) return
    try {
        if (!attacker.isLiving()) return
    } catch (ignored) {
        return
    }
    var dmg = Number(amount)
    if (!isFinite(dmg)) dmg = 0
    global.SMS.endurance.onThreat(victim, attacker, dmg)
}

// ---- THE damage hook: one listener, one meaning of "was hurt" --------------
//
// NeoForge's LivingIncomingDamageEvent: the first thing LivingEntity.hurt() does,
// with the RAW damage -- before the shield, invulnerability frames and armor. That
// is exactly what KubeJS 6's EntityEvents.hurt was on 1.20.1 (Architectury
// LIVING_HURT = Forge LivingAttackEvent), so endurance's minDamage, hurtPassive's
// "every swing counts" and every harness timeline keep their meaning. KubeJS 7's
// own beforeHurt/afterHurt are LivingDamageEvent.Pre/Post: AFTER armor, which would
// make an iron-armoured player need twice the hits to reach minDamage.
// (Port doc 05; jar facts J9, J32.)
//
// The two consumers write different state, so their order does not matter; they
// live in one place so there is exactly one damage source in the pack.
global.SMS.onIncomingDamage = (victim, source, amount) => {
    hurtPassiveFrom(victim, source)
    enduranceFrom(victim, source, amount)
}

// Registered through NativeEvents, which puts the listener on NeoForge.EVENT_BUS.
// Explicit getters, not beans: this is a NeoForge object, not a KubeJS event.
//
// /reload: KubeJS's ScriptManager.reload() calls unload(), which clears every
// script's native listeners before the scripts run again (read from the jar,
// build 377), so this cannot double up across reloads.
//
// SAMSARA ONLY OBSERVES DAMAGE: never cancel this event or setAmount on it. The
// try/catch is safe here -- there is no KubeJS EventExit on a native event to
// swallow (that trap is about event.cancel() on KubeJS events).
//
// The REGISTRATION is in a try too: a top-level throw here (the class not loading,
// NativeEvents missing) would abort the rest of this file -- the encounter drain, the
// endurance death hook and delusion -- exactly as EntityEvents.hurt would have. Lose
// the damage hook loudly instead, and keep the rest.
try {
    NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.event.entity.living.LivingIncomingDamageEvent'), event => {
        try {
            global.SMS.onIncomingDamage(event.getEntity(), event.getSource(), Number(event.getAmount()))
        } catch (e) {
            console.warn(`[Samsara] incoming-damage hook failed: ${e}`)
        }
    })
} catch (e) {
    console.error(`[Samsara] could not register the damage hook -- hurtPassive and endurance are OFF: ${e}`)
}

// Close quiet encounters. The queue-and-drain pattern is kept on KubeJS 7: it is
// proven, driven by the harness, and survives /reload (scheduleInTicks was
// unusable on KubeJS 6).
ServerEvents.tick(event => {
    if (Object.keys(global.SMS.encounters).length === 0) return
    global.SMS.endurance.drain(event.server.players)
})

// ---- Generosity: the offering of the body (herbivore births) ----------------
//
// A herbivore-born player killed by a predator, having struck nothing in the
// endurance.quietTicks before, gives its body: karma.offerBody (generosity). See
// config.animalBirth.offering for the doctrine and what counts as a predator.
//
// It reads global.SMS.lastViolence -- the same "struck a living thing" record
// endurance keeps -- so it MUST run before endurance.onDeath, which deletes it. Both
// run from the one death handler below, in that named order.

// The predator behind this death, or null: a real player wearing a body of a
// predator diet, or a mob that is a listed predator or a creature of such a diet.
function predatorOf(source, off) {
    var diets = off.predatorDiets || []
    var killer = global.SMS.resolveKiller(source)
    if (killer) {
        if (global.SMS.birthRealmOf(killer) !== 'animal') return null
        var killerDiet = global.SMS.animalDietOf(global.SMS.nbtString(global.SMS.persistedTag(killer), global.SMS.config.nbt.animalForm))
        return diets.indexOf('' + killerDiet) !== -1 ? killer : null
    }
    var actual = null
    try {
        actual = source.actual
        if (!actual || !actual.isLiving()) return null
    } catch (ignored) {
        return null
    }
    return global.SMS.isPredatorType('' + actual.type) ? actual : null
}

// A mob type that hunts: listed in offering.predators, or a creature of one of
// offering.predatorDiets' tiers. The predators of the offering, and the only mobs that
// may still hunt an animal-born player (samsara_realms.js, huntedOnlyByPredators).
global.SMS.isPredatorType = type => {
    const off = (global.SMS.config.animalBirth || {}).offering || {}
    if ((off.predators || []).indexOf('' + type) !== -1) return true
    return (off.predatorDiets || []).indexOf('' + global.SMS.animalDietOf(type)) !== -1
}

global.SMS.offering = {
    // `player` died from `source`. Returns the award, or null.
    onDeath: (player, source) => {
        const cfg = global.SMS.config
        const off = (cfg.animalBirth || {}).offering
        if (!off || !source) return null
        if (global.SMS.isLiberated(player)) return null
        if (global.SMS.birthRealmOf(player) !== 'animal') return null
        const diet = global.SMS.animalDietOf(global.SMS.nbtString(global.SMS.persistedTag(player), cfg.nbt.animalForm))
        if ((off.diets || []).indexOf('' + diet) === -1) return null

        const predator = predatorOf(source, off)
        if (!predator) return null
        const name = player.profile.name

        // An offering is given, not lost: any strike in the quiet window before
        // the death makes it a fight.
        const lastV = global.SMS.lastViolence[playerKey(player)]
        const since = (global.SMS.tickClock || 0) - lastV
        if (lastV !== undefined && since >= 0 && since < cfg.endurance.quietTicks) {
            console.info(`[Samsara] ${name} fought ${predator.type} -- not an offering`)
            return null
        }
        if (off.blockRapidDeath && deathInsideCooldown(player)) {
            console.info(`[Samsara] ${name}: offering inside the rapid-death window -- nothing`)
            return null
        }

        const r = global.SMS.award(player, 'offerBody')
        if (!r) return null
        console.info(`[Samsara] ${name} (${diet}) gave its body to ${predator.type}: +${fmt(r.amount)} ${r.stat} -> ${fmt(r.total)}`)
        return r
    },
}

// A death settles the dying life: first the offering (it reads lastViolence), then
// the encounter and the per-life counters (endurance.onDeath clears lastViolence).
EntityEvents.death(event => {
    const player = event.entity
    if (!player || !player.isPlayer()) return
    try {
        global.SMS.offering.onDeath(player, event.source)
    } catch (e) {
        console.warn(`[Samsara] offering death hook failed: ${e}`)
    }
    try {
        global.SMS.endurance.onDeath(player)
    } catch (e) {
        console.warn(`[Samsara] endurance death hook failed: ${e}`)
    }
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
// same event is registration order, and this file's `// priority: 50` loads it
// before samsara_rebirth.js's 40).
//
// BOUNDED PER BURST. The first repeat pays the full repeatDeath; each later one in
// the same unbroken run pays repeatFalloff times the one before (5, 1.75, 0.61,
// ...), so a burst of any length adds at most carelessDeath + repeatDeath /
// (1 - repeatFalloff) ~ 9.7. A flat repeatDeath was unbounded: ripening's falloff
// shrinks toward 0 during a burst, so nothing took it away, and in game
// (2026-10-19) ~20 deaths in a minute routed to animal -- and a hell-born player
// could die until delusion overtook hatred, escaping naraka into animal. Harness
// section 16h.
EntityEvents.death(event => {
    const player = event.entity
    if (!player || !player.isPlayer()) return

    // Dying of OLD AGE is no carelessness: Aging ran out (samsara_realms.js marks the
    // player for the length of the blow, which is when this runs). Decided 2026-10-25.
    try {
        if (global.SMS.diesOfOldAge && global.SMS.diesOfOldAge(player)) return
    } catch (ignored) {
        // fall through: treat it as any death with no attacker
    }

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

    const cfg = global.SMS.config

    // Is this a repeat inside the rapid-death window, and how far into the run?
    var act = 'carelessDeath'
    var amount = undefined // undefined = the configured value
    var streak = 0
    try {
        streak = global.SMS.rapidDeathStreak(player)
        if (streak >= 1) {
            act = 'repeatDeath'
            amount = cfg.karma.repeatDeath * Math.pow(cfg.ripening.repeatFalloff, streak - 1)
        }
    } catch (ignored) {
        act = 'carelessDeath'
        amount = undefined
        streak = 0
    }

    const r = global.SMS.award(player, act, amount)
    if (!r) return
    console.info(
        `[Samsara] ${player.profile.name} died carelessly (${act}, rapid-death streak ${streak}):` +
            ` +${fmt(r.amount)} ${r.stat} -> ${fmt(r.total)}`
    )
})

console.info('[Samsara] karma hooks registered')

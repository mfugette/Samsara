// Samsara — karma decay and ripening.
//
// Karma is not a permanent ledger. In Buddhist thought a birth ends when the karma
// that produced it is exhausted, so karma must wear away. Two things wear it down:
//
//   1. TIME (passive decay). Every stat loses a fraction of itself on a slow timer.
//      Proportional rather than flat, so a large debt sheds fast at first and then
//      slows, while small amounts linger instead of snapping to zero.
//   2. REBIRTH (ripening). The karma that CAUSED a birth is spent when that birth
//      ends. This is realm-specific: a deva's merit burns away, a hell-being's
//      hatred does.
//
// RIPENING REPLACES THE OLD FLAT DEATH BURN. The burn took 25% of all six stats
// equally and ran before the destination was known, so it could not be
// realm-specific. Ripening must know the realm, so it runs AFTER pickDestination.
//
// Wisdom is the exception to both: it ripens at config.ripening.wisdomRate in every
// realm and decays passively at a fraction of the normal rate. Insight carries over
// between lives -- the soft form of the canonical rule that stream-entry
// permanently closes off the lower realms.

global.SMS = global.SMS || {}

// ---- Shared scaling --------------------------------------------------------

// Multiply a set of stats by `keep` (a 0..1 retention factor).
//
// `keys` defaults to all six. Values at or below config.decay.floor are zeroed so
// stats actually reach 0 rather than trailing infinitesimals forever.
//
// Every write goes through global.SMS.setStat, which clamps to [0, statCap] and
// quantises to config.statGrain -- so multiplying can never leave a trailing
// decimal behind. Returns the total amount removed, for logging.
global.SMS.scaleStats = (player, keep, keys) => {
    const cfg = global.SMS.config.decay
    const stats = keys || global.SMS.STATS
    var removed = 0

    for (var i = 0; i < stats.length; i++) {
        var before = global.SMS.getStat(player, stats[i])
        if (before <= 0) continue

        var after = before * keep
        if (after <= cfg.floor) after = 0

        var stored = global.SMS.setStat(player, stats[i], after)
        removed += before - stored
    }

    return removed
}

// Back-compat alias: the old name scaled all six unconditionally.
global.SMS.scaleAllStats = (player, keep) => global.SMS.scaleStats(player, keep, null)

// ---- Passive decay ---------------------------------------------------------

// Throttle: ServerEvents.tick fires 20x/second, and we only want to touch player
// NBT every config.decay.intervalTicks.
let decayCounter = 0

// A pure-JS tick clock.
//
// We cannot read the world time for this: Level.getTime() returns a Java `long`
// (signature ()J), and Rhino will not coerce a Java long into a JS number --
// Number(server.overworld.time) yields NaN. That made every cooldown comparison
// false and silently disabled the anti-farm guard. Counting ticks ourselves keeps
// everything in JS number space.
//
// PRESERVED ACROSS /reload. `global.SMS.tickClock = 0` (unconditional) reset the
// clock every time the scripts reloaded, which silently broke two things:
//
//   - the anti-farm death guard, because `now - last` went hugely negative and the
//     streak reset to full strength, so /reload became a way to clear it;
//   - any cache keyed on the clock (the rebirth spawn cache) for the same reason.
//
// `global` survives /reload in KubeJS, so keep an existing value when there is one.
global.SMS.tickClock = global.SMS.tickClock || 0

ServerEvents.tick(event => {
    const cfg = global.SMS.config.decay
    if (!cfg.enabled) return

    global.SMS.tickClock++

    decayCounter++
    if (decayCounter < cfg.intervalTicks) return
    decayCounter = 0

    const players = event.server.players
    if (!players || players.size() === 0) return

    // Wisdom decays far more slowly than the other five. Splitting the call in two
    // is simpler than threading a per-stat rate through scaleStats, and it keeps
    // the "all six decay together" intent visible.
    const normalKeep = 1 - cfg.fraction
    const wisdomKeep = 1 - cfg.fraction * cfg.wisdomFactionMultiplier

    const notWisdom = global.SMS.STATS.filter(s => s !== 'wisdom')

    for (let i = 0; i < players.size(); i++) {
        var player = players.get(i)

        // A liberated player is outside the karma system entirely -- no decay, no
        // ripening, no routing. See the project notes' liberation section.
        if (global.SMS.isLiberated(player)) continue

        var removed = global.SMS.scaleStats(player, normalKeep, notWisdom)
        removed += global.SMS.scaleStats(player, wisdomKeep, ['wisdom'])

        if (removed > 0) {
            // No .toFixed(): java.lang.Double has no such method under Rhino, and
            // calling it throws at the END of an otherwise successful handler.
            console.info(`[Samsara] decay: ${player.profile.name} shed ${Math.round(removed * 100) / 100} karma`)
        }
    }
})

// ---- Ripening --------------------------------------------------------------

// Spend the karma that produced a birth, now that the birth has ended.
//
// `realm` is the realm the player is being reborn INTO, which is also the realm
// whose karma just ripened -- the destination is what the stats earned.
//
// Rates are per config.ripening:
//   lower realms   -> the DOMINANT poison only, at lowerDominantPoison
//   deva / asura   -> generosity and metta, at higherGenerosity / higherMetta
//   human          -> all stats, at humanAll
//   wisdom         -> always wisdomRate, in every realm, overriding the above
//
// ANTI-FARM. Each death inside cooldownTicks of the previous one multiplies every
// rate by repeatFalloff again, so the 1st death ripens fully, the 2nd ~35%, the
// 3rd ~12%. Without it a player stuck in hell could suicide repeatedly to ripen
// their hatred away and any escape task would be pointless.
//
// Returns a small report for logging, or null when ripening is off.
global.SMS.ripenKarma = (player, realm) => {
    const cfg = global.SMS.config.ripening
    if (!cfg.enabled) return null

    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    const now = global.SMS.tickClock || 0

    // NOTE: putDouble/getDouble only. getLong/getInt are unverified on this
    // CompoundTag binding, and an unsupported NBT method fails SILENTLY here rather
    // than throwing -- a double represents tick counts and small ints exactly.
    const last = Number(tag.getDouble(nbt.lastDeathTick))
    const everDied = tag.getBoolean(nbt.everDied)
    const since = now - last

    // Fresh start if the player has not died recently (or ever). A negative `since`
    // (clock restarted) counts as "long ago" rather than being trusted.
    var streak = 0
    if (everDied && since >= 0 && since < cfg.cooldownTicks) {
        streak = Number(tag.getDouble(nbt.deathStreak))
        if (!isFinite(streak) || streak < 0) streak = 0
    }

    // The falloff multiplier applied to every rate below.
    const falloff = Math.pow(cfg.repeatFalloff, streak)

    const realmKey = realm ? '' + realm : 'human'
    const isLower = realmKey === 'naraka' || realmKey === 'preta' || realmKey === 'animal'
    const isHigher = realmKey === 'deva' || realmKey === 'asura'

    const stats = global.SMS.getStats(player)
    var removed = 0
    var detail = ''

    if (isLower) {
        // Spend the specific poison that sent them down.
        var lead = global.SMS.dominantOf(stats, global.SMS.POISONS)
        removed += global.SMS.scaleStats(player, 1 - cfg.lowerDominantPoison * falloff, [lead])
        detail = `${lead} -${Math.round(cfg.lowerDominantPoison * falloff * 100)}%`
    } else if (isHigher) {
        // A deva or asura birth runs on generosity and metta; those burn away. This
        // is what makes heaven temporary -- the deva falls when its merit is spent.
        removed += global.SMS.scaleStats(player, 1 - cfg.higherGenerosity * falloff, ['generosity'])
        removed += global.SMS.scaleStats(player, 1 - cfg.higherMetta * falloff, ['metta'])
        detail =
            `generosity -${Math.round(cfg.higherGenerosity * falloff * 100)}%` +
            ` metta -${Math.round(cfg.higherMetta * falloff * 100)}%`
    } else {
        // Human (and anything unmapped, e.g. brahma once jhana exists): an ordinary
        // life spends a little of everything. Wisdom is excluded here and handled
        // below at its own much slower rate.
        var notWisdom = global.SMS.STATS.filter(s => s !== 'wisdom')
        removed += global.SMS.scaleStats(player, 1 - cfg.humanAll * falloff, notWisdom)
        detail = `all -${Math.round(cfg.humanAll * falloff * 100)}%`
    }

    // Wisdom always ripens at its own slow rate, in every realm. Insight carries
    // over. Applied last so no branch above can have touched it.
    removed += global.SMS.scaleStats(player, 1 - cfg.wisdomRate * falloff, ['wisdom'])
    detail += ` wisdom -${Math.round(cfg.wisdomRate * falloff * 100)}%`

    // Record the death for the next falloff calculation.
    tag.putDouble(nbt.lastDeathTick, now)
    tag.putBoolean(nbt.everDied, true)
    tag.putDouble(nbt.deathStreak, streak + 1)

    const shown = Math.round(removed * 100) / 100
    console.info(
        `[Samsara] ripening (${realmKey}): ${player.profile.name} spent ${shown} karma` +
            ` [${detail}, rapid-death streak ${streak}]`
    )

    return { removed: shown, realm: realmKey, streak: streak, detail: detail }
}

// The old flat death burn. Kept as a no-op shim that warns, because
// samsara_rebirth.js called it and an old copy of that file calling a missing
// function would throw inside the death hook and abort the whole rebirth.
global.SMS.burnKarmaOnDeath = player => {
    console.warn(
        '[Samsara] burnKarmaOnDeath is retired -- ripening replaced it.' +
            ' This call did nothing; update the caller to global.SMS.ripenKarma(player, realm).'
    )
}

console.info('[Samsara] decay and ripening hooks registered')

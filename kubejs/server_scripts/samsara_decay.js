// Samsara — karma ripening, and the shared tick clock.
//
// (The filename is historical: this file once held passive decay too.)
//
// Karma is spent in exactly one way: REBIRTH (ripening). The karma that CAUSED a
// birth is spent when that birth ends. This is realm-specific: a deva's merit burns
// away, a hell-being's hatred does.
//
// THERE IS NO PASSIVE DECAY, deliberately -- see the note where config.decay used
// to be. Dhp 71: an evil deed "does not immediately bear fruit, like milk that does
// not turn sour all at once; but smoldering, it follows the fool like fire covered
// by ashes." Between births, bad karma is diluted by antidotes (routing works on
// shares -- AN 3.99's salt crystal), not worn away by the clock.
//
// RIPENING REPLACES THE OLD FLAT DEATH BURN. The burn took 25% of all six stats
// equally and ran before the destination was known, so it could not be
// realm-specific. Ripening must know the realm, so it runs AFTER pickDestination.
//
// Wisdom ripens at config.ripening.wisdomRate in every realm. Insight carries over
// between lives -- the soft form of the canonical rule that stream-entry
// permanently closes off the lower realms.

global.SMS = global.SMS || {}

// ---- Shared scaling --------------------------------------------------------

// Multiply a set of stats by `keep` (a 0..1 retention factor).
//
// `keys` defaults to all six. Values at or below config.ripening.floor are zeroed
// so stats actually reach 0 rather than trailing infinitesimals forever.
//
// Every write goes through global.SMS.setStat, which clamps to [0, statCap] and
// strips float noise. Storage is exact (no grain since the 2026-10-19 unit
// redesign), so even a small rate on a small stat really moves it. Returns the
// total amount removed, for logging.
global.SMS.scaleStats = (player, keep, keys) => {
    const cfg = global.SMS.config.ripening
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

// ---- The tick clock --------------------------------------------------------

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

// UNCONDITIONAL. This used to sit behind `if (!config.decay.enabled) return`, so
// turning decay off would have stopped the clock -- and with it every cooldown,
// anti-farm window and the endurance encounters, all silently.
ServerEvents.tick(event => {
    global.SMS.tickClock++
})

// ---- Ripening --------------------------------------------------------------

// The rapid-death streak: how many deaths in an unbroken run, each inside
// ripening.cooldownTicks of the one before, the player had ALREADY died before
// this one. 0 means this death starts fresh (no recent death, or none ever).
//
// One reader for two consumers, so they cannot drift apart: ripenKarma scales its
// rates by repeatFalloff^streak, and the delusion award (samsara_karma.js) scales a
// repeat death's delusion by repeatFalloff^(streak-1). Both must call this BEFORE
// ripenKarma records the current death; the delusion handler does, because
// samsara_karma.js registers its death handler before samsara_rebirth.js.
//
// NOTE: putDouble/getDouble only. getLong/getInt are unverified on this
// CompoundTag binding, and an unsupported NBT method fails SILENTLY here rather
// than throwing -- a double represents tick counts and small ints exactly.
global.SMS.rapidDeathStreak = player => {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    const now = global.SMS.tickClock || 0
    const last = Number(tag.getDouble(nbt.lastDeathTick))
    const since = now - last

    // A negative `since` (clock restarted) counts as "long ago" rather than being
    // trusted.
    if (!tag.getBoolean(nbt.everDied) || since < 0 || since >= global.SMS.config.ripening.cooldownTicks) return 0
    const streak = Number(tag.getDouble(nbt.deathStreak))
    return isFinite(streak) && streak > 0 ? streak : 0
}

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
// their hatred away and any escape task would be pointless. The delusion a rapid
// death ADDS falls off on the same streak (samsara_karma.js) -- see
// rapidDeathStreak above.
//
// Returns a small report for logging, or null when ripening is off.
global.SMS.ripenKarma = (player, realm) => {
    const cfg = global.SMS.config.ripening
    if (!cfg.enabled) return null

    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    const now = global.SMS.tickClock || 0
    const streak = global.SMS.rapidDeathStreak(player)

    // The falloff multiplier applied to every rate below.
    const falloff = Math.pow(cfg.repeatFalloff, streak)

    const realmKey = realm ? '' + realm : 'human'
    const isLower = realmKey === 'naraka' || realmKey === 'preta' || realmKey === 'animal'
    const isHigher = realmKey === 'deva' || realmKey === 'asura'

    const stats = global.SMS.getStats(player)
    // Hatred before ripening, so the combat sub-count can be scaled with it below.
    const hatredBefore = Number(stats.hatred)
    const combatBefore = Number(stats.hatredCombat) || 0
    var removed = 0
    var detail = ''

    if (isLower) {
        // Spend the poison that SENT them there -- read off the realm, not
        // recomputed. Routing picks the realm with combat hatred set aside
        // (global.SMS.judgedPoisons), so a raw "largest poison" here could disagree
        // with it and spend the wrong one.
        var lead = realmKey === 'naraka' ? 'hatred' : realmKey === 'preta' ? 'greed' : 'delusion'
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

    // Combat hatred is PART of hatred, so it ripens in the same proportion.
    // Without this it would outlive the hatred it belongs to (it is clamped on read,
    // but the share would drift: a halved hatred would read as mostly combat).
    if (combatBefore > 0 && hatredBefore > 0) {
        var hatredAfter = Number(global.SMS.getStat(player, 'hatred'))
        global.SMS.setCombatHatred(player, combatBefore * (hatredAfter / hatredBefore))
    }

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

console.info('[Samsara] ripening and tick clock registered (no passive decay)')

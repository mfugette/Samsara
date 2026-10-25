// priority: 0
// Samsara — commands. (Priority 0: no ordering dependency; everything is read at
// command time.)
//   /karma                               your six stats, derived values and verdict
//   /karma show <player>                 inspect another player     (op, level 2)
//   /karma set <player> <stat> <value>   set one stat               (op, level 2)
//   /karma add <player> <stat> <value>   add to one stat            (op, level 2)
//   /karma realm <player> <realm>        set birthRealm (penalties NOW)
//   /karma forcerealm <player> <realm>   override routing (NEXT DEATH)
//   /karma liberate <player> [on|off]    set/clear the liberated flag
//   /karma reset <player>                everything back to a new character's state
//
// Valid stats: greed, hatred, delusion (poisons)
//              generosity, metta, wisdom (antidotes)
//
// NOTE: a NEW subcommand needs a world REJOIN, not just /reload -- the client caches
// its command tree, so `liberate` will not appear until the world is reopened.

ServerEvents.commandRegistry(event => {
    const C = event.commands // net.minecraft.commands.Commands
    const A = event.arguments // KubeJS ArgumentTypeWrappers (PLAYER, INTEGER, STRING, ...)

    // KubeJS adds a non-lazy sendSuccess(Component, boolean) overload (KubeJS 6 and 7).
    // The vanilla signature takes a Supplier<Component>, and on 1.20.1 Rhino did NOT
    // coerce a JS arrow function into that Supplier -- it stringified it instead, which
    // is why `/karma` once printed "ArrowFunction (0) => {...}" in chat. Pass the
    // Component directly.
    const reply = (ctx, component) => {
        ctx.source.sendSuccess(component, false)
        return 1
    }

    // Two decimals without .toFixed() -- java.lang.Double has no such method under
    // Rhino and calling it throws at the END of an otherwise successful handler.
    const n2 = v => Math.round(Number(v) * 100) / 100

    // Percentage, for shares.
    const pct = v => Math.round(Number(v) * 1000) / 10

    // The full readout: six stats, the derived values routing actually uses, and the
    // verdict with the rule that produced it.
    //
    // Text colour helpers are camelCase in KubeJS (lightPurple, darkAqua, darkGray,
    // darkBlue, darkGreen, darkPurple, darkRed) even though the Minecraft colour
    // CODES are snake_case. `Text.light_purple` is undefined and calling it throws,
    // which once crashed /karma mid-output.
    const showStats = (ctx, player, label) => {
        const stats = global.SMS.getStats(player)
        const d = global.SMS.derive(stats)
        const cfg = global.SMS.config

        reply(ctx, Text.gold(`--- ${label} ---`))

        // ONE ROW PER OPPOSED PAIR, in fixed columns.
        //
        // The previous layout put all three poisons on one line and all three
        // antidotes on the next, with the shares crammed onto a third as
        // `g 0%  h 90.9%  d 9.1%`. Adjacent single-letter keys with decimals between
        // them are genuinely hard to read -- `h 2.5 d 0.25` was misread as hatred
        // 0.25 during testing, which cost a round of confusion over a passing test.
        //
        // Pairing each poison with its own antidote (greed/generosity,
        // hatred/metta, delusion/wisdom) is also the model's actual structure, so
        // the readout now teaches it: you see at a glance which side of each pair
        // you are on.
        //
        // Padding is done with String + repeat rather than padEnd/padStart: those
        // are ES2017 and this runs on Rhino, where their availability is not
        // something to bet a crashing command on.
        const padTo = (s, w) => {
            var str = '' + s
            if (str.length >= w) return str
            var out = str
            for (var pi = str.length; pi < w; pi++) out += ' '
            return out
        }
        // Right-align numbers so decimal points line up down the column.
        const padNum = (v, w) => {
            var str = '' + v
            var out = str
            for (var pi = str.length; pi < w; pi++) out = ' ' + out
            return out
        }

        // Header, so the two number columns are unambiguous.
        reply(ctx, Text.darkGray(`  ${padTo('', 12)}${padNum('value', 7)}  ${padNum('share', 7)}`))

        const pairRow = (poison, antidote) => {
            // Poison on the left, its antidote on the right, each with its share.
            reply(
                ctx,
                Text.red(
                    `  ${padTo(poison, 12)}${padNum(n2(stats[poison]), 7)}  ${padNum(pct(d.share[poison]) + '%', 7)}`
                )
            )
            reply(
                ctx,
                Text.green(
                    `  ${padTo('  ' + antidote, 12)}${padNum(n2(stats[antidote]), 7)}  ${padNum(pct(d.share[antidote]) + '%', 7)}`
                )
            )
        }

        // Iterate POISONS so the pairing comes from config, not a hardcoded order --
        // ANTIDOTE_FOR is the single source of truth for which counters which.
        for (var pr = 0; pr < global.SMS.POISONS.length; pr++) {
            var pz = global.SMS.POISONS[pr]
            pairRow(pz, global.SMS.ANTIDOTE_FOR[pz])
        }

        // The combat part of hatred. Routing treats it differently (it counts toward
        // P, but not toward asura or which lower realm), so a verdict that looks
        // wrong from the hatred number alone is explained here.
        if (stats.hatredCombat > 0) {
            reply(
                ctx,
                Text.darkGray(
                    `  (of hatred, ${n2(stats.hatredCombat)} is combat: counts toward P, not toward asura or which lower realm)`
                )
            )
        }

        // Derived values. These are what every routing rule reads.
        //
        // Net is shown as an em dash when there is no karma at all. The ROUTING value
        // in that case is 0.5 (see global.SMS.derive: A/(A+P) is 0/0, and 0.5 is the
        // honest midpoint -- a player who has done nothing is not maximally
        // poisonous, and a 0 fallback would route a brand-new player to the animal
        // realm). But PRINTING 0.5 for an empty ledger reads like a real measurement,
        // so an undefined ratio is displayed as undefined.
        const netShown = d.total > 0 ? n2(d.net) : '—'
        reply(
            ctx,
            Text.aqua(
                `  P ${n2(d.P)}    A ${n2(d.A)}    total ${n2(d.total)}    Net ${netShown}`
            )
        )

        // Where they live now, and what that costs them.
        const born = global.SMS.birthRealmOf(player)
        const fx = global.SMS.effectsFor(born)
        reply(ctx, Text.yellow(`  born into: ${born}  (${global.SMS.describeEffects(fx)})`))

        // The creature an animal birth is drawn as, and the diet its karma gave it.
        const ptag = global.SMS.persistedTag(player)
        const bodyForm = global.SMS.nbtString(ptag, cfg.nbt.animalForm)
        if (born === 'animal' && bodyForm) {
            reply(ctx, Text.yellow(`  body: ${bodyForm}  (${global.SMS.animalDietOf(bodyForm) || 'no longer in config'})`))
        }

        // What is left of this life (Aging, every realm's), and for a preta whether a full
        // belly would halve it now.
        const agingLeft = Number(ptag.getDouble(cfg.nbt.agingLeft))
        if (agingLeft > 0) {
            var armed = ptag.getDouble(cfg.nbt.agingHalveArmed) > 0
            reply(ctx, Text.yellow(
                `  aging: ${global.SMS.minutesSeconds(agingLeft)} of this life left, then death by old age` +
                    (!fx.fullMealHalvesAging ? ''
                        : armed ? '  (a full belly now halves it)' : '  (a full belly halves it, once you have gone hungry)')
            ))
        }

        // Grave keys Samsara keeps outside a human life (samsara_tombstone.js).
        const keysKept = global.SMS.graves ? global.SMS.graves.keysKept(player) : 0
        if (keysKept > 0) {
            reply(ctx, Text.yellow(`  grave keys kept by Samsara: ${keysKept}  (yours again in a human life)`))
        }

        // Already out of the cycle?
        if (global.SMS.isLiberated(player)) {
            reply(ctx, Text.lightPurple('  LIBERATED -- outside the cycle; no karma, no rebirth'))
            return 1
        }

        // The verdict, and the rule that produced it. Naming the rule is the whole
        // point of this command: "why am I going there" was previously unanswerable
        // without reading the source.
        const route = global.SMS.routeFor(player)
        const forced = global.SMS.forcedRealmOf(player)

        if (forced) {
            reply(
                ctx,
                Text.lightPurple(
                    `  FORCED rebirth realm: ${forced}  (/karma forcerealm <you> none to clear)`
                )
            )
            reply(
                ctx,
                Text.aqua(
                    `  reborn into: ${forced}  (${global.SMS.dimensionForRealm(forced, stats, player.server)})`
                )
            )
        } else if (route.liberated) {
            reply(ctx, Text.gold(`  WOULD BE LIBERATED on death -- ${route.rule}`))
        } else {
            reply(
                ctx,
                Text.aqua(
                    `  reborn into: ${route.realm}` +
                        `  (${global.SMS.dimensionForRealm(route.realm, stats, player.server)})`
                )
            )
            reply(ctx, Text.gray(`  matched rule: ${route.rule}`))
        }

        // How far they are from the exit, when they are somewhere it can be reached
        // from. Shown even on a fail so the player can see which condition is binding.
        if (global.SMS.liberationEligible(player)) {
            var lib = global.SMS.liberationCheck(stats)
            reply(
                ctx,
                lib.pass
                    ? Text.gold(`  liberation: AVAILABLE (${lib.reason})`)
                    : Text.darkGray(`  liberation: blocked -- ${lib.reason}`)
            )
        } else {
            reply(
                ctx,
                Text.darkGray(
                    `  liberation: only reachable from ${cfg.liberation.realms.join('/')} (you are ${born})`
                )
            )
        }

        return 1
    }

    // Shared builder for set/add, which differ only in how the new value combines
    // with the old one.
    //
    // Value is a DOUBLE, in UNITS (one unit = striking an animal once; feeding is
    // 0.5), so fractional values must be accepted. Admin writes bypass the
    // award-side rules (tiers, rate limits) on purpose -- they are for testing.
    const mutator = (name, apply) =>
        C.literal(name)
            .requires(source => source.hasPermission(2))
            .then(C.argument('target', A.PLAYER.create(event))
                .then(C.argument('stat', A.STRING.create(event))
                    .then(C.argument('value', A.DOUBLE.create(event))
                        .executes(ctx => {
                            const target = A.PLAYER.getResult(ctx, 'target')
                            const stat = A.STRING.getResult(ctx, 'stat')
                            const value = A.DOUBLE.getResult(ctx, 'value')

                            if (!global.SMS.isStat(stat)) {
                                ctx.source.sendFailure(
                                    Text.red(`Unknown stat '${stat}'. Valid: ${global.SMS.STATS.join(', ')}`)
                                )
                                return 1
                            }

                            // isStat() passed, so the Java String matches a known stat,
                            // but it must be coerced before being used as a key.
                            const total = apply(target, '' + stat, Number(value))
                            return reply(
                                ctx,
                                Text.green(
                                    `${target.profile.name}'s ${stat} is now ${n2(total)} units` +
                                        ` (thresholds: judged from ${global.SMS.config.routing.minTotal} total,` +
                                        ` lower birth from ${global.SMS.config.routing.lowerMinPoison} poison)`
                                )
                            )
                        }))))

    event.register(
        C.literal('karma')
            // /karma — show your own stats
            .executes(ctx => {
                const player = ctx.source.player
                if (!player) {
                    ctx.source.sendFailure(Text.red('Only a player has karma.'))
                    return 1
                }
                return showStats(ctx, player, 'Your karma')
            })
            .then(mutator('set', (target, stat, value) => global.SMS.setStat(target, stat, value)))
            .then(mutator('add', (target, stat, value) => global.SMS.addStat(target, stat, value)))
            // /karma realm <player> <realm> — force a birthRealm for testing, so realm
            // penalties can be checked without grinding karma to route there.
            .then(C.literal('realm')
                .requires(source => source.hasPermission(2))
                .then(C.argument('target', A.PLAYER.create(event))
                    .then(C.argument('realm', A.STRING.create(event))
                        .executes(ctx => {
                            const target = A.PLAYER.getResult(ctx, 'target')
                            const realm = A.STRING.getResult(ctx, 'realm')

                            // isRealm() coerces the argument before indexing, so a
                            // Java String from the command parser cannot miss the JS keys.
                            if (!global.SMS.isRealm(realm)) {
                                // var, not const: Rhino scopes const/let per function, so a
                                // const inside this nested block throws "redeclaration of
                                // var" the second time the command runs. See the project notes.
                                var valid = Object.keys(global.SMS.config.realmDimensions).join(', ')
                                ctx.source.sendFailure(Text.red(`Unknown realm '${realm}'. Valid: ${valid}`))
                                return 1
                            }

                            global.SMS.persistedTag(target).putString(global.SMS.config.nbt.birthRealm, realm)
                            // A new birth, so a new body (applyRealmEffects picks one
                            // from the stats as they are now when the realm is animal)
                            // and a full Aging for the new realm.
                            global.SMS.persistedTag(target).putString(global.SMS.config.nbt.animalForm, '')
                            global.SMS.persistedTag(target).putDouble(global.SMS.config.nbt.agingLeft, 0)
                            global.SMS.applyRealmEffects(target)
                            global.SMS.tellBirthRules(target)

                            const fx = global.SMS.effectsFor(realm)
                            return reply(ctx, Text.green(`${target.profile.name} is now born-${realm} (${global.SMS.describeEffects(fx)})`))
                        }))))
            // /karma life <player> <seconds> — set what is left of the player's life (their
            // Aging, in any realm) for testing, so the death by old age can be seen without
            // waiting out the life (2026-10-24; Aging's since 2026-10-25).
            .then(C.literal('life')
                .requires(source => source.hasPermission(2))
                .then(C.argument('target', A.PLAYER.create(event))
                    .then(C.argument('seconds', A.INTEGER.create(event))
                        .executes(ctx => {
                            const target = A.PLAYER.getResult(ctx, 'target')
                            const seconds = Number(A.INTEGER.getResult(ctx, 'seconds'))
                            if (!global.SMS.setAgingLeft(target, seconds * 20)) {
                                ctx.source.sendFailure(Text.red(`${target.profile.name} is liberated: they no longer age.`))
                                return 1
                            }
                            return reply(ctx, Text.green(`${target.profile.name}'s Aging: ${global.SMS.minutesSeconds(seconds * 20)} left`))
                        }))))
            // /karma forcerealm <player> <realm|none> — override WHERE THE PLAYER IS
            // REBORN on their NEXT DEATH.
            //
            // This is NOT the same as `/karma realm` above, and the difference has now
            // caused confusion twice:
            //
            //   /karma realm <p> naraka       -> applies naraka's penalties NOW
            //                                    (sets birthRealm; 5 hearts immediately)
            //   /karma forcerealm <p> naraka  -> sends them to naraka when they next die
            //                                    (sets forcedRealm; NO penalty until then)
            .then(C.literal('forcerealm')
                .requires(source => source.hasPermission(2))
                .then(C.argument('target', A.PLAYER.create(event))
                    .then(C.argument('realm', A.STRING.create(event))
                        .executes(ctx => {
                            const target = A.PLAYER.getResult(ctx, 'target')
                            // Coerced, as `liberate` does: a Java String compared with
                            // === against a JS literal is false.
                            const realm = '' + A.STRING.getResult(ctx, 'realm')
                            const key = global.SMS.config.nbt.forcedRealm

                            if (realm === 'none' || realm === 'clear') {
                                global.SMS.persistedTag(target).putString(key, '')
                                return reply(ctx, Text.green(`${target.profile.name}: rebirth back to karma routing`))
                            }

                            if (!global.SMS.isRealm(realm)) {
                                // var, not const -- see the note above.
                                var valid2 = Object.keys(global.SMS.config.realmDimensions).join(', ')
                                ctx.source.sendFailure(Text.red(`Unknown realm '${realm}'. Valid: ${valid2}, none`))
                                return 1
                            }

                            global.SMS.persistedTag(target).putString(key, realm)
                            const dim = global.SMS.dimensionForRealm(realm, global.SMS.getStats(target), target.server)
                            reply(ctx, Text.green(`${target.profile.name} will be reborn into ${realm} (${dim}) on next death`))
                            // Say plainly that nothing has changed yet. Reading full
                            // health straight after this command is correct behaviour.
                            return reply(ctx, Text.gray(`  no penalties until they die -- use /karma realm ${target.profile.name} ${realm} to apply them now`))
                        }))))
            // /karma liberate <player> [on|off] — set or clear the liberated flag.
            //
            // Needed for testing: reaching liberation legitimately requires a wisdom
            // share of 0.40+, and wisdom has NO karma source until phase 6, so without
            // this the liberated code path is unreachable in game.
            .then(C.literal('liberate')
                .requires(source => source.hasPermission(2))
                .then(C.argument('target', A.PLAYER.create(event))
                    .executes(ctx => {
                        const target = A.PLAYER.getResult(ctx, 'target')
                        global.SMS.grantLiberation(target, 'set by command')
                        return reply(ctx, Text.gold(`${target.profile.name} is now liberated`))
                    })
                    .then(C.argument('state', A.STRING.create(event))
                        .executes(ctx => {
                            const target = A.PLAYER.getResult(ctx, 'target')
                            const state = '' + A.STRING.getResult(ctx, 'state')

                            if (state === 'off' || state === 'false' || state === 'none') {
                                global.SMS.persistedTag(target).putBoolean(global.SMS.config.nbt.liberated, false)
                                // Back under the birth realm's rules at once (body, mode).
                                global.SMS.applyRealmEffects(target)
                                return reply(ctx, Text.yellow(`${target.profile.name} is back in the cycle`))
                            }

                            global.SMS.grantLiberation(target, 'set by command')
                            return reply(ctx, Text.gold(`${target.profile.name} is now liberated`))
                        }))))
            // /karma reset <player> — back to a brand-new character's karma state.
            //
            // Resets EVERYTHING the karma system owns, not just the six stats. A
            // leftover forcedRealm or liberated flag surviving a "reset" is exactly
            // the kind of thing that makes the next test lie, and the realm/forcerealm
            // distinction has already confused testing twice.
            //
            // Does NOT touch: the world, inventory, position, or anything outside the
            // karma system. `birthRealm` goes to human because that is where a new
            // character starts; realm effects are re-applied immediately so the
            // penalties of the realm they were in actually come off (a naraka-born
            // player would otherwise keep five hearts).
            .then(C.literal('reset')
                .requires(source => source.hasPermission(2))
                .then(C.argument('target', A.PLAYER.create(event))
                    .executes(ctx => {
                        const target = A.PLAYER.getResult(ctx, 'target')
                        const nbt = global.SMS.config.nbt
                        const tag = global.SMS.persistedTag(target)

                        // 1. The six stats, the combat sub-count, and the per-life
                        //    counters (hostile-kill tiers, endurance cap).
                        for (var i = 0; i < global.SMS.STATS.length; i++) {
                            global.SMS.setStat(target, global.SMS.STATS[i], 0)
                        }
                        tag.putDouble(nbt.hatredCombat, 0)
                        global.SMS.resetLifeCounters(target)

                        // 2. Testing overrides and the liberation flag.
                        tag.putString(nbt.forcedRealm, '')
                        tag.putBoolean(nbt.liberated, false)

                        // 3. Death / ripening bookkeeping, so the rapid-death falloff
                        //    does not carry a streak into a fresh ledger.
                        tag.putDouble(nbt.lastDeathTick, 0)
                        tag.putDouble(nbt.deathStreak, 0)
                        tag.putBoolean(nbt.everDied, false)

                        // 4. Legacy migration state. Both migrations stay MARKED DONE:
                        //    un-marking them would make the next login re-read the old
                        //    keys and re-award karma we just cleared.
                        tag.putDouble(nbt.legacyKarma, 0)
                        tag.putDouble(nbt.legacyVirtue, 0)
                        tag.putDouble(nbt.legacyMeditation, 0)
                        tag.putBoolean(nbt.migrated, true)
                        tag.putBoolean(nbt.migratedV2, true)
                        tag.putBoolean(nbt.migratedV3, true)

                        // 5. Back to a human birth in the player's own body, and strip
                        //    the old realm's effects.
                        tag.putString(nbt.birthRealm, 'human')
                        tag.putString(nbt.animalForm, '')
                        try {
                            global.SMS.applyRealmEffects(target)
                        } catch (e) {
                            console.warn(`[Samsara] reset: applyRealmEffects failed: ${e}`)
                        }

                        console.info(`[Samsara] ${target.profile.name}: karma reset to baseline`)
                        reply(ctx, Text.green(`${target.profile.name}'s karma reset to baseline`))
                        return reply(
                            ctx,
                            Text.gray('  six stats 0, born human in their own body, forcerealm/liberated cleared, death streak + life counters reset')
                        )
                    })))
            .then(C.literal('show')
                .requires(source => source.hasPermission(2))
                .then(C.argument('target', A.PLAYER.create(event))
                    .executes(ctx => {
                        const target = A.PLAYER.getResult(ctx, 'target')
                        return showStats(ctx, target, `${target.profile.name}'s karma`)
                    })))
    )
})

console.info('[Samsara] commands registered')

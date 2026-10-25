// priority: 60
// Samsara — realm penalties.
//
// PRIORITY 60, above samsara_rebirth.js (40): this file's respawn safety net
// registers before rebirth's respawn handler, and global.SMS.birthRealmOf / effectsFor
// exist before karma (50) and rebirth load. KubeJS 7 orders files by
// `// priority: N` (higher first), then path. (Until 2026-10-22 it also had to beat
// karma's BlockEvents.placed recorder with an animal placement refusal; Adventure
// mode replaced that refusal, so there is no placed handler here any more.)
//
// CRITICAL RULE: penalties follow the player's `birthRealm`, NEVER the dimension they
// are standing in. Players still need the Nether (blaze rods, netherite) and the End
// for ordinary progression, so a human walking through a portal is just VISITING and
// takes nothing. Only a player *born* into a realm lives under its rules.
// See design doc section 7.
//
// Effects are declared in config.realmEffects. Realms with no entry have no rules yet
// (asura, brahma: a design question, not built). The deva's are blessings, not
// penalties (2026-10-24). Every realm, those two included, AGES (config.aging,
// 2026-10-25): the life ends in death by old age.
//
// CANCELLING ON KUBEJS 7 (and 6 -- read from both jars): event.cancel() THROWS an
// EventExit, so nothing after it in the handler runs, and a try/catch around it CATCHES
// the exit and silently un-cancels the event. So every refusal here sends its message
// FIRST and calls cancel() LAST, outside any try. cancel() and cancel(false) are the
// same result (INTERRUPT_FALSE).

// The realm a player was BORN into. Falls back to human: a player who has never died
// has no birthRealm recorded, and the human realm is the no-penalty default.
// NOTE: goes through global.SMS.nbtString, which coerces the JAVA String that
// CompoundTag.getString returns into a real JS string. Without that coercion
// `config.realmDimensions[realm]` does not match its JS keys and this returned
// 'human' for every realm -- see the comment on nbtString in samsara_karma.js.
global.SMS.birthRealmOf = player => {
    try {
        var realm = global.SMS.nbtString(global.SMS.persistedTag(player), global.SMS.config.nbt.birthRealm)
        if (realm && global.SMS.isRealm(realm)) return realm
    } catch (ignored) {
        // fall through
    }
    return 'human'
}

// Effects table for a realm, or an empty object.
//
// Coerces the key for the same reason: a Java String passed in from NBT would miss
// every entry in realmEffects, so naraka's maxHealth was never found and the player
// kept full health. THIS was the full-health bug.
global.SMS.effectsFor = realm => {
    if (!realm) return {}
    var key = '' + realm
    return global.SMS.config.realmEffects[key] || {}
}

// A realm's effects in plain words, for /karma (the raw JSON was unreadable).
global.SMS.describeEffects = fx => {
    var parts = []
    if (fx.maxHealth !== undefined) parts.push('max health ' + fx.maxHealth)
    if (fx.noDamage) parts.push('takes no damage')
    if (fx.ignoredByMobs) parts.push('ignored by mobs')
    if (fx.heal) parts.push('mends')
    if (fx.resistance) parts.push('takes ' + Math.round(fx.resistance * 100) + '% less damage')
    if (fx.fireImmune) parts.push('fire cannot harm it')
    if (fx.absorption) parts.push('golden hearts every ' + Math.round(fx.absorption.everyTicks / 1200) + ' min')
    if (fx.torment) parts.push('withers, never below ' + fx.torment.floorHealth + ' health')
    if (fx.foodPerMeal !== undefined) parts.push(fx.foodPerMeal + ' food per meal')
    if (fx.exhaustion) parts.push('always hungry')
    if (fx.fullMealHalvesAging) parts.push('a full belly halves its aging')
    if (fx.adventureMode) parts.push('adventure mode')
    if (fx.noContainers) parts.push('no containers')
    if (fx.noCrafting) parts.push('no crafting')
    if (fx.pickUp === 'food') parts.push('holds only food')
    if (fx.pickUp === 'diet') parts.push('eats by its diet')
    return parts.length === 0 ? 'no penalties' : parts.join(', ')
}

// Vanilla classes the realm rules use, loaded once (read from the 1.21.1 jars,
// 2026-10-22). Each is null when it cannot be loaded, and its user says so.
function loadVanilla(name) {
    try {
        return Java.loadClass(name)
    } catch (e) {
        console.warn(`[Samsara] could not load ${name}: ${e}`)
        return null
    }
}
const GameTypeClass = loadVanilla('net.minecraft.world.level.GameType')
const DamageTypeTagsClass = loadVanilla('net.minecraft.tags.DamageTypeTags')
const ResourceLocationClass = loadVanilla('net.minecraft.resources.ResourceLocation')
const BuiltInRegistriesClass = loadVanilla('net.minecraft.core.registries.BuiltInRegistries')
const VanillaBlockClass = loadVanilla('net.minecraft.world.level.block.Block')

// ---- Commands at server permission -------------------------------------------
//
// Run `cmd` AS the player (so @s is them) but at SERVER permission. Never use
// player.runCommandSilent for an op-level command: KubeJS 7 builds its source with
// Entity.createCommandSourceStack(), which carries the PLAYER's own permission level
// (J39, read from the jar) -- 0 for anyone who is not an op -- so /effect and /walkers
// silently do nothing. Found 2026-10-21: the preta hunger effect had never reached a
// non-op player; the tests only passed in a cheats-on singleplayer world, where the
// player is op. server.runCommandSilent uses the server's own source (level 4), and
// `execute as` keeps that level while making the player the executor. Throws when
// there is no server; callers catch.
global.SMS.serverCommand = (player, cmd) => {
    player.getServer().runCommandSilent('execute as ' + player.uuid + ' run ' + cmd)
}

// ---- The animal body (Woodwalkers) -------------------------------------------
//
// An animal-born player is DRAWN as the creature recorded in nbt.animalForm (chosen by
// diet from their karma -- config.animalBirth), through Woodwalkers. Read from the
// installed walkers-5.8.13 jar (J40):
//   - `walkers switchShape <players> <entity id>` and `... normal` are op-level, so
//     they go through global.SMS.serverCommand.
//   - config/walkers.json5 "apiLevel": 0 (API_ONLY) turns off the player's own unlock
//     key, switch key and variant menu; the server re-checks it on the swap packet,
//     and the command does not consult it. Without it any player could hold U at a
//     cow and become one. The load-time check below warns when it is not set.
//   - PlayerShape.getCurrentShape(Player) returns the worn creature, or null.
//   - Woodwalkers writes max health (the attribute's base value) on every shape change
//     and on respawn -- which is why applyRealmEffects leaves it to the body.
// Woodwalkers is optional: without it an animal birth keeps the player's own body and
// every other animal rule still applies.
var walkersShapeClass = undefined

function walkersLoaded() {
    try {
        return Platform.isLoaded('walkers') === true
    } catch (ignored) {
        return false
    }
}

// The creature id the player is drawn as now: '' for their own body, null when it
// cannot be read (the caller then switches anyway -- the command is idempotent).
function wornForm(player) {
    try {
        if (walkersShapeClass === undefined) walkersShapeClass = Java.loadClass('tocraft.walkers.api.PlayerShape')
        var shape = walkersShapeClass.getCurrentShape(player)
        return shape ? '' + shape.type : ''
    } catch (ignored) {
        return null
    }
}

// The body an animal-born player should wear. Normally written at birth by the rebirth
// handler (from the stats that routed the birth); picked here, from the stats as they
// are now, when it is missing or no longer configured -- an admin `/karma realm <p>
// animal`, or a creature removed from the config since.
function animalFormOf(player) {
    var tag = global.SMS.persistedTag(player)
    var key = global.SMS.config.nbt.animalForm
    var form = global.SMS.nbtString(tag, key)
    if (form && global.SMS.animalDietOf(form)) return form
    var pick = global.SMS.animalFormFor(global.SMS.getStats(player), '' + player.uuid + ':' + (global.SMS.tickClock || 0))
    form = pick ? pick.form : ''
    tag.putString(key, form)
    return form
}

// Put the player in `form` (a creature id) or, for '', back in their own body.
// `owned` says whether a creature body is now worn -- and so owns max health.
// `force` sends the switch even when the body already reads as worn: the re-send a
// second after every birth (resyncBody below).
//
// `form` is normalised to a JS string FIRST. The first in-game test (2026-10-22) passed
// undefined here (N12 made the creature index NaN): the switch went to `normal` while
// `owned` read true, so the player stayed human AND max health was left to a body they
// did not have. Every decision below reads the one normalised value.
global.SMS.setBody = (player, form, force) => {
    var want = form ? '' + form : ''
    if (!walkersLoaded()) return { owned: false, note: want ? 'own (no Woodwalkers)' : 'own' }
    var worn = wornForm(player)
    if (!force && worn !== null && worn === want) return { owned: want !== '', note: want ? want + ' (already worn)' : 'own' }
    global.SMS.serverCommand(player, 'walkers switchShape @s ' + (want || 'normal'))
    return { owned: want !== '', note: want || (force ? 'own (re-sent)' : 'own (switched back)') }
}

// ---- The body, sent again a second after every birth ---------------------------
//
// Found in game 2026-10-24: a snow-leopard-born player reborn human could build and break
// (the server had switched them back -- the log said "body=own (switched back)") but was
// still DRAWN as the leopard. On a respawn Woodwalkers' CLIENT copies the old player's
// shape onto the new one (ClientRespawnHandler.respawn, walkers-5.8.13), and Samsara's
// switch is sent inside the same respawn; whichever the client applies last wins. So
// every applyRealmEffects (a birth, a login, /karma realm, liberation) queues the body to
// be sent once more BODY_RESYNC_TICKS later, unconditionally -- the switch is idempotent
// on the server -- and the realm tick sends it.
//
// Woodwalkers writes max health on a switch, and switching back to the player's own body
// restores ITS cached value (J40) -- which would undo a naraka birth's 10. So a re-send
// to the player's own body writes the realm's max health again after it, as
// applyRealmEffects does (body first, then health).
//
// A re-sent bird body also gets its flight back (Woodwalkers grants flight on a switch to
// a flying shape), so a flier born before the game-mode order was fixed can fly again.
const BODY_RESYNC_TICKS = 20
global.SMS.bodySync = global.SMS.bodySync || {}

function queueBodySync(player) {
    if (!walkersLoaded()) return
    global.SMS.bodySync['' + player.uuid] = (global.SMS.tickClock || 0) + BODY_RESYNC_TICKS
}

// The max health a realm sets on the player's own body.
function maxHealthTarget(fx) {
    return fx.maxHealth === undefined ? VANILLA_MAX_HEALTH : fx.maxHealth
}

function resyncBody(player) {
    var liberated = false
    try {
        liberated = global.SMS.isLiberated(player)
    } catch (ignored) {
        liberated = false
    }
    const realm = global.SMS.birthRealmOf(player)
    const fx = liberated ? {} : global.SMS.effectsFor(realm)
    const form = !liberated && realm === 'animal' ? animalFormOf(player) : ''
    const worn = wornForm(player)
    const body = global.SMS.setBody(player, form, true)
    if (!body.owned) player.setMaxHealth(maxHealthTarget(fx))
    console.info(
        `[Samsara] body re-sync: ${player.profile.name} -> ${body.note}` +
            ` (worn before: ${worn === null ? 'unreadable' : worn || 'own'})`
    )
}

// Say whether bodies are safe: Woodwalkers must be at API_ONLY, or players can unlock
// and switch bodies with its keys -- and nothing else would ever show it.
//
// Checked once the server has STARTED, never at script load. Woodwalkers applies its
// config's apiLevel from a level-load callback (Walkers.initialize registers a lambda
// on ServerLevel that calls ApiLevel.readConfig, J40), and KubeJS loads server scripts
// BEFORE any level loads -- so read at load, the level is always the DEFAULT it starts
// at. That was the false "not API_ONLY" warning in the first in-game test (2026-10-22).
// ServerEvents.loaded fires after the levels have loaded.
ServerEvents.loaded(event => {
    try {
        if (!walkersLoaded()) {
            console.warn('[Samsara] Woodwalkers is not installed: animal births keep the player body')
            return
        }
        var walkersLevel = '' + Java.loadClass('tocraft.walkers.api.platform.ApiLevel').getCurrentLevel()
        if (walkersLevel === 'API_ONLY') {
            console.info('[Samsara] animal bodies: Woodwalkers at API_ONLY -- only Samsara changes bodies')
        } else {
            console.warn(
                `[Samsara] Woodwalkers API level is ${walkersLevel}, not API_ONLY: players can unlock and` +
                    ' switch bodies themselves. Set "apiLevel": 0 in config/walkers.json5 and restart.'
            )
        }
    } catch (e) {
        console.warn(`[Samsara] could not read the Woodwalkers API level: ${e}`)
    }
})

// ---- Applying and clearing effects -----------------------------------------

// Max health is the only *persistent* attribute change so far, so it has to be
// actively reset when a player is reborn somewhere else -- otherwise a player who
// escapes hell keeps five hearts forever.
const VANILLA_MAX_HEALTH = 20.0

// Read the current max health.
//
// FIRST the attribute's base value, which is exactly what setMaxHealth writes. On
// 1.20.1 Rhino coerced the registry-id string into an Attribute (confirmed in game
// 2026-10-18: before=20, before=14). On KubeJS 7 the parameter is a
// Holder<Attribute>, and whether a string coerces into that is unverified.
//
// THEN vanilla getMaxHealth(), callable by its Mojang name on 1.21.1 (it was an
// unreachable SRG name on 1.20.1, where `player.maxHealth` threw and once disabled
// the penalty outright). It is the TOTAL value (base + modifiers), not the base --
// fine for the "does it differ" test and the log, since setMaxHealth is idempotent.
//
// Returns null when unreadable, which callers must treat as "set it anyway" rather
// than "skip": the whole point is that a missing getter must not disable the penalty.

// How often the realm tick runs. 4 ticks = 5x/second: often enough that the bar
// record the preta's meal correction reads is never more than a fraction of a second
// old, and Aging counts down in 4-tick steps. Cheap: a few reads per online
// player.
const REALM_INTERVAL_TICKS = 4
// A realm's effect (realmEffects.<realm>.effect) has no end, and is given again every this
// many passes -- about once a second -- so milk cannot lift it for long.
const EFFECT_EVERY_PASSES = 5

// On global.SMS, not a file-local `let`, for the same reason global.SMS.tickClock is:
// `global` survives /reload, so the tick's cadence is not reset every time the
// scripts reload. It also lets the offline harness drive the throttle deterministically
// instead of inheriting whatever phase an earlier test left it in. `realmPasses` counts
// the passes themselves, for the effect's, the torment's and the healing's own cadences.
global.SMS.realmCounter = global.SMS.realmCounter || 0
global.SMS.realmPasses = global.SMS.realmPasses || 0

// ---- Adventure mode (animal and preta births, decided 2026-10-22) -----------
//
// Real vanilla Adventure mode is what stops breaking, placing and using a tool on a
// block (ItemStack.useOn and buckets check Abilities.mayBuild): client-side too, so
// there is no ghost block or crack animation. It does NOT stop opening chests, doors
// or crafting tables -- noContainers below still refuses those.
//
// Writers of the game mode: an op's /gamemode, vanilla's forced default game mode on
// join, and this. So Samsara only ever swaps SURVIVAL -> ADVENTURE (recording that it
// did, in nbt.adventureSet) and, when the realm no longer wants it, puts back only an
// ADVENTURE it set itself. A player in creative or spectator (an admin, a tester) is
// left alone, and the rule then does not hold for them.
//
// ServerPlayer.setGameMode(GameType) and the public field gameMode
// (ServerPlayerGameMode.getGameModeForPlayer) are vanilla; KubeJS adds no gameMode bean
// of its own (ServerPlayerKJS, build 377), so neither name is shadowed.
function gameModeOf(player) {
    try {
        return '' + player.gameMode.getGameModeForPlayer().getName()
    } catch (ignored) {
        return ''
    }
}

// Returns a note for the realm-effects log line ('' when nothing applies).
function applyGameMode(player, want) {
    const tag = global.SMS.persistedTag(player)
    const key = global.SMS.config.nbt.adventureSet
    const ours = tag.getDouble(key) > 0
    const mode = gameModeOf(player)
    if (want) {
        if (mode === 'survival' && GameTypeClass) {
            player.setGameMode(GameTypeClass.ADVENTURE)
            tag.putDouble(key, 1)
            return 'adventure (set)'
        }
        if (mode === 'adventure') return 'adventure'
        return (mode || 'unreadable') + ' (left alone)'
    }
    if (!ours) return ''
    tag.putDouble(key, 0)
    if (mode === 'adventure' && GameTypeClass) {
        player.setGameMode(GameTypeClass.SURVIVAL)
        return 'survival (restored)'
    }
    return (mode || 'unreadable') + ' (left alone)'
}

// ---- Aging: every life's clock (config.aging, decided 2026-10-25) -----------------
//
// The CLOCK is stored (nbt.agingLeft, ticks left; 0 = none running) and counts down only
// while the player is online, in the realm tick below. Samsara's own Aging effect, whose
// timer is this clock, is DRAWN from it: given for the time left, re-given about once a
// second -- so milk, or anything else that clears it, cannot end the life early -- and
// replaced when the clock changes under it (a birth, /karma life, a preta's halving).
// `/effect give` cannot shorten a running effect, hence the clear first. When the clock
// runs out the player dies of old age (dieOfOldAge below).

// How long a life in `realm` lasts, in ticks. A realm missing from config.aging.ticks lives
// as long as a human: without a span it would be immortal (harness 13 checks none is
// missing).
function agingSpan(realm) {
    var spans = (global.SMS.config.aging || {}).ticks || {}
    var n = Number(spans['' + realm])
    if (!(n > 0)) n = Number(spans.human)
    return n > 0 ? n : 432000
}
global.SMS.agingSpan = agingSpan

function agingEffectId() {
    return (global.SMS.config.aging || {}).effect || 'samsara:aging'
}

function giveAging(player, left, replace) {
    var seconds = Math.ceil(left / 20)
    if (!isFinite(seconds) || seconds < 1) seconds = 1
    var id = agingEffectId()
    if (replace) global.SMS.serverCommand(player, 'effect clear @s ' + id)
    global.SMS.serverCommand(player, 'effect give @s ' + id + ' ' + seconds + ' 0 true')
}

// A realm's own effect (realmEffects.<realm>.effect: the Torment, the Craving, the
// Radiance), for the whole life: given with NO end (`infinite`, /effect since 1.19.4), so
// Aging stays the only clock, and renewed about once a second by the realm tick, so milk
// cannot lift it. Particles hidden.
function giveRealmEffect(player, fx) {
    if (fx.effect) global.SMS.serverCommand(player, 'effect give @s ' + fx.effect + ' infinite 0 true')
}

function minutesSeconds(ticks) {
    var s = Math.max(0, Math.ceil(ticks / 20))
    var h = Math.floor(s / 3600)
    var m = Math.floor((s % 3600) / 60)
    var r = s % 60
    if (h > 0) return h + ':' + (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r
    return m + ':' + (r < 10 ? '0' : '') + r
}
global.SMS.minutesSeconds = minutesSeconds

// A span in words, for the birth message: '6 hours', '30 minutes'.
function spanWords(ticks) {
    var mins = Math.round(ticks / 1200)
    if (mins >= 60 && mins % 60 === 0) return mins / 60 + (mins === 60 ? ' hour' : ' hours')
    return mins + (mins === 1 ? ' minute' : ' minutes')
}

// The effect a realm's rules give, for the teardown. clearPreviousLife clears it only for
// the realm whose effect Samsara gave last (nbt.effectsOf), so a human's own potions
// survive a login.
function realmEffectIds(fx) {
    return fx.effect ? [fx.effect] : []
}

// ---- Death by old age ----------------------------------------------------------------
//
// When Aging runs out the player DIES (the user, 2026-10-25: "real death by old age"):
// items drop -- a human's to its grave -- the death is routed by karma, and the karma that
// caused the birth ripens, as at any death. Two things differ, and both read
// global.SMS.diesOfOldAge(player) while the death handlers run:
//   - no delusion: dying of age is not carelessness (samsara_karma.js);
//   - ripening records no death, so the next one is not read as a "rapid repeat" of it
//     (samsara_decay.js, opts.oldAge).
// The mark is set around the blow only: LivingEntity.hurt -> die posts the death event
// synchronously, inside attack(), so every death handler runs while it is set.
//
// THE BLOW is Samsara's own damage type, samsara:old_age (kubejs/data/samsara/damage_type/;
// "<player> died of old age"), in minecraft:bypasses_invulnerability -- so a preta's ghost
// guard, creative mode and the totem of undying (it refuses a source with that tag) cannot
// hold it back -- and bypasses_armor / _resistance / _effects / _enchantments / _shield,
// no_impact, no_knockback (kubejs/data/minecraft/tags/damage_type/; generic_kill is in
// four of them). DamageSources.source(ResourceKey) is PRIVATE (read from the
// 1.21.1 jar), so the source is built as vanilla builds it: new DamageSource(Holder), the
// holder from the registry access. If the type cannot be read (a damage type is a datapack
// registry, loaded with the world) the blow is vanilla generic_kill, /kill's own source,
// in the same bypass tag. The amount is far past any health and golden hearts.
const OLD_AGE_DAMAGE = 1e9
const DamageSourceClass = loadVanilla('net.minecraft.world.damagesource.DamageSource')
const VanillaRegistriesClass = loadVanilla('net.minecraft.core.registries.Registries')
const ResourceKeyClass = loadVanilla('net.minecraft.resources.ResourceKey')

global.SMS.oldAgeDying = global.SMS.oldAgeDying || {}
global.SMS.diesOfOldAge = player => {
    try {
        return global.SMS.oldAgeDying['' + player.uuid] === true
    } catch (ignored) {
        return false
    }
}

var oldAgeTypeWarned = false
function oldAgeSource(player) {
    try {
        var key = ResourceKeyClass.create(VanillaRegistriesClass.DAMAGE_TYPE, ResourceLocationClass.parse(global.SMS.config.aging.damageType))
        var holder = player.registryAccess().registryOrThrow(VanillaRegistriesClass.DAMAGE_TYPE).getHolderOrThrow(key)
        return new DamageSourceClass(holder)
    } catch (e) {
        if (!oldAgeTypeWarned) {
            oldAgeTypeWarned = true
            console.warn(`[Samsara] the old-age damage type is unreadable; old age kills as /kill does: ${e}`)
        }
        return player.damageSources().genericKill()
    }
}

// Deal the blow. True when the player died. False when it did not land -- a player
// changing dimension is invulnerable to everything -- and agingStep then tries again on
// the next pass; warned once per player, as it would otherwise repeat five times a second.
global.SMS.oldAgeMissWarned = global.SMS.oldAgeMissWarned || {}
global.SMS.dieOfOldAge = player => {
    const id = '' + player.uuid
    const name = player.profile.name
    const source = oldAgeSource(player)
    global.SMS.oldAgeDying[id] = true
    try {
        player.attack(source, OLD_AGE_DAMAGE)
    } catch (e) {
        console.warn(`[Samsara] ${name}: the old-age blow failed: ${e}`)
    } finally {
        delete global.SMS.oldAgeDying[id]
    }
    var dead = false
    try {
        dead = !(Number(player.getHealth()) > 0)
    } catch (ignored) {
        dead = false
    }
    if (!dead) {
        if (!global.SMS.oldAgeMissWarned[id]) {
            global.SMS.oldAgeMissWarned[id] = true
            console.warn(`[Samsara] ${name}: Aging ran out but the old-age blow did not land; trying again each pass`)
        }
        return false
    }
    delete global.SMS.oldAgeMissWarned[id]
    console.info(`[Samsara] ${name} died of old age`)
    try {
        player.tell(Text.gray('Your life has run its course.'))
    } catch (ignored) {
        // messaging is best-effort
    }
    return true
}

// Set what is left of the player's life to `ticks` (at least 1) and redraw Aging for it
// -- /karma life, for testing. False for a liberated player: they no longer age.
global.SMS.setAgingLeft = (player, ticks) => {
    if (global.SMS.isLiberated(player)) return false
    var left = Math.max(1, Math.floor(Number(ticks) || 0))
    global.SMS.persistedTag(player).putDouble(global.SMS.config.nbt.agingLeft, left)
    giveAging(player, left, true)
    return true
}

// One step of the clock: re-arm a preta's halving once the belly has emptied, count down,
// re-give the effect about once a second, and end the life on the step that crosses zero.
// Returns what is left: 0 for no clock -- a player with none is never touched -- and -1
// after a death, so the realm tick does nothing more for the dead.
//
// At zero the clock is held at ONE tick until the blow lands, so a blow that does not is
// tried again on the next pass; the death zeroes it (resetLifeCounters, at the death, and
// here once more after it), so the next birth starts a full span.
function agingStep(player, fx, ticks) {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    var left = Number(tag.getDouble(nbt.agingLeft))
    if (!isFinite(left) || left <= 0) return 0
    var halving = fx.fullMealHalvesAging
    if (halving && halving.rearmFood !== undefined) {
        var food = Number(player.foodLevel)
        if (isFinite(food) && food <= halving.rearmFood) tag.putDouble(nbt.agingHalveArmed, 1)
    }
    left = left - ticks
    if (left <= 0) {
        tag.putDouble(nbt.agingLeft, 1)
        if (!global.SMS.dieOfOldAge(player)) return 1
        tag.putDouble(nbt.agingLeft, 0)
        return -1
    }
    tag.putDouble(nbt.agingLeft, left)
    if (left % 20 < ticks) giveAging(player, left, false)
    return left
}

// A preta's meal filled the bar: halve what is left of the life, if the belly has emptied
// since the last time (or since birth). Never below one tick, so the next step still ends
// the life.
function halveAging(player) {
    const nbt = global.SMS.config.nbt
    const tag = global.SMS.persistedTag(player)
    var left = Number(tag.getDouble(nbt.agingLeft))
    if (!isFinite(left) || left <= 0) return false
    if (!(tag.getDouble(nbt.agingHalveArmed) > 0)) {
        if (global.SMS.config.debugFood) console.info(`[Samsara] preta: ${player.profile.name} full, but not hungry since the last halving`)
        return false
    }
    var half = Math.floor(left / 2)
    if (half < 1) half = 1
    tag.putDouble(nbt.agingLeft, half)
    tag.putDouble(nbt.agingHalveArmed, 0)
    giveAging(player, half, true)
    console.info(`[Samsara] preta: ${player.profile.name} ate to the full -- the life halves, ${minutesSeconds(left)} -> ${minutesSeconds(half)}`)
    try {
        player.tell(Text.gray(`Full, for a moment. Half of this life falls away: ${minutesSeconds(half)} remain.`))
    } catch (ignored) {
        // messaging is best-effort
    }
    return true
}

// ---- The deva's gifts that are not attributes (realmEffects.deva) ----------------------
//
// The radiance carries Speed, Haste, Jump Boost, Luck, Water Breathing and the golden-heart
// CAP as attribute modifiers (startup_scripts/samsara_effects.js). These have none, so the
// realm tick does them; Resistance and Fire Resistance are the two native hooks at the end
// of this file.

// Golden hearts (absorption): filled to `amount`, never lowered, at birth and every
// `everyTicks` of the life lived. setAbsorptionAmount clamps to the max_absorption
// attribute (LivingEntity, 1.21.1), which the radiance raises to 16 -- so this runs AFTER
// the radiance is given, never before.
function fillAbsorption(player, a) {
    var want = Number(a.amount)
    if (!isFinite(want) || want <= 0) return false
    var cur = Number(player.getAbsorptionAmount())
    if (isFinite(cur) && cur >= want) return false
    player.setAbsorptionAmount(want)
    return true
}

// Regeneration: `amount` health, while below max -- as vanilla's RegenerationMobEffect.
function healStep(player, h) {
    var health = Number(player.getHealth())
    var max = Number(player.getMaxHealth())
    if (!isFinite(health) || !isFinite(max) || health >= max) return false
    player.heal(Number(h.amount))
    return true
}

function readMaxHealth(player) {
    try {
        var v = Number(player.getAttributeBaseValue('minecraft:generic.max_health'))
        if (isFinite(v) && v > 0) return v
    } catch (ignored) {
        // no string -> Holder coercion; try the vanilla getter
    }
    try {
        var t = Number(player.getMaxHealth())
        if (isFinite(t) && t > 0) return t
    } catch (ignored2) {
        // neither readable
    }
    return null
}

// ---- Clearing the PREVIOUS life -------------------------------------------
//
// DESIGN RULE: nothing from a previous life may carry into the current one.
//
// Most realm penalties are checked LIVE against birthRealm, so they stop applying the
// instant birthRealm changes and need no teardown. But anything that is stored --
// an attribute, queued work, a cached decision -- survives the rebirth unless it is
// explicitly cleared, and that is a bug every time.
//
// This function is the single place that resets stored per-life state. Every new
// effect that writes something persistent MUST be undone here, not just skipped while
// the new realm is active.
//
// Registry of what is stored vs live, as of 2026-10-25 (1.21.1):
//   maxHealth       STORED attribute        -> reset by applyRealmEffects (new value),
//                                              or left to a worn creature body
//   body            STORED Woodwalkers shape -> set by applyRealmEffects every birth:
//                                              the new creature, or back to the player
//   adventureMode   STORED game mode        -> set or put back by applyRealmEffects
//                                              (only what Samsara set: nbt.adventureSet)
//   effect          STORED mob effect, with -> cleared below when the realm whose effect
//                   no end (and the            it is (nbt.effectsOf) is not the realm
//                   attribute modifiers it     applied now; the modifiers go with it.
//                   carries)                   Re-given by the realm tick
//   aging clock     STORED nbt.agingLeft    -> zeroed at death (resetLifeCounters) and at
//   + the Aging     and a mob effect           liberation; a new birth starts a full span
//     effect                                   and REPLACES the effect (applyRealmEffects)
//   golden hearts   STORED absorption       -> capped by the radiance's max_absorption, so
//                                              they go when the radiance does
//   body re-send    QUEUED global.SMS.bodySync -> re-queued by every applyRealmEffects;
//                                              sends whatever body birthRealm says then
//   torment, heal,  live checks (the realm tick) -> no teardown needed
//   exhaustion
//   resistance,     live checks (native hooks) -> no teardown needed
//   fireImmune
//   notify cooldown STORED throttle         -> cleared below
//   grave keys      STORED in Samsara's keep outside a human life (nbt.graveKeys)
//                                           -> synced by applyRealmEffects
//                                              (samsara_tombstone.js)
//   noCrafting      live check              -> no teardown needed
//   noContainers    live check              -> no teardown needed
//   noDamage        live check              -> no teardown needed
//   ignoredByMobs   live check              -> no teardown needed
//   pickUp          live check              -> no teardown needed
//   foodPerMeal     live check, corrected inside the meal itself -> nothing stored
// (The 1.20.1 pendingFoodPenalty queue is gone: the meal is now corrected inside
// foodEaten, so nothing is queued that could land on the next body.)
// `now` is the realm whose rules are applied next ('' for none: liberation).
global.SMS.clearPreviousLife = (player, now) => {
    var cleared = []

    // A realm's effect is STORED state on the player, and has no end: a MobEffect persists
    // until it is removed, so a preta reborn as a human without a death (/karma realm)
    // would otherwise keep the Insatiable Craving of a life it no longer has. (A death
    // clears every effect in vanilla -- the respawned player is a new entity, and effects
    // are not copied to it.) It is cleared for the realm whose effect Samsara gave LAST
    // (nbt.effectsOf), and only when that is not the realm applied now, so a LOGIN clears
    // nothing -- and never a human's own potions. (The 10-22 hunger effect was cleared
    // unconditionally at every apply, a human's Hunger from rotten flesh included; the
    // hunger is Samsara's own exhaustion since 2026-10-25, so there is no effect to clear.)
    try {
        if (player.isPlayer()) {
            var tag = global.SMS.persistedTag(player)
            var key = global.SMS.config.nbt.effectsOf
            var prev = global.SMS.nbtString(tag, key)
            if (prev && prev !== '' + (now || '')) {
                var ids = realmEffectIds(global.SMS.effectsFor(prev))
                for (var j = 0; j < ids.length; j++) global.SMS.serverCommand(player, 'effect clear @s ' + ids[j])
                tag.putString(key, '')
                cleared.push(prev + 'Effects')
            }
        }
    } catch (ignored) {
        // no server to run it on; the effect stays until milk or a death clears it
    }

    // The anti-spam timer for refusal messages. Harmless, but a stale entry means the
    // first refusal in a new life can be silently swallowed.
    try {
        var id2 = '' + player.uuid
        if (global.SMS.lastNotified && global.SMS.lastNotified[id2] !== undefined) {
            delete global.SMS.lastNotified[id2]
            cleared.push('notifyCooldown')
        }
    } catch (ignored) {
        // nothing to clear
    }

    return cleared
}

global.SMS.applyRealmEffects = player => {
    const realm = global.SMS.birthRealmOf(player)

    // A liberated player is outside the cycle, so realm penalties no longer apply --
    // the project notes' liberation section lists realm penalties among the things turned
    // off. An empty effects table makes the code below reset maxHealth to vanilla 20,
    // put back Adventure mode, end Aging for good, and leaves every live-checked
    // restriction (crafting, containers, damage, pickup) reading as absent, which is
    // exactly the intended teardown. Routing
    // the liberation case through the SAME path rather than returning early is what
    // guarantees a player liberated while born-naraka does not keep five hearts.
    var liberated = false
    try {
        liberated = global.SMS.isLiberated(player)
    } catch (ignored) {
        liberated = false
    }

    const fx = liberated ? {} : global.SMS.effectsFor(realm)
    const target = maxHealthTarget(fx)

    // Tear down stored state from the life that just ended, BEFORE applying the new
    // realm's effects. Note maxHealth is handled by the set below rather than here:
    // it is always written to the NEW realm's value (defaulting to vanilla 20), so a
    // realm with no maxHealth entry actively resets it rather than inheriting.
    const cleared = global.SMS.clearPreviousLife(player, liberated ? '' : realm)

    // ADVENTURE MODE FIRST: set for a realm that wants it, put back when it no longer
    // does (a liberated player's fx is empty, so liberation puts it back too).
    //
    // BEFORE THE BODY, because both write the player's flight. Writers of
    // Abilities.mayfly: vanilla's setGameMode (GameType.updatePlayerAbilities sets it
    // false for survival and adventure -- read from the 1.21.1 jar), and Woodwalkers'
    // shape switch (FlightHelper.grantFlightTo for a flying shape; revokeFlight leaving
    // one). Found in game 2026-10-24: a bird-born player could not fly -- the body went
    // on (flight granted) and Adventure mode went on after it (flight taken away).
    var modeNote = ''
    try {
        modeNote = applyGameMode(player, fx.adventureMode === true)
    } catch (e) {
        console.warn(`[Samsara] could not set the game mode of ${player.profile.name}: ${e}`)
        modeNote = 'failed'
    }

    // THE BODY, then max health -- in that order, here, because both write max health.
    // Writers of the max-health base value: Woodwalkers (from the creature, on every
    // shape change and respawn; and switching back to the player's own body restores
    // its cached player value) and this function (the realm's value). So the body goes
    // FIRST, and then:
    //   - a creature body is worn -> its health stands; Samsara writes nothing.
    //   - the player's own body   -> Samsara writes the realm's value over whatever
    //                                Woodwalkers restored.
    // A liberated player wears their own body: the animal realm no longer holds them.
    const form = !liberated && realm === 'animal' ? animalFormOf(player) : ''
    var body = { owned: false, note: 'own' }
    try {
        body = global.SMS.setBody(player, form)
    } catch (e) {
        console.warn(`[Samsara] could not set the body of ${player.profile.name} to '${form}': ${e}`)
        body = { owned: false, note: 'own (switch failed)' }
    }

    var current = readMaxHealth(player)

    // Set unconditionally when we cannot read the current value -- idempotent, and far
    // better than skipping the penalty because a getter is missing.
    var applied = false
    if (!body.owned && (current === null || current !== target)) {
        try {
            player.setMaxHealth(target)
            applied = true
        } catch (e) {
            console.warn(`[Samsara] setMaxHealth(${target}) failed: ${e}`)
        }
    }

    // THE REALM'S EFFECT (the Torment, the Craving, the Radiance), for the whole life:
    // given at once, renewed by the realm tick.
    try {
        giveRealmEffect(player, fx)
    } catch (e) {
        console.warn(`[Samsara] could not give the realm effect of ${player.profile.name}: ${e}`)
    }

    // AGING, every life's clock (config.aging): start a full span at a birth (the clock is
    // 0 then -- resetLifeCounters zeroes it at death, and /karma realm before re-applying),
    // keep it at a login, and end it for good at liberation. A new span REPLACES the Aging
    // effect -- /effect give cannot shorten one still running from the life before (a
    // /karma realm birth, which has no death to clear it).
    //
    // A deva's first golden hearts come after, because the radiance given just above is
    // what raises their cap (fillAbsorption).
    var agingNote = ''
    try {
        var nbt = global.SMS.config.nbt
        var tag = global.SMS.persistedTag(player)
        var agingLeft = Number(tag.getDouble(nbt.agingLeft))
        if (liberated) {
            if (agingLeft > 0) {
                tag.putDouble(nbt.agingLeft, 0)
                cleared.push('aging')
            }
            global.SMS.serverCommand(player, 'effect clear @s ' + agingEffectId())
            agingNote = ' aging=none (liberated)'
        } else {
            var fresh = !(agingLeft > 0)
            if (fresh) {
                agingLeft = agingSpan(realm)
                tag.putDouble(nbt.agingLeft, agingLeft)
                tag.putDouble(nbt.agingHalveArmed, 0)
            }
            giveAging(player, agingLeft, fresh)
            agingNote = ` aging=${minutesSeconds(agingLeft)}` + (fresh ? ' (new)' : ' left')
            if (fresh && fx.absorption) fillAbsorption(player, fx.absorption)
        }
    } catch (e) {
        console.warn(`[Samsara] could not set the Aging of ${player.profile.name}: ${e}`)
    }

    // Which realm's effect Samsara has now given, for the next teardown.
    try {
        if (realmEffectIds(fx).length > 0) global.SMS.persistedTag(player).putString(global.SMS.config.nbt.effectsOf, realm)
    } catch (ignored) {
        // the next teardown then clears nothing of this realm's
    }

    // GRAVE KEYS: held only in a human life (config.graves). Synced at EVERY apply --
    // a birth, a login, /karma realm, liberation -- so they follow
    // birthRealm the moment it changes. Last, because it reads the liberation flag and
    // birthRealm this call has just acted on. A respawn syncs once more a tick later
    // (samsara_tombstone.js): Tombstone hands keys back at LOWEST priority, after this.
    var keyNote = ''
    try {
        if (global.SMS.graves) keyNote = global.SMS.graves.syncKeys(player)
    } catch (e) {
        console.warn(`[Samsara] could not sync the grave keys of ${player.profile.name}: ${e}`)
        keyNote = 'failed'
    }

    // The body once more, a second from now (resyncBody above).
    try {
        queueBodySync(player)
    } catch (ignored) {
        // the birth's own switch stands
    }

    // Log loudly enough that the next in-game test can CONFIRM this landed, rather
    // than us inferring it from the health bar. Reads back the attribute afterwards.
    var after = readMaxHealth(player)
    console.info(
        `[Samsara] realm effects: ${player.profile.name} born-${realm} body=${body.note}` +
            (body.owned
                ? ` maxHealth=${after} (the body's)`
                : ` maxHealth target=${target} before=${current} after=${after} (setMaxHealth called: ${applied})`) +
            (modeNote ? ` mode=${modeNote}` : '') +
            agingNote +
            (keyNote ? ` keys=${keyNote}` : '') +
            (cleared.length > 0 ? ` [cleared from previous life: ${cleared.join(', ')}]` : '')
    )

    // Current health is deliberately NOT touched -- the port keeps 1.20.1's behaviour.
    // (On 1.20.1 there was no reachable setHealth at all; on 1.21.1 vanilla
    // setHealth/getHealth are callable, so lowering health to the new maximum at once
    // is now possible -- a proposal, not done unasked.) Vanilla clamps health to the
    // maximum on its own, so a player who drops from 20 max to 10 may briefly show a
    // full bar until the next damage or regen tick.

    return realm
}

// Re-apply whenever the player's realm could have changed or the entity was rebuilt.
PlayerEvents.loggedIn(event => {
    global.SMS.applyRealmEffects(event.player)
})

// ORDERING. This used to claim it "runs after the rebirth handler has written the new
// birthRealm". It does not. This file loads before samsara_rebirth.js (alphabetically
// on 1.20.1; by priority 60 > 40 on 1.21.1), so this handler registers first and
// therefore runs first -- reading the PREVIOUS life's birthRealm.
//
// That is why forcing naraka and dying left the player on full health: at the moment
// this ran, birthRealm was still the old realm, so it applied that realm's effects
// (or reset to 20.0) and the rebirth handler then wrote 'naraka' with nothing left to
// re-read it.
//
// Rather than depend on file names, samsara_rebirth.js now calls applyRealmEffects
// itself right after it writes birthRealm. This handler stays as a safety net for
// respawns that the rebirth hook skips (notably an End return, where birthRealm is
// deliberately left alone and the existing realm's effects must persist).
PlayerEvents.respawned(event => {
    // Skip when the rebirth hook is going to handle this respawn itself.
    //
    // Both files hook this event and load order puts THIS one first, so
    // it would otherwise run against the previous life's birthRealm -- visible in the
    // log as a stale pair:
    //     born-asura target=20 ...   <- this handler, old realm
    //     born-preta target=14 ...   <- rebirth hook, correct
    // The result was still right because the correct call landed second, but the first
    // call was wasted work and made the log actively misleading.
    //
    // samsara_rebirth.js sets pendingRebirth at death and clears it when it places the
    // player. If an entry is present, the rebirth hook has not run yet and WILL call
    // applyRealmEffects with the new realm -- so there is nothing useful to do here.
    try {
        var key = '' + event.entity.uuid
        if (global.SMS.pendingRebirth && global.SMS.pendingRebirth[key]) return
    } catch (ignored) {
        // cannot tell: fall through and apply, which is the safe direction
    }

    global.SMS.applyRealmEffects(event.entity)
})

// ---- Realm restrictions (animal, preta) --------------------------------------

// Which restriction applies to THIS player right now, read fresh from birthRealm
// every time so it stops the instant they are reborn elsewhere.
//
// The old helper was `isAnimalBorn()`, which returned `noCrafting === true` and was
// then used to gate the CONTAINER and BLOCK-PLACING handlers as well. That coupled
// independent restrictions to one flag: giving any realm noCrafting would silently
// switch on restrictions it never asked for. Each handler asks for the specific effect
// it enforces.
function hasEffect(player, name) {
    if (!player) return false
    try {
        if (!player.isPlayer()) return false
    } catch (ignored) {
        return false
    }

    // Liberation turns every realm penalty off. Checked here rather than in each
    // caller because the live restrictions (crafting, containers, damage, and anything
    // added later) funnel through this one function -- so a liberated player born into
    // the animal realm can craft and open things again, which is what "realm penalties
    // are turned off for them" means in the project notes.
    try {
        if (global.SMS.isLiberated(player)) return false
    } catch (ignored) {
        // isLiberated unavailable (karma script not loaded): fall through and apply
        // the realm's effects normally rather than silently freeing everyone.
    }

    return global.SMS.effectsFor(global.SMS.birthRealmOf(player))[name] === true
}

// Who is refused, for the message: 'An animal' or 'A hungry ghost'.
function beingOf(player) {
    return global.SMS.birthRealmOf(player) === 'preta' ? 'A hungry ghost' : 'An animal'
}

// Tell the player why something was refused, but not on every tick of a held click.
const NOTIFY_COOLDOWN_TICKS = 40
// On global.SMS so global.SMS.clearPreviousLife() can reset a player's entry when
// they are reborn. Survives /reload, which is fine -- it is only a message throttle.
global.SMS.lastNotified = global.SMS.lastNotified || {}

function refuse(player, message) {
    try {
        var id = player.uuid ? '' + player.uuid : '' + player.profile.name
        var now = global.SMS.tickClock || 0
        var prev = global.SMS.lastNotified[id]
        if (prev === undefined || now - prev >= NOTIFY_COOLDOWN_TICKS || now < prev) {
            global.SMS.lastNotified[id] = now
            player.tell(Text.gray(message))
        }
    } catch (ignored) {
        // messaging is best-effort
    }
}
// Shared with samsara_tombstone.js (the grave refusals), so every refusal shares one
// throttle and one teardown (clearPreviousLife).
global.SMS.refuse = refuse

// Does this block id look like something a restricted player should not open?
function isContainerBlock(id) {
    const suffixes = global.SMS.config.containerBlockSuffixes
    for (let i = 0; i < suffixes.length; i++) {
        if (id.endsWith(suffixes[i])) return true
    }
    return false
}

// Block crafting.
//
// ItemEvents.crafted is not cancellable on KubeJS 6 or 7 (both jars: it is posted from
// the craft-result notification, after the fact), so crafting cannot be prevented
// outright. Two levers together get close:
//
//   1. Station access is refused below, which covers the crafting table, anvil,
//      smithing table, loom, stonecutter and the rest.
//   2. The 2x2 inventory grid is client-driven, so the only server-side recourse is
//      to destroy the result after the fact. Crude, but it means an animal gains
//      nothing by crafting, and the message explains why.
ItemEvents.crafted(event => {
    const player = event.entity
    if (!hasEffect(player, 'noCrafting')) return

    try {
        event.item.setCount(0)
        refuse(player, 'An animal cannot craft.')
    } catch (ignored) {
        // if the stack cannot be emptied, the player simply keeps the item
    }
})

// BUILDING AND BREAKING are Adventure mode's job (applyRealmEffects, decided
// 2026-10-22). Until then two handlers refused an animal's placing -- a rightClicked
// gate on a held BlockItem and a BlockEvents.placed backstop, filtered because NeoForge
// fires `placed` for every block a tool changes. Adventure mode stops all of it in
// vanilla, tools included, so both are gone (git history has them).

// ---- What a body may eat (animal diets, decided 2026-10-22) ------------------

// The diet of an animal-born player's body. A body with no configured diet reads as
// an omnivore: it may both graze and hunt, so a config gap can never starve anyone.
function dietOfPlayer(player) {
    const form = global.SMS.nbtString(global.SMS.persistedTag(player), global.SMS.config.nbt.animalForm)
    return global.SMS.animalDietOf(form) || 'omnivore'
}

// GRAZING: a herbivore (or omnivore) right-clicks grass with an empty main hand and
// eats it; the block turns to dirt, as a sheep's grass does (SheepEatBlockGoal plays
// level event 2001, the block's break particles and sound, and sets DIRT -- the same
// two calls here). Fires only for the main hand: NeoForge posts RightClickBlock once
// per hand, and an empty main hand is what "eating with the mouth" means. Not while
// the bar is full, as vanilla will not let a player eat then.
//
// Adventure mode does not stop this: the right-click still reaches the server (it
// opens doors and presses buttons), and the block is changed here, not by the player.
//
// Returns true when it grazed. Nothing here cancels the event.
global.SMS.graze = (player, event) => {
    const g = (global.SMS.config.animalBirth || {}).graze
    if (!g) return false
    try {
        if (global.SMS.isLiberated(player)) return false
    } catch (ignored) {
        // fall through
    }
    if (global.SMS.birthRealmOf(player) !== 'animal') return false
    if ((g.diets || []).indexOf(dietOfPlayer(player)) === -1) return false

    var hand = ''
    var from = ''
    try {
        hand = '' + event.getHand()
        from = '' + event.block.id
        if (!player.getMainHandItem().isEmpty()) return false
    } catch (ignored) {
        return false
    }
    if (hand !== 'MAIN_HAND') return false
    const to = g.blocks[from]
    if (!to) return false
    var food = Number(player.foodLevel)
    if (!isFinite(food) || food >= 20) return false

    try {
        var before = event.block.getBlockState()
        // The block FIRST: if it cannot be changed, nothing was eaten.
        event.block.setBlockState(BuiltInRegistriesClass.BLOCK.get(ResourceLocationClass.parse(to)).defaultBlockState())
        player.addFood(g.nutrition, g.saturationModifier)
        try {
            event.block.getLevel().levelEvent(2001, event.block.getPos(), VanillaBlockClass.getId(before))
            player.swing(event.getHand(), true)
        } catch (ignored2) {
            // feedback only
        }
        if (global.SMS.config.debugFood) {
            console.info(`[Samsara] ${player.profile.name} grazed ${from} -> ${to}: food ${food} -> ${player.foodLevel}`)
        }
        return true
    } catch (e) {
        console.warn(`[Samsara] grazing failed for ${player.profile.name}: ${e}`)
        return false
    }
}

// Containers, and grazing.
//
// BlockEvents.rightClicked is NeoForge's PlayerInteractEvent.RightClickBlock, posted
// once per hand with that hand's stack as event.item. Cancelling denies the
// interaction server-side: nothing opens. (On 1.20.1 the cancel sat inside a try,
// which caught the exit and un-cancelled it.)
//
// Refused through hasEffect(), which checks liberation. The 1.20.1 handler read the
// realm's effects directly and so still refused a LIBERATED animal-born player.
BlockEvents.rightClicked(event => {
    const player = event.player
    if (!player) return

    // 1. Grazing (an animal's mouth on the grass) -- never a container, so first.
    if (global.SMS.graze(player, event)) return

    // 2. Containers and workstations: refuse opening them at all.
    if (hasEffect(player, 'noContainers')) {
        var id = ''
        try {
            id = '' + event.block.id
        } catch (ignored) {
            id = ''
        }
        if (id && isContainerBlock(id)) {
            refuse(player, beingOf(player) + ' cannot work that.')
            event.cancel()
        }
    }
})

// ---- Picking up: a ghost holds only food, an animal only what it eats --------
//
// KubeJS 7's ItemEvents.canPickUp is NeoForge's ItemEntityPickupEvent.Pre, and its
// cancel() sets canPickup to FALSE (KubeJSItemEventHandler.itemPickupPre ->
// EventResult.applyTristate; read from the jar). The event is ItemPickedUpKubeEvent:
// getEntity() is the PLAYER (as on entityInteracted, N9) and getItem() the stack --
// read through those explicit getters, since its `entity` FIELD is the item entity.
// It fires every tick the player stands on an item, so the refusal is silent.

// Item tags for meat, built once from config.animalBirth.meat.tags.
var meatTagKeys = null
function meatTags() {
    if (meatTagKeys !== null) return meatTagKeys
    meatTagKeys = []
    try {
        var TagKeyClass = Java.loadClass('net.minecraft.tags.TagKey')
        var RegistriesClass = Java.loadClass('net.minecraft.core.registries.Registries')
        var ids = ((global.SMS.config.animalBirth || {}).meat || {}).tags || []
        for (var i = 0; i < ids.length; i++) meatTagKeys.push(TagKeyClass.create(RegistriesClass.ITEM, ResourceLocationClass.parse(ids[i])))
    } catch (e) {
        console.warn(`[Samsara] could not build the meat tags; only the listed meat ids count: ${e}`)
    }
    return meatTagKeys
}

function isMeat(stack) {
    try {
        if ((((global.SMS.config.animalBirth || {}).meat || {}).items || []).indexOf('' + stack.id) !== -1) return true
        var tags = meatTags()
        for (var i = 0; i < tags.length; i++) {
            if (stack.is(tags[i])) return true
        }
    } catch (ignored) {
        // unreadable stack: not meat
    }
    return false
}

function isFood(stack, player) {
    try {
        return !!stack.getFoodProperties(player)
    } catch (ignored) {
        return false
    }
}

// May this player pick this stack up? True whenever no rule applies.
global.SMS.mayPickUp = (player, stack) => {
    if (!player || !stack) return true
    try {
        if (!player.isPlayer() || global.SMS.isLiberated(player)) return true
    } catch (ignored) {
        return true
    }
    const fx = global.SMS.effectsFor(global.SMS.birthRealmOf(player))
    var rule = fx.pickUp
    if (rule === 'diet') rule = ((global.SMS.config.animalBirth || {}).pickUpByDiet || {})[dietOfPlayer(player)] || 'meat'
    if (rule === 'none') return false
    if (rule === 'food') return isFood(stack, player)
    if (rule === 'meat') return isMeat(stack)
    return true
}

ItemEvents.canPickUp(event => {
    var player = null
    var stack = null
    try {
        player = event.getEntity()
        stack = event.getItem()
    } catch (ignored) {
        return
    }
    if (global.SMS.mayPickUp(player, stack)) return
    event.cancel()
})

// ---- Birth: say what the new life's rules are ---------------------------------
//
// Called by samsara_rebirth.js after a rebirth and by /karma realm -- a BIRTH, never a
// login. Nobody can guess "right-click grass to eat" from the HUD.

// Was this birth anchored at the player's last human death (samsara_rebirth.js)?
function hauntsGrave(player) {
    try {
        return !!(global.SMS.graveAnchor && global.SMS.graveAnchor(player, 'preta'))
    } catch (ignored) {
        return false
    }
}
global.SMS.tellBirthRules = player => {
    try {
        if (global.SMS.isLiberated(player)) return
        var realm = global.SMS.birthRealmOf(player)
        var lines = []
        if (realm === 'preta') {
            lines = [
                'You are born a hungry ghost' + (hauntsGrave(player) ? ', where you last died as a human.' : '.'),
                '  Nothing can harm you, and nothing hunts you. Your Insatiable Craving never leaves you: always slow, weak and starving.',
                '  You can hold only food, and each meal is one crumb. Go hungry, then eat until full, and half of what remains of this life falls away.',
                '  You cannot build, break, open containers, or open a grave.',
            ]
        } else if (realm === 'animal') {
            var diet = dietOfPlayer(player)
            lines = ['You are born an animal (' + diet + ').']
            if (diet !== 'carnivore') lines.push('  Graze: right-click grass with an empty hand.')
            if (diet !== 'herbivore') lines.push('  You can pick up and eat only meat.')
            if (diet === 'herbivore') lines.push('  You can pick up nothing. A herbivore that lets a predator take it, without fighting back, gives the gift of its body.')
            lines.push('  You cannot build, break, craft, or open containers.')
        } else if (realm === 'deva') {
            lines = [
                'You are born a deva, in the Radiance of the Blessed.',
                '  All this life you mend, endure and move as no human can; fire cannot harm you, and no creature will hunt you.',
            ]
        } else if (realm === 'naraka') {
            var t = global.SMS.effectsFor('naraka').torment
            lines = [
                'You are born in Naraka, in Self-wrought Torment.',
                '  Your body is halved. You wither, slow, weak and starving, and your tools bite slowly.',
                '  The torment is your own, and it will not end you: it never takes you below ' + (t ? t.floorHealth / 2 : '?') + ' heart.',
            ]
        } else if (realm === 'asura') {
            lines = ['You are born an asura, at the foot of the mountains of heaven.']
        } else if (realm === 'brahma') {
            lines = ['You are born in the Brahma realm.']
        } else {
            lines = ['You are born human.']
        }
        // Every birth ages (config.aging).
        lines.push('  Aging: this life lasts ' + spanWords(agingSpan(realm)) + ' of play. When it runs out, you die of old age.')
        for (var i = 0; i < lines.length; i++) player.tell(i === 0 ? Text.yellow(lines[i]) : Text.gray(lines[i]))
    } catch (ignored) {
        // messaging is best-effort
    }
}

// ---- Preta (hungry ghost) realm --------------------------------------------
//
// A huge belly and a pinhole mouth: every meal the preta eats is ONE crumb
// (foodPerMeal), whatever the food -- decided 2026-10-22, replacing the 0.2 multiplier.
// Once feeding others exists (design doc 7), giving food away will be the efficient
// way to eat, and generosity becomes the escape route rather than a side activity.
//
// TIMING (read from both jars, 2026-10-21 -- the 1.20.1 version never worked). KubeJS
// fires foodEaten at HEAD of LivingEntity.eat(), but Player.eat() calls
// getFoodData().eat(food) FIRST and only then super.eat(). So for a PLAYER this
// handler sees the bar AFTER the meal. The 1.20.1 version took a "pre-meal" snapshot
// here, measured gained = 0 on the next tick and left through "no measurable gain":
// the multiplier never applied.
//
// THE MEAL IS READABLE on 1.21.1: Item.finishUsingItem passes exactly
// stack.getFoodProperties(entity) to eat(), FoodProperties.nutrition() is a plain
// accessor, and the stack is not consumed until later in LivingEntity.eat(). So the
// correction is exact and immediate -- no queue, nothing that could land on the next
// body after a death.
//
// EXCEPT WHEN VANILLA CLAMPED THE BAR AT 20. Then `bar - nutrition` reads LOW: a preta
// on 19 eating a steak (8) is left on 20, and backing out 8 gives 12 -- the "crumb"
// would TAKE six points. The 3-icon cap made that unreachable; without the cap it is
// the common case. So the preta tick records the bar every pass
// (global.SMS.pretaLastFood), and a meal that ends on 20 backs out to that instead.
// The bar only falls between passes (hunger, exertion), so the record is never low --
// at worst one point high, which can only ever give the preta a point, never take one.
//
// Writers of foodLevel, in tick order (the project notes: enumerate the writers before
// constraining a value): vanilla FoodData.tick (exhaustion and regen; Samsara's realm
// tick adds the Insatiable Craving's exhaustion, which FoodData.tick then spends) ->
// vanilla FoodData.eat (the meal) -> THIS correction, inside the same eat() call. The
// realm tick otherwise only READS the bar (the record, and the halving's re-arm).
// Nothing clamps it any more.
global.SMS.pretaLastFood = global.SMS.pretaLastFood || {}

ItemEvents.foodEaten(event => {
    // DIAGNOSTIC LOGGING (config.debugFood). Every exit path below is logged when it
    // is on, because every one of them is a SILENT return: the old version of this
    // hook failed completely and left no trace at all in the log, which is what made
    // it survive a full test round. Off by default -- it is one line per bite.
    var dbg = false
    try {
        dbg = global.SMS.config.debugFood === true
    } catch (ignored) {
        dbg = false
    }

    const player = event.entity
    if (!player || !player.isPlayer()) {
        if (dbg) console.info('[Samsara] foodEaten: entity is not a player; ignored')
        return
    }

    // Liberation turns realm penalties off. This handler cannot use hasEffect()
    // because foodPerMeal is a NUMBER, not a boolean flag, so it needs its own
    // guard -- the preta food penalty would otherwise outlive liberation.
    try {
        if (global.SMS.isLiberated(player)) {
            if (dbg) console.info('[Samsara] foodEaten: player is liberated; no penalty')
            return
        }
    } catch (ignored) {
        // fall through and apply normally
    }

    const realm = global.SMS.birthRealmOf(player)
    const fx = global.SMS.effectsFor(realm)
    const per = fx.foodPerMeal
    if (per === undefined) {
        if (dbg) console.info(`[Samsara] foodEaten: born-${realm} has no foodPerMeal; full meal`)
        return
    }

    // The bar as vanilla left it: ALREADY raised by this meal (see TIMING above).
    var cur = Number(player.foodLevel)
    if (!isFinite(cur)) {
        // The one failure that would be invisible AND fatal to the penalty, so it
        // warns even with the diagnostic off.
        console.warn('[Samsara] foodEaten: player.foodLevel unreadable; penalty skipped')
        return
    }

    // Saturation goes entirely, on every path below: a hungry ghost is never
    // satisfied. Done first so an early return cannot skip it.
    try {
        var sat = Number(player.saturation)
        if (isFinite(sat) && sat > 0) player.setSaturation(0)
    } catch (ignored) {
        // saturation unwritable; the food correction below still runs
    }

    // What this meal gave. Never silent on failure: the 1.20.1 hook's silent catch
    // hid an unreachable nutrition read for a whole test round.
    var nutrition = NaN
    try {
        nutrition = Number(event.item.getFoodProperties(player).nutrition())
    } catch (e) {
        console.warn(`[Samsara] foodEaten: meal nutrition unreadable; preta meal kept in full: ${e}`)
        return
    }
    if (!isFinite(nutrition) || nutrition <= 0) {
        if (dbg) console.info(`[Samsara] foodEaten: meal gives no nutrition (${nutrition}); saturation cleared only`)
        return
    }

    const key = '' + player.uuid
    try {
        // Back out the meal, then keep the crumb.
        var pre = cur - nutrition
        if (cur >= 20) {
            // Vanilla clamped the meal at 20: back out to the bar last seen instead.
            var snap = Number(global.SMS.pretaLastFood[key])
            if (isFinite(snap) && snap > pre && snap <= 20) pre = snap
        }
        if (pre < 0) pre = 0
        var kept = Math.min(per, nutrition)
        var next = pre + kept
        if (next > cur) next = cur // never ADD food
        next = Math.floor(next)
        player.setFoodLevel(next)
        global.SMS.pretaLastFood[key] = next

        if (dbg) {
            console.info(
                `[Samsara] preta meal: ${player.profile.name} nutrition ${nutrition}` +
                    ` -> kept ${kept}; food ${cur} -> ${next}`
            )
        }

        // A full belly halves what is left of the life (if it has gone hungry since).
        if (next >= 20 && fx.fullMealHalvesAging) halveAging(player)
    } catch (e) {
        console.warn(`[Samsara] foodEaten: preta correction failed: ${e}`)
    }
})

// ---- The realm tick: the body re-send, the bar record, Aging, hunger, the realm's
// effect, the torment, healing, golden hearts -----------------------------------------
ServerEvents.tick(event => {
    global.SMS.realmCounter++
    if (global.SMS.realmCounter >= REALM_INTERVAL_TICKS) {
        global.SMS.realmCounter = 0
        global.SMS.realmTick(event.server)
    }
})

// SELF-WROUGHT TORMENT's withering (realmEffects.naraka.torment): `damage` as vanilla's
// own wither damage source -- Entity.damageSources().wither(), dealt through KubeJS's
// attack(DamageSource, float), which is vanilla hurt() (read from the 1.21.1 and KubeJS
// jars) -- but only when it leaves the player at floorHealth or more. A blow that would
// cross the floor is not dealt at all, so the torment can never kill (the user chose
// "hurts, never kills", 2026-10-24). The floor is at least 1 whatever the config says.
// Logged once per player per session, so the in-game test can see it land.
global.SMS.tormentLogged = global.SMS.tormentLogged || {}
global.SMS.tormentStep = (player, t) => {
    var health = Number(player.getHealth())
    var dmg = Number(t.damage)
    var floor = Math.max(Number(t.floorHealth) || 0, 1)
    if (!isFinite(health) || !isFinite(dmg) || dmg <= 0) return false
    if (health - dmg < floor) return false
    player.attack(player.damageSources().wither(), dmg)
    var id = '' + player.uuid
    if (!global.SMS.tormentLogged[id]) {
        global.SMS.tormentLogged[id] = true
        console.info(`[Samsara] torment: ${player.profile.name} withers, health ${health} -> ${player.getHealth()} (never below ${floor})`)
    }
    return true
}

// Every REALM_INTERVAL_TICKS, for each online player:
//   0. send the body once more, when its re-send falls due (resyncBody; liberated
//      players too -- they are put back in their own body);
// and for each one not liberated:
//   1. record the bar, for the meal correction above (foodPerMeal);
//   2. run Aging (every realm): re-arm a preta's halving, count down, re-give the effect
//      about once a second, and die of old age when it runs out. FIRST of the life's
//      rules, so a player who has just died gets none of the rest;
//   3. add vanilla Hunger's food exhaustion (exhaustion);
//   4. give the realm's effect again, every EFFECT_EVERY_PASSES passes (effect);
//   5. wither, every torment.everyTicks (torment);
//   6. heal, every heal.everyTicks (heal);
//   7. fill the golden hearts, every absorption.everyTicks of the life (absorption).
//
// WHY /effect AND NOT getPotionEffects().add(). Jar-verified 2026-10-18 on KubeJS 6:
// EntityPotionEffectsJS.add's overloads all take a net.minecraft MobEffect OBJECT
// ((Lnet/minecraft/world/effect/MobEffect;IIZZ)V and friends) -- there is NO
// String-id overload, and BuiltinKubeJSPlugin registered NO MobEffect type wrapper,
// so Rhino had nothing to coerce 'minecraft:hunger' with. That is project trap 8
// (overloads must match exactly) and it fails silently. runCommandSilent takes a
// plain String on KubeJS 6 and 7 alike, and /effect's syntax is unchanged in 1.21.1,
// so the command stays the seam -- run through global.SMS.serverCommand, because
// /effect is op-level and a player's OWN runCommandSilent is not (J39).
//
// NOTE the /effect command takes SECONDS, while the config carries TICKS (every other
// duration in this pack is in ticks, and mixing the two units is how this goes wrong
// silently). The conversion happens where the command is built, once.
global.SMS.realmTick = server => {
    global.SMS.realmPasses++
    const passes = global.SMS.realmPasses
    var players = null
    try {
        players = server.players
    } catch (ignored) {
        return
    }
    if (!players) return

    var size = 0
    try {
        size = players.size()
    } catch (ignored) {
        return
    }
    if (size === 0) return

    for (var i = 0; i < size; i++) {
        var player = null
        try {
            player = players.get(i)
        } catch (ignored) {
            continue
        }
        if (!player) continue

        // 0. The body's re-send, when due.
        try {
            var due = global.SMS.bodySync['' + player.uuid]
            if (due !== undefined && (global.SMS.tickClock || 0) >= due) {
                delete global.SMS.bodySync['' + player.uuid]
                resyncBody(player)
            }
        } catch (e) {
            console.warn(`[Samsara] body re-sync failed for ${player.profile.name}: ${e}`)
        }

        // Liberation turns realm penalties off. These effects are numbers and objects,
        // not boolean flags, so hasEffect() does not cover them and they need the same
        // explicit guard the meal does.
        var freed = false
        try {
            freed = global.SMS.isLiberated(player)
        } catch (ignored) {
            freed = false
        }
        if (freed) continue

        var realm = ''
        var fx = null
        try {
            realm = global.SMS.birthRealmOf(player)
            fx = global.SMS.effectsFor(realm)
        } catch (ignored) {
            continue
        }
        if (!fx) continue

        // 1. The bar, as last seen.
        if (fx.foodPerMeal !== undefined) {
            try {
                var bar = Number(player.foodLevel)
                if (isFinite(bar)) global.SMS.pretaLastFood['' + player.uuid] = bar
            } catch (ignored) {
                // unreadable this pass; the meal falls back to backing out the meal
            }
        }

        // 2. Aging, every realm's: count down, re-give the effect, and die of old age when
        //    it runs out -- in which case nothing more is done for this player.
        var agingLeft = 0
        try {
            agingLeft = agingStep(player, fx, REALM_INTERVAL_TICKS)
        } catch (e) {
            console.warn(`[Samsara] aging step failed for ${player.profile.name}: ${e}`)
        }
        if (agingLeft < 0) continue

        // 3. Hunger: vanilla Hunger's food exhaustion, for the ticks since the last pass.
        if (fx.exhaustion) {
            try {
                player.causeFoodExhaustion(Number(fx.exhaustion) * REALM_INTERVAL_TICKS)
            } catch (e) {
                console.warn(`[Samsara] hunger failed for ${player.profile.name}: ${e}`)
            }
        }

        // 4. The realm's effect, given again (it has no end; this undoes milk).
        if (fx.effect && passes % EFFECT_EVERY_PASSES === 0) {
            try {
                giveRealmEffect(player, fx)
            } catch (e) {
                console.warn(`[Samsara] realm effect renewal failed for ${player.profile.name}: ${e}`)
            }
        }

        // 5. The torment.
        if (fx.torment && passes % Math.max(1, Math.round(fx.torment.everyTicks / REALM_INTERVAL_TICKS)) === 0) {
            try {
                global.SMS.tormentStep(player, fx.torment)
            } catch (e) {
                console.warn(`[Samsara] torment failed for ${player.profile.name}: ${e}`)
            }
        }

        // 6. Healing (the deva's Regeneration).
        if (fx.heal && passes % Math.max(1, Math.round(fx.heal.everyTicks / REALM_INTERVAL_TICKS)) === 0) {
            try {
                healStep(player, fx.heal)
            } catch (e) {
                console.warn(`[Samsara] healing failed for ${player.profile.name}: ${e}`)
            }
        }

        // 7. Golden hearts, every absorption.everyTicks of the life lived (the birth gave
        //    the first, in applyRealmEffects).
        if (fx.absorption && agingLeft > 0) {
            try {
                var lived = agingSpan(realm) - agingLeft
                if (lived > 0 && lived % fx.absorption.everyTicks < REALM_INTERVAL_TICKS) fillAbsorption(player, fx.absorption)
            } catch (e) {
                console.warn(`[Samsara] golden hearts failed for ${player.profile.name}: ${e}`)
            }
        }
    }

    // Drop re-sends for players long gone (a login queues a fresh one).
    var ids = Object.keys(global.SMS.bodySync)
    for (var k = 0; k < ids.length; k++) {
        if ((global.SMS.tickClock || 0) - global.SMS.bodySync[ids[k]] > 24000) delete global.SMS.bodySync[ids[k]]
    }
}

// ---- Nothing can harm a ghost, and fire cannot harm a deva -------------------------
// (realmEffects.preta.noDamage, realmEffects.deva.fireImmune)
//
// NeoForge's EntityInvulnerabilityCheckEvent is posted from the end of vanilla
// Entity.isInvulnerableTo (CommonHooks.isEntityInvulnerableTo; read from the NeoForge
// 21.1.264 jar), and Player.hurt / LivingEntity.hurt ask isInvulnerableTo FIRST -- so
// a refused source never reaches LivingIncomingDamageEvent, karma's damage hook. Two
// consequences, both intended: starving costs a preta no health, and hostile hits on a
// preta open no endurance encounter (a ghost cannot earn metta by enduring harm).
//
// The sources in minecraft:bypasses_invulnerability -- out_of_world (the void),
// generic_kill (/kill) and samsara:old_age -- are let through, as vanilla lets them
// through creative mode: a preta still dies of old age.
//
// A DEVA's Fire Resistance (2026-10-25, folded into the radiance) refuses every source in
// minecraft:is_fire -- fire, lava, burning, campfires, magma, fireballs -- at the same
// point vanilla's Fire Resistance does (LivingEntity.hurt returns false for an is_fire
// source while the effect is on).
//
// This is a separate seam from the damage hook on purpose: the hard rule is that
// Samsara never cancels or edits LivingIncomingDamageEvent. Nothing is stored, so
// nothing needs teardown: it follows birthRealm and liberation live. The event fires
// on the client thread too (one event bus on an integrated server), so the client side
// is skipped before anything is read: a client entity has no server (ClientLevel does
// not override Level.getServer(), which returns null).
//
// Two members are avoided on purpose: the event's isInvulnerable() and Level's
// isClientSide() each share their name with a FIELD (boolean isInvulnerable, boolean
// isClientSide), and how KubeJS's Rhino resolves a field/method name clash is unprobed.
// Setting invulnerable on an entity that already is one is harmless.
var ghostGuardWarned = false
global.SMS.ghostGuard = event => {
    const entity = event.getEntity()
    if (!entity || !entity.isPlayer()) return false
    if (!entity.getServer()) return false
    const source = event.getSource()
    if (!source || !DamageTypeTagsClass) return false
    if (hasEffect(entity, 'noDamage') && !source.is(DamageTypeTagsClass.BYPASSES_INVULNERABILITY)) {
        event.setInvulnerable(true)
        return true
    }
    if (hasEffect(entity, 'fireImmune') && source.is(DamageTypeTagsClass.IS_FIRE)) {
        event.setInvulnerable(true)
        return true
    }
    return false
}

// The registration is in a try: a top-level throw here would abort the rest of this
// file. A failure inside the listener warns ONCE -- it fires on every damage check.
try {
    NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.event.entity.EntityInvulnerabilityCheckEvent'), event => {
        try {
            global.SMS.ghostGuard(event)
        } catch (e) {
            if (!ghostGuardWarned) {
                ghostGuardWarned = true
                console.warn(`[Samsara] invulnerability check failed (pretas can be hurt, devas burn): ${e}`)
            }
        }
    })
} catch (e) {
    console.error(`[Samsara] could not register the invulnerability hook -- pretas can be hurt, devas burn: ${e}`)
}

// ---- A deva's Resistance I (realmEffects.deva.resistance) -----------------------------
//
// NeoForge's LivingDamageEvent.Pre is posted from LivingEntity.actuallyHurt AFTER armour
// (getDamageAfterArmorAbsorb) and after vanilla's own Resistance and enchantments
// (getDamageAfterMagicAbsorb), and BEFORE the golden hearts take their share -- read from
// neoforge-21.1.264-client.jar. That is exactly where vanilla's Resistance acts, so taking
// `resistance` off there IS Resistance I (0.2). Skipped, as vanilla's is, for a source in
// minecraft:bypasses_resistance (old age, /kill, the void).
//
// This EDITS damage, and is a different event from karma's damage hook on purpose: that
// one (LivingIncomingDamageEvent, the RAW damage endurance measures) only observes, and
// still does -- the incoming amount endurance reads is untouched by this. Nothing is
// stored; it follows birthRealm and liberation live. Damage is dealt on the server only.
var blessedShieldWarned = false
global.SMS.blessedShield = event => {
    const entity = event.getEntity()
    if (!entity || !entity.isPlayer()) return false
    if (!entity.getServer()) return false
    var liberated = false
    try {
        liberated = global.SMS.isLiberated(entity)
    } catch (ignored) {
        liberated = false
    }
    if (liberated) return false
    const r = Number(global.SMS.effectsFor(global.SMS.birthRealmOf(entity)).resistance)
    if (!(r > 0)) return false
    const source = event.getSource()
    if (source && DamageTypeTagsClass && source.is(DamageTypeTagsClass.BYPASSES_RESISTANCE)) return false
    event.setNewDamage(Number(event.getNewDamage()) * Math.max(0, 1 - r))
    return true
}

try {
    NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.event.entity.living.LivingDamageEvent$Pre'), event => {
        try {
            global.SMS.blessedShield(event)
        } catch (e) {
            if (!blessedShieldWarned) {
                blessedShieldWarned = true
                console.warn(`[Samsara] the deva's resistance failed (devas take full damage): ${e}`)
            }
        }
    })
} catch (e) {
    console.error(`[Samsara] could not register the deva's resistance -- devas take full damage: ${e}`)
}

// ---- Nothing hunts a ghost, or a deva (realmEffects.<realm>.ignoredByMobs) -------------
//
// NeoForge's LivingChangeTargetEvent (read from neoforge-21.1.264): CommonHooks posts it
// from Mob.setTarget (MOB_TARGET) and from the brain behaviour StartAttacking
// (BEHAVIOR_TARGET: piglins, hoglins and the like), and BOTH then apply
// getNewAboutToBeSetTarget() -- Mob into its target field, StartAttacking into the
// ATTACK_TARGET memory, which it erases for null. So setting the new target to NULL makes
// the mob target nothing; cancelling would keep whatever it targeted before. A mob whose
// AI sets its target some other way would still come -- harmlessly, since the ghost guard
// lets no hit through.
//
// This replaces Tombstone's Ghostly Shape for pretas (its tick refills the food bar), and
// since 2026-10-24 it is also why hostile mobs leave a deva be. Like the ghost guard it
// follows birthRealm and liberation live, so nothing needs teardown. (Any mob, not only a
// hostile one: a wolf a deva strikes does not turn on it either.)
var ghostTargetWarned = false
global.SMS.ghostUntargetable = event => {
    const target = event.getNewAboutToBeSetTarget()
    if (!target || !target.isPlayer()) return false
    if (!hasEffect(target, 'ignoredByMobs')) return false
    event.setNewAboutToBeSetTarget(null)
    return true
}

try {
    NativeEvents.onEvent(Java.loadClass('net.neoforged.neoforge.event.entity.living.LivingChangeTargetEvent'), event => {
        try {
            global.SMS.ghostUntargetable(event)
        } catch (e) {
            if (!ghostTargetWarned) {
                ghostTargetWarned = true
                console.warn(`[Samsara] targeting check failed (mobs can hunt pretas and devas): ${e}`)
            }
        }
    })
} catch (e) {
    console.error(`[Samsara] could not register the targeting hook -- mobs can hunt pretas and devas: ${e}`)
}

// SECOND LINE OF DEFENCE FOR CONTAINERS.
//
// BlockEvents.rightClicked is the only cancellable hook for opening a container. Any
// menu that still opens -- a container reached some other way, a modded block whose
// id the suffix list misses -- is shut here.
//
// PlayerEvents.inventoryOpened is not cancellable (NeoForge PlayerContainerEvent.Open,
// both jars). But closeMenu IS reachable: PlayerMixin remaps closeContainer ->
// closeMenu on KubeJS 6 and 7. The player may see a single frame of the GUI, which is
// acceptable for a restriction that must hold.

// The player's own inventory menu. Loaded once; null if it cannot be loaded, in which
// case the guard below fails OPEN rather than risk locking a player out.
var InventoryMenuClass = null
try {
    InventoryMenuClass = Java.loadClass('net.minecraft.world.inventory.InventoryMenu')
} catch (e) {
    console.warn(`[Samsara] could not load InventoryMenu; the container backstop is off: ${e}`)
}

PlayerEvents.inventoryOpened(event => {
    const player = event.entity
    if (!player) return
    if (!hasEffect(player, 'noContainers')) return

    // The player's OWN inventory must stay usable -- an animal or a ghost still carries
    // what it picked up.
    // (The server never sends an "open" for it, so this is belt and braces.) Tested
    // with instanceof against the vanilla class: the 1.20.1 test read the class NAME
    // through getClass(), which KubeJS's class filter may not allow.
    var menu = null
    try {
        menu = event.inventoryContainer
        if (!menu || !InventoryMenuClass || menu instanceof InventoryMenuClass) return
    } catch (ignored) {
        // cannot identify the menu -- do nothing rather than risk locking a player
        // out of their own inventory.
        return
    }

    try {
        player.closeMenu()
        refuse(player, beingOf(player) + ' cannot work that.')
    } catch (e) {
        // closeMenu unavailable: the rightClicked cancel is the only protection.
    }
})

console.info('[Samsara] realm effects registered')
